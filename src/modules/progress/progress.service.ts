import { supabase } from '../../db/supabase';
import { BALANCE } from '../../config/balance';
import { lagosDate } from '../../lib/time';
import { getIo } from '../../realtime/context';

async function touchStreak(userId: string) {
  const today = lagosDate();
  const { data: p } = await supabase.from('profiles').select('streak, last_played_on').eq('id', userId).single();
  if (!p || p.last_played_on === today) return;
  const yesterday = lagosDate(new Date(Date.now() - 86_400_000));
  const streak = p.last_played_on === yesterday ? p.streak + 1 : 1;
  await supabase.from('profiles').update({ streak, last_played_on: today }).eq('id', userId);
  // streak bonus: 1 star on day 1, then BALANCE.streakMaxStars from day 2 on. It counts toward the daily star cap.
  await supabase.rpc('apply_stars', { p_user: userId, p_delta: Math.min(streak, BALANCE.streakMaxStars), p_reason: 'streak', p_ref: today });
}

/** Real games this player has started with other people: solo games and cancelled (refunded) games don't count. */
async function realGamesPlayed(userId: string): Promise<number> {
  const [{ data: entries }, { data: refunds }] = await Promise.all([
    supabase.from('star_ledger').select('ref_id').eq('user_id', userId).eq('reason', 'game_entry'),
    supabase.from('star_ledger').select('ref_id').eq('user_id', userId).eq('reason', 'entry_refund'),
  ]);
  const refunded = new Set((refunds ?? []).map((r) => r.ref_id));
  return (entries ?? []).filter((e) => !refunded.has(e.ref_id)).length;
}

// Reward both people once the referred player has finished their first few real games
async function rewardReferral(userId: string) {
  // a cheap check first: is this player even a referred player who hasn't been rewarded yet?
  const { data: pending } = await supabase.from('referrals').select('referrer_id').eq('referred_id', userId).is('rewarded_at', null).maybeSingle();
  if (!pending) return;
  if ((await realGamesPlayed(userId)) < BALANCE.referralMinGames) return;
  const { data } = await supabase
    .from('referrals').update({ rewarded_at: new Date().toISOString() })
    .eq('referred_id', userId).is('rewarded_at', null).select('referrer_id').maybeSingle();
  if (!data) return;
  for (const id of [data.referrer_id, userId]) {
    await supabase.rpc('apply_stars', {
      p_user: id, p_delta: BALANCE.referralStars, p_reason: 'referral', p_ref: userId,
    });
    getIo().to(`user:${id}`).emit('stars:refresh');
  }
}

export async function afterEncounter(userId: string, opts: { solo?: boolean } = {}) {
  await touchStreak(userId).catch(console.error);
  // a solo game doesn't count toward referrals, so fake accounts can't farm stars
  if (!opts.solo) await rewardReferral(userId).catch(console.error);
  getIo().to(`user:${userId}`).emit('stars:refresh');
}
