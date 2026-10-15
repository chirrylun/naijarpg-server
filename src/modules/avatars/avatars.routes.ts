import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase'
import { AppError } from '../../lib/errors';
import { requireUser } from '../../middleware/auth';

async function ownedIds(userId: string) {
  const [{ data: defaults }, { data: bought }] = await Promise.all([
    supabase.from('avatar_items').select('id').eq('is_default', true),
    supabase.from('user_items').select('item_id').eq('user_id', userId),
  ]);
  return new Set([...(defaults ?? []).map((d) => d.id), ...(bought ?? []).map((b) => b.item_id)]);
}
const body = z.object({ itemId: z.string() });

export async function avatarRoutes(app: FastifyInstance) {
  app.get('/items', async () => {
    const { data } = await supabase.from('avatar_items').select('*').eq('active', true).order('price_stars');
    return data;
  });

  app.get('/mine', { onRequest: requireUser }, async (req) => {
    const [owned, { data: p }] = await Promise.all([
      ownedIds(req.userId), supabase.from('profiles').select('avatar').eq('id', req.userId).single(),
    ]);
    return { owned: [...owned], equipped: p?.avatar ?? {} };
  });

  app.post('/buy', { onRequest: requireUser }, async (req) => {
    const { itemId } = body.parse(req.body);
    const { data: item } = await supabase.from('avatar_items').select('*').eq('id', itemId).eq('active', true).maybeSingle();
    if (!item) throw new AppError(404, 'item_not_found');
    if ((await ownedIds(req.userId)).has(itemId)) throw new AppError(409, 'already_owned');
    const { error } = await supabase.rpc('apply_stars', {
      p_user: req.userId, p_delta: -item.price_stars, p_reason: 'avatar_item', p_ref: itemId,
    });
    if (error?.message.includes('insufficient_stars')) throw new AppError(402, 'not_enough_stars');
    if (error) throw error;
    await supabase.from('user_items').upsert({ user_id: req.userId, item_id: itemId });
    return { bought: itemId };
  });

  app.post('/equip', { onRequest: requireUser }, async (req) => {
    const { itemId } = body.parse(req.body);
    const { data: item } = await supabase.from('avatar_items').select('slot').eq('id', itemId).eq('active', true).maybeSingle();
    if (!item || !(await ownedIds(req.userId)).has(itemId)) throw new AppError(403, 'not_owned');
    const { data: p } = await supabase.from('profiles').select('avatar').eq('id', req.userId).single();
    const avatar = { ...(p?.avatar as object), [item.slot]: itemId };
    await supabase.from('profiles').update({ avatar }).eq('id', req.userId);
    return { avatar };
  });
}