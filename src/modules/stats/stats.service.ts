import { supabase } from '../../db/supabase';
import { liveCount } from '../../realtime/presence';
import { rooms } from '../encounters/rooms';
import { queueSizes } from '../encounters/matchmaking';

export type TopPlayer = {
  rank: number;
  username: string;
  avatar: unknown;
  score: number;
  wins: number;
};

type Row = {
  score: number;
  wins: number;
  profiles:
    | { username: string; avatar: unknown }
    | { username: string; avatar: unknown }[]
    | null;
};

export async function getTotalVisits(): Promise<number> {
  const { data, error } = await supabase
    .from('site_counters')
    .select('value')
    .eq('key', 'total_visits')
    .single();
  if (error) throw error;
  return Number(data.value);
}

export async function recordVisit(): Promise<number> {
  const { data, error } = await supabase.rpc('increment_visits');
  if (error) throw error;
  return Number(data);
}

async function fetchTopPlayers(limit: number): Promise<TopPlayer[]> {
  const { data, error } = await supabase
    .from('player_stats')
    .select('score, wins, profiles ( username, avatar )')
    .order('score', { ascending: false })
    .order('wins', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data as unknown as Row[]).map((row, i) => {
    const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    return {
      rank: i + 1,
      username: p?.username ?? 'Unknown',
      avatar: p?.avatar ?? {},
      score: row.score,
      wins: row.wins,
    };
  });
}

// Cache the top 3 for 30 seconds so the landing page can't hammer the database
let cache: { at: number; players: TopPlayer[] } | null = null;
export async function getTopPlayers(limit = 3): Promise<TopPlayer[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.players;
  const players = await fetchTopPlayers(limit);
  cache = { at: Date.now(), players };
  return players;
}

export async function getLandingStats() {
  const [totalVisits, topPlayers] = await Promise.all([getTotalVisits(), getTopPlayers(3)]);
  return { liveUsers: liveCount(), totalVisits, topPlayers };
}

// ---------- admin /stats page ----------

/** What is happening on the server right now (memory only, nothing is stored) */
function liveNow() {
  const byMode: Record<string, number> = {};
  let active = 0;
  let waiting = 0;
  let inRooms = 0;
  for (const r of rooms.values()) {
    inRooms += r.players.length;
    if (r.status === 'active') {
      active += 1;
      byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
    } else if (r.status === 'waiting') waiting += 1;
  }
  return { online: liveCount(), playersInGames: inRooms, activeGames: active, waitingRooms: waiting, activeByMode: byMode, queues: queueSizes() };
}

// The numbers take a moment to work out, so keep each range for 20 seconds
const adminCache = new Map<number, { at: number; data: unknown }>();

export async function getAdminStats(days: number) {
  const hit = adminCache.get(days);
  let data = hit && Date.now() - hit.at < 20_000 ? hit.data : null;
  if (!data) {
    const { data: fresh, error } = await supabase.rpc('admin_stats', { p_days: days });
    if (error) throw error;
    data = fresh;
    adminCache.set(days, { at: Date.now(), data });
  }
  return { ...(data as object), live: liveNow() };
}
