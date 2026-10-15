import { supabase } from '../../db/supabase'
import { getIo } from '../../realtime/context';

export async function fulfillPurchase(reference: string, paidKobo: number) {
  const { data: p } = await supabase.from('star_purchases').select('*').eq('reference', reference).maybeSingle();
  if (!p) return false;
  if (paidKobo !== p.amount_kobo) { console.error('paystack amount mismatch', reference); return false; }
  // idempotent by reference: safe even if both the webhook and the verify call arrive
  await supabase.rpc('apply_stars', { p_user: p.user_id, p_delta: p.stars, p_reason: 'purchase', p_ref: reference }).throwOnError();
  if (p.status !== 'paid') {
    await supabase.from('star_purchases').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('reference', reference);
  }
  getIo().to(`user:${p.user_id}`).emit('stars:refresh');
  return true;
}