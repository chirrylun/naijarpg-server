import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:3000'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  PAYSTACK_SECRET_KEY: z.string().default(''),
  // comma-separated user ids allowed to open /stats (see the 403 response on /api/stats/admin for yours)
  ADMIN_USER_IDS: z.string().default(''),
  BACHS_API_KEY: z.string().min(1),
BACHS_WEBHOOK_SECRET: z.string().min(1),
});

export const env = schema.parse(process.env);

// Clean each origin: trim spaces, strip quotes and trailing slashes
export const ORIGINS = env.CLIENT_ORIGIN.split(',')
  .map((o) => o.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''))
  .filter(Boolean);

export const WEB_URL = ORIGINS[0];