import { supabase } from '../../db/supabase';
import { BALANCE } from '../../config/balance';
import { getIo } from '../../realtime/context';

export async function fulfillPurchase(reference: string, paidKobo: number) {
  const { data: p } = await supabase.from('star_purchases').select('*').eq('reference', reference).maybeSingle();
  if (!p) return false;
  if (paidKobo !== p.amount_kobo) { console.error('bachs amount mismatch', reference, paidKobo, p.amount_kobo); return false; }
  // is this the player's very first paid pack? (looked at before this one is marked paid)
  const { count: paidBefore } = await supabase
    .from('star_purchases').select('reference', { count: 'exact', head: true })
    .eq('user_id', p.user_id).eq('status', 'paid').neq('reference', reference);
  // idempotent by reference: safe even if the same webhook is delivered twice
  await supabase.rpc('apply_stars', { p_user: p.user_id, p_delta: p.stars, p_reason: 'purchase', p_ref: reference }).throwOnError();
  // the first-pack bonus is keyed on the user, so it can only ever be paid once
  if (!paidBefore) {
    await supabase.rpc('apply_stars', { p_user: p.user_id, p_delta: BALANCE.firstPurchaseBonus, p_reason: 'first_purchase', p_ref: p.user_id }).throwOnError();
  }
  if (p.status !== 'paid') {
    await supabase.from('star_purchases').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('reference', reference);
  }
  getIo().to(`user:${p.user_id}`).emit('stars:refresh');
  return true;
}
