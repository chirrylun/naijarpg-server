import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase'
import { AppError } from '../../lib/errors';
import { requireUser } from '../../middleware/auth';

const one = <T>(v: T | T[] | null) => (Array.isArray(v) ? v[0] : v);

export async function userRoutes(app: FastifyInstance) {
  app.get('/me', { onRequest: requireUser }, async (req) => {
    const { data, error } = await supabase.from('profiles')
      .select('id, username, avatar, title, is_guest, stars, streak, last_played_on, referral_code, stats, player_stats ( score, wins, losses, encounters_played )')
      .eq('id', req.userId).single();
    if (error) throw error;
    const { player_stats, ...profile } = data as any;
    return { ...profile, record: one(player_stats) };
  });

  app.patch('/me', { onRequest: requireUser }, async (req) => {
    const { username } = z.object({ username: z.string().regex(/^[a-zA-Z0-9_]{3,16}$/) }).parse(req.body);
    const { error } = await supabase.from('profiles').update({ username }).eq('id', req.userId);
    if (error?.code === '23505') throw new AppError(409, 'username_taken');
    if (error) throw error;
    return { username };
  });

  // Call after a guest links an email/Google login on the web
  app.post('/me/sync', { onRequest: requireUser }, async (req) => {
    await supabase.from('profiles').update({ is_guest: req.isAnonymous }).eq('id', req.userId);
    return { isGuest: req.isAnonymous };
  });

  // Public profile
  app.get('/players/:username', async (req) => {
    const { username } = req.params as { username: string };
    const { data } = await supabase.from('profiles')
      .select('username, avatar, title, streak, player_stats ( score, wins, losses, encounters_played )')
      .eq('username', username).maybeSingle();
    if (!data) throw new AppError(404, 'player_not_found');
    const { player_stats, ...profile } = data as any;
    return { ...profile, record: one(player_stats) };
  });
}