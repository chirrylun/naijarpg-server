import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:3000'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  PAYSTACK_SECRET_KEY: z.string().default(''),
});

export const env = schema.parse(process.env);
export const WEB_URL = env.CLIENT_ORIGIN.split(',')[0];