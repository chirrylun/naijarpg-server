import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase'
import { WEB_URL } from '../../config/env';
import { AppError } from '../../lib/errors';
import { requireUser } from '../../middleware/auth';

export async function referralRoutes(app: FastifyInstance) {
  app.get('/', { onRequest: requireUser }, async (req) => {
    const [{ data: p }, { data: refs }] = await Promise.all([
      supabase.from('profiles').select('referral_code').eq('id', req.userId).single(),
      supabase.from('referrals').select('rewarded_at').eq('referrer_id', req.userId),
    ]);
    return {
      code: p?.referral_code, link: `${WEB_URL}/?ref=${p?.referral_code}`,
      invited: refs?.length ?? 0, rewarded: refs?.filter((r) => r.rewarded_at).length ?? 0,
    };
  });

  // Web calls this once a visitor who arrived with ?ref=CODE has a session
  app.post('/claim', { onRequest: requireUser }, async (req) => {
    const { code } = z.object({ code: z.string().min(4).max(16) }).parse(req.body);
    const { data: ref } = await supabase.from('profiles').select('id').eq('referral_code', code.toUpperCase()).maybeSingle();
    if (!ref) throw new AppError(404, 'invalid_code');
    if (ref.id === req.userId) throw new AppError(400, 'cannot_refer_self');
    const { data: st } = await supabase.from('player_stats').select('encounters_played').eq('user_id', req.userId).single();
    if ((st?.encounters_played ?? 0) > 0) throw new AppError(409, 'too_late'); // only brand-new players
    const { error } = await supabase.from('referrals').insert({ referrer_id: ref.id, referred_id: req.userId });
    if (error?.code === '23505') throw new AppError(409, 'already_referred');
    if (error) throw error;
    return { ok: true };
  });
}