import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase';
import { env, WEB_URL } from '../../config/env';
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { bachsPost, verifyBachsSignature, BachsError } from '../../lib/bachs';
import { requireUser } from '../../middleware/auth';
import { fulfillPurchase } from './stars.service';

export async function starRoutes(app: FastifyInstance) {
  app.get('/packs', async () => BALANCE.packs);

  app.get('/', { onRequest: requireUser }, async (req) => {
    const [{ data: p }, { data: ledger }] = await Promise.all([
      supabase.from('profiles').select('stars').eq('id', req.userId).single(),
      supabase.from('star_ledger').select('delta, reason, created_at').eq('user_id', req.userId).order('id', { ascending: false }).limit(30),
    ]);
    return { stars: p?.stars ?? 0, ledger };
  });

  app.post('/checkout', { onRequest: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!env.BACHS_API_KEY) throw new AppError(503, 'payments_unavailable');
    // guests sign up first, so purchases belong to a real account
    if (req.isAnonymous || !req.authEmail) throw new AppError(403, 'signup_required');
    const { packId } = z.object({ packId: z.string() }).parse(req.body);
    const pack = BALANCE.packs.find((p) => p.id === packId);
    if (!pack) throw new AppError(400, 'invalid_pack');

    const reference = `nrpg_${randomUUID()}`;
    let session: { checkout_id: string; checkout_url: string };
    try {
      session = await bachsPost('/v1/checkout-sessions', {
        pricing: { currency: 'NGN', amount: pack.priceNaira.toFixed(2) }, // Bachs uses decimal strings, not kobo
        customer: { email: req.authEmail },
        success_url: `${WEB_URL}/shop`, // Bachs appends ?checkout_id=
        cancel_url: `${WEB_URL}/shop`,
        reference,
        metadata: { user_id: req.userId, pack_id: pack.id },
        expires_in_minutes: 60,
      });
    } catch (e) {
      if (e instanceof BachsError) req.log.error({ status: e.status, body: e.body }, 'bachs checkout failed');
      throw new AppError(502, 'payments_unavailable');
    }

    await supabase.from('star_purchases').insert({
      reference, checkout_id: session.checkout_id, user_id: req.userId,
      pack_id: pack.id, stars: pack.stars, amount_kobo: pack.priceNaira * 100,
    }).throwOnError();

    return { url: session.checkout_url };
  });

  // The shop page polls this after the redirect. It only reads: the webhook is what credits stars.
  app.get('/verify/:checkoutId', { onRequest: requireUser }, async (req) => {
    const { checkoutId } = req.params as { checkoutId: string };
    const { data: p } = await supabase
      .from('star_purchases').select('status, user_id').eq('checkout_id', checkoutId).maybeSingle();
    if (!p || p.user_id !== req.userId) throw new AppError(404, 'not_found');
    return { paid: p.status === 'paid' };
  });
}

// Registered separately so it can read the raw body for signature checking
export async function bachsWebhook(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, JSON.parse((body as Buffer).toString())); } catch (e) { done(e as Error, undefined); }
  });

  app.post('/bachs', { config: { rateLimit: false } }, async (req, reply) => {
    const raw = ((req as any).rawBody as Buffer).toString('utf8');
    const sig = req.headers['x-bachs-signature-v2'] as string | undefined;
    if (!verifyBachsSignature(raw, sig, env.BACHS_WEBHOOK_SECRET)) return reply.code(400).send({ error: 'bad_signature' });

    const evt = req.body as { type: string; data?: { checkout_id?: string; amount?: string; currency?: string } };
    if (evt.type !== 'collection.succeeded' || !evt.data?.checkout_id) return { ok: true };

    const { data: p } = await supabase
      .from('star_purchases').select('reference').eq('checkout_id', evt.data.checkout_id).maybeSingle();
    if (!p) return { ok: true }; // not one of ours
    if (evt.data.currency !== 'NGN') { console.error('bachs currency mismatch', p.reference); return { ok: true }; }

    // if this throws, the 500 makes Bachs retry the delivery
    await fulfillPurchase(p.reference, Math.round(Number(evt.data.amount) * 100));
    return { ok: true };
  });
}