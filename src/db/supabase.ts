import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Service role key = full access. Server only. Never expose to the web repo.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});