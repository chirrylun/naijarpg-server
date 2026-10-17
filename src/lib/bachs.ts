import crypto from 'node:crypto';
import { env } from '../config/env';

// the key prefix picks the environment, so there is nothing else to configure
const BASE = env.BACHS_API_KEY.startsWith('sk_live_') ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';

export class BachsError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`bachs_${status}`);
  }
}

export async function bachsPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BACHS_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new BachsError(res.status, data);
  return data as T;
}

/** Verifies X-Bachs-Signature-V2: "t=<ts>,v1=<sig>[,v1=<sig>]" over "<ts>.<raw body>". */
export function verifyBachsSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const pairs = header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)] as const;
  });
  const t = Number(pairs.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  // during a secret rotation the header carries several v1 values: accept any match
  return pairs
    .filter(([k]) => k === 'v1')
    .some(([, sig]) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}