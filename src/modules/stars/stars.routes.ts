import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase'
import { env, WEB_URL } from '../../config/env';
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { requireUser } from '../../middleware/auth';
import { fulfillPurchase } from './stars.service';

const PAYSTACK = 'https://api.paystack.co';
const psHeaders = () => ({ Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' });

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
    if (!env.PAYSTACK_SECRET_KEY) throw new AppError(503, 'payments_unavailable');
    // Paystack needs an email, so guests must sign up first. Good conversion moment.
    if (req.isAnonymous || !req.authEmail) throw new AppError(403, 'signup_required');
    const { packId } = z.object({ packId: z.string() }).parse(req.body);
    const pack = BALANCE.packs.find((p) => p.id === packId);
    if (!pack) throw new AppError(400, 'invalid_pack');

    const reference = `nrpg_${randomUUID()}`;
    const amount = pack.priceNaira * 100; // kobo
    await supabase.from('star_purchases').insert({
      reference, user_id: req.userId, pack_id: pack.id, stars: pack.stars, amount_kobo: amount,
    }).throwOnError();

    const res = await fetch(`${PAYSTACK}/transaction/initialize`, {
      method: 'POST', headers: psHeaders(),
      body: JSON.stringify({ email: req.authEmail, amount, reference, callback_url: `${WEB_URL}/shop?ref=${reference}` }),
    });
    const json = (await res.json()) as any;
    if (!res.ok || !json.status) throw new AppError(502, 'paystack_error');
    return { url: json.data.authorization_url, reference };
  });

  // The shop page calls this when the user returns from Paystack (webhook may be a few seconds late)
  app.get('/verify/:reference', { onRequest: requireUser }, async (req) => {
    const { reference } = req.params as { reference: string };
    const { data: p } = await supabase.from('star_purchases').select('user_id').eq('reference', reference).maybeSingle();
    if (!p || p.user_id !== req.userId) throw new AppError(404, 'not_found');
    const res = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`, { headers: psHeaders() });
    const json = (await res.json()) as any;
    const paid = json?.data?.status === 'success' && (await fulfillPurchase(reference, json.data.amount));
    return { paid: !!paid };
  });
}

// Registered separately so it can read the raw body for signature checking
export async function paystackWebhook(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, JSON.parse((body as Buffer).toString())); } catch (e) { done(e as Error, undefined); }
  });
  app.post('/paystack', async (req, reply) => {
    const expected = createHmac('sha512', env.PAYSTACK_SECRET_KEY).update((req as any).rawBody).digest('hex');
    if (req.headers['x-paystack-signature'] !== expected) return reply.code(401).send();
    const evt = req.body as any;
    if (evt.event === 'charge.success') await fulfillPurchase(evt.data.reference, evt.data.amount);
    return { ok: true };
  });
}