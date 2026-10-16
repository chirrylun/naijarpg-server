import { supabase } from '../../db/supabase'
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { allow } from '../../lib/rate';
import { cleanMessage } from '../../lib/moderation';
import { getIo } from '../../realtime/context';

const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);
const push = (userId: string, event: string, payload: unknown) => getIo().to(`user:${userId}`).emit(event, payload);

async function isBlocked(a: string, b: string) {
  const { data } = await supabase.from('blocks').select('blocker')
    .or(`and(blocker.eq.${a},blocked.eq.${b}),and(blocker.eq.${b},blocked.eq.${a})`).limit(1);
  return !!data?.length;
}

// Only people who have played an encounter together can request chat. Cuts stranger spam a lot.
async function playedTogether(a: string, b: string) {
  const { data: mine } = await supabase.from('encounter_players').select('encounter_id').eq('user_id', a).limit(200);
  if (!mine?.length) return false;
  const { data } = await supabase.from('encounter_players').select('encounter_id')
    .eq('user_id', b).in('encounter_id', mine.map((m) => m.encounter_id)).limit(1);
  return !!data?.length;
}

async function profilesById(ids: string[]) {
  const { data } = await supabase.from('profiles').select('id, username, avatar').in('id', ids);
  return new Map((data ?? []).map((p) => [p.id, p]));
}

async function idByUsername(username: string) {
  const { data } = await supabase.from('profiles').select('id').eq('username', username).maybeSingle();
  if (!data) throw new AppError(404, 'player_not_found');
  return data.id as string;
}

export async function sendRequest(fromId: string, username: string) {
  const toId = await idByUsername(username);
  if (toId === fromId) throw new AppError(400, 'cannot_request_self');
  if (await isBlocked(fromId, toId)) throw new AppError(403, 'cannot_request');
  if (!(await playedTogether(fromId, toId))) throw new AppError(403, 'play_together_first');

  const [a, b] = pair(fromId, toId);
  const { data: conv } = await supabase.from('conversations').select('id').eq('user_a', a).eq('user_b', b).maybeSingle();
  if (conv) throw new AppError(409, 'already_connected');

  const { data: pending } = await supabase.from('chat_requests').select('id').eq('status', 'pending')
    .or(`and(from_user.eq.${fromId},to_user.eq.${toId}),and(from_user.eq.${toId},to_user.eq.${fromId})`).limit(1);
  if (pending?.length) throw new AppError(409, 'request_pending');

  const cutoff = new Date(Date.now() - BALANCE.chat.declineCooldownHours * 3_600_000).toISOString();
  const { data: declined } = await supabase.from('chat_requests').select('id')
    .eq('from_user', fromId).eq('to_user', toId).eq('status', 'declined').gt('responded_at', cutoff).limit(1);
  if (declined?.length) throw new AppError(429, 'try_later');

  const { data: req, error } = await supabase.from('chat_requests').insert({ from_user: fromId, to_user: toId }).select('id').single();
  if (error) throw error;
  const from = (await profilesById([fromId])).get(fromId);
  push(toId, 'chat:request', { id: req.id, from });
  return { id: req.id };
}

export async function incomingRequests(userId: string) {
  const { data } = await supabase.from('chat_requests').select('id, from_user, created_at')
    .eq('to_user', userId).eq('status', 'pending').order('created_at', { ascending: false });
  const profs = await profilesById((data ?? []).map((r) => r.from_user));
  return (data ?? []).map((r) => ({ id: r.id, createdAt: r.created_at, from: profs.get(r.from_user) }));
}

export async function respond(userId: string, requestId: string, accept: boolean) {
  const { data: r } = await supabase.from('chat_requests').select('*')
    .eq('id', requestId).eq('to_user', userId).eq('status', 'pending').maybeSingle();
  if (!r) throw new AppError(404, 'request_not_found');
  await supabase.from('chat_requests').update({
    status: accept ? 'accepted' : 'declined', responded_at: new Date().toISOString(),
  }).eq('id', requestId);
  if (!accept) return { accepted: false };

  const [a, b] = pair(r.from_user, r.to_user);
  await supabase.from('conversations').upsert({ user_a: a, user_b: b }, { onConflict: 'user_a,user_b', ignoreDuplicates: true });
  const { data: conv } = await supabase.from('conversations').select('id').eq('user_a', a).eq('user_b', b).single();
  push(r.from_user, 'chat:accepted', { conversationId: conv!.id });
  push(r.to_user, 'chat:accepted', { conversationId: conv!.id });
  return { accepted: true, conversationId: conv!.id };
}

export async function listConversations(userId: string) {
  const { data } = await supabase
    .from('conversations')
    .select('id, user_a, user_b, created_at')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`);
  const rows = data ?? [];
  const others = rows.map((c) => (c.user_a === userId ? c.user_b : c.user_a));
  const profs = await profilesById(others);
  const lasts = await Promise.all(
    rows.map(async (c) => {
      const { data: m } = await supabase
        .from('messages')
        .select('id, sender_id, body, created_at')
        .eq('conversation_id', c.id)
        .order('id', { ascending: false })
        .limit(1);
      return m?.[0] ?? null;
    }),
  );
  return rows
    .map((c, i) => ({ id: c.id, with: profs.get(others[i]), last: lasts[i] }))
    .sort((a, b) => (b.last?.id ?? 0) - (a.last?.id ?? 0));
}

async function membership(userId: string, conversationId: string) {
  const { data } = await supabase.from('conversations').select('user_a, user_b').eq('id', conversationId).maybeSingle();
  if (!data || (data.user_a !== userId && data.user_b !== userId)) throw new AppError(404, 'conversation_not_found');
  return data.user_a === userId ? data.user_b : data.user_a;
}

export async function listMessages(userId: string, conversationId: string, before?: number) {
  await membership(userId, conversationId);
  let q = supabase.from('messages').select('id, sender_id, body, created_at').eq('conversation_id', conversationId);
  if (before) q = q.lt('id', before);
  const { data } = await q.order('id', { ascending: false }).limit(50);
  return (data ?? []).reverse();
}

export async function sendMessage(userId: string, conversationId: string, body: string) {
  const text = cleanMessage(body);
  if (!text || text.length > BALANCE.chat.maxLen) throw new AppError(400, 'invalid_message');
  const otherId = await membership(userId, conversationId);
  if (await isBlocked(userId, otherId)) throw new AppError(403, 'blocked');
  if (!allow(`dm:${userId}`, 15, 30_000)) throw new AppError(429, 'slow_down');
  const { data, error } = await supabase.from('messages')
    .insert({ conversation_id: conversationId, sender_id: userId, body: text }).select('id, sender_id, body, created_at').single();
  if (error) throw error;
  const msg = { ...data, conversationId };
  push(userId, 'dm:message', msg);
  push(otherId, 'dm:message', msg);
  return msg;
}

export async function blockUser(userId: string, username: string) {
  const id = await idByUsername(username);
  if (id === userId) throw new AppError(400, 'cannot_block_self');
  await supabase.from('blocks').upsert({ blocker: userId, blocked: id });
  return { blocked: true };
}

export async function reportUser(userId: string, username: string, reason: string, messageId?: number) {
  const id = await idByUsername(username);
  await supabase.from('reports').insert({ reporter: userId, reported: id, reason: reason.slice(0, 300), message_id: messageId ?? null });
  return { reported: true };
}