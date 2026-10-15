import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase';
import { requireUser } from '../../middleware/auth';
import { weekKey } from '../../lib/time';

const query = z.object({ period: z.enum(['week', 'all']).default('week'), limit: z.coerce.number().int().min(1).max(100).default(50) });
const cache = new Map<string, { at: number; rows: unknown[] }>();

export async function leaderboardRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const { period, limit } = query.parse(req.query);
    const key = `${period}:${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return { period, rows: hit.rows };

    const base = period === 'week'
      ? supabase.from('weekly_scores').select('score, wins, profiles ( username, avatar )').eq('season', weekKey())
      : supabase.from('player_stats').select('score, wins, profiles ( username, avatar )');
    const { data, error } = await base.order('score', { ascending: false }).order('wins', { ascending: false }).limit(limit);
    if (error) throw error;
    const rows = (data as any[]).map((r, i) => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      return { rank: i + 1, username: p?.username, avatar: p?.avatar ?? {}, score: r.score, wins: r.wins };
    });
    cache.set(key, { at: Date.now(), rows });
    return { period, rows };
  });

  app.get('/me', { onRequest: requireUser }, async (req) => {
    const { period } = query.parse(req.query);
    const table = period === 'week' ? 'weekly_scores' : 'player_stats';
    const scope = (q: any) => (period === 'week' ? q.eq('season', weekKey()) : q);
    const { data: mine } = await scope(supabase.from(table).select('score').eq('user_id', req.userId)).maybeSingle();
    if (!mine) return { period, rank: null, score: 0 };
    const { count } = await scope(supabase.from(table).select('*', { count: 'exact', head: true }).gt('score', mine.score));
    return { period, rank: (count ?? 0) + 1, score: mine.score };
  });
}