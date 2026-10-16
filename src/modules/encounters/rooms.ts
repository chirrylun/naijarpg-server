import { supabase } from '../../db/supabase'
import { getIo } from '../../realtime/context';
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { makeCode } from '../../lib/codes';
import { weekKey } from '../../lib/time';
import { resolveRoll } from '../../game-engine/resolver';
import { resolveRound, POINTS } from '../../game-engine/round';
import type { Approach, Format, Mode, StarPlay, Tier } from '../../game-engine/types';
import { pickScenario, dailyScenario, type Scenario } from '../../content';
import { afterEncounter } from '../progress/progress.service';

type Player = {
  userId: string; username: string; avatar: unknown; team: number;
  stats: Record<Approach, number>; stars: number;
  action?: { approach: Approach; star?: StarPlay };
};
type RollRow = {
  userId: string; team: number; round: number; sceneKey: string; approach: Approach;
  starPlay: StarPlay | null; die: number; modifier: number; starBonus: number; total: number; tier: Tier;
};
export type Room = {
  id: string; code: string | null; mode: Mode; format: Format; capacity: number;
  scenario: Scenario; status: 'waiting' | 'active' | 'finished';
  hostId: string; isDaily: boolean; players: Player[];
  sceneKey: string; round: number; teamWins: Record<number, number>; coopPoints: number;
  rolls: RollRow[]; deadline: number | null; timer: NodeJS.Timeout | null;
  resolving: boolean; rematch: Set<string>;
};

// Active games live in memory (fast). Results are saved to Supabase when a game ends.
// Trade-off: a server restart ends games in progress. Fine for 2-minute MVP games.
export const rooms = new Map<string, Room>();
export const roomByCode = new Map<string, string>();
export const roomOfUser = new Map<string, string>();

export async function createRoom(o: { hostId: string; mode: Mode; format: Format; daily?: boolean; invite?: boolean }) {
  const scenario = o.daily ? dailyScenario() : pickScenario(o.mode);
  if (!scenario.modes.includes(o.mode)) throw new AppError(400, 'mode_not_supported');
  const code = o.invite ? makeCode() : null;
  const { data, error } = await supabase.from('encounters').insert({
    mode: o.mode, format: o.format, scenario_id: scenario.id, invite_code: code,
    is_daily: !!o.daily, created_by: o.hostId,
  }).select('id').single();
  if (error) throw error;
  const room: Room = {
    id: data.id, code, mode: o.mode, format: o.format, capacity: o.format === '1v1' ? 2 : 4,
    scenario, status: 'waiting', hostId: o.hostId, isDaily: !!o.daily, players: [],
    sceneKey: scenario.start, round: 1, teamWins: {}, coopPoints: 0, rolls: [],
    deadline: null, timer: null, resolving: false, rematch: new Set(),
  };
  rooms.set(room.id, room);
  if (code) roomByCode.set(code, room.id);
  return room;
}

export function publicState(room: Room) {
  const scene = room.status === 'active' ? room.scenario.scenes[room.sceneKey] : null;
  return {
    id: room.id, code: room.code, mode: room.mode, format: room.format, status: room.status,
    capacity: room.capacity, round: room.round, maxRounds: BALANCE.maxRounds, deadline: room.deadline,
    scenario: { id: room.scenario.id, title: room.scenario.title, tagline: room.scenario.tagline },
    scene: scene && {
      key: room.sceneKey, title: scene.title, text: scene.text,
      choices: scene.choices.map((c) => ({ approach: c.approach, label: c.label })), // DC stays hidden
    },
    players: room.players.map((p) => ({
      userId: p.userId, username: p.username, avatar: p.avatar, team: p.team, acted: !!p.action,
    })),
  };
}
export const emitState = (room: Room) => getIo().to(`room:${room.id}`).emit('room:state', publicState(room));

export async function joinRoom(room: Room, userId: string) {
  const io = getIo();
  if (!room.players.some((p) => p.userId === userId)) {
    if (room.status !== 'waiting' || room.players.length >= room.capacity) throw new AppError(409, 'room_full');
    if (roomOfUser.has(userId)) throw new AppError(409, 'already_in_encounter');
    const { data: prof, error } = await supabase
      .from('profiles').select('username, avatar, stats, stars').eq('id', userId).single();
    if (error) throw error;
    // re-check: another join may have landed while we were waiting on the database
    if (room.players.length >= room.capacity) throw new AppError(409, 'room_full');
    const perTeam = room.capacity / 2;
    // fill team 0 first, so a friend who joins your invite is on YOUR team in 2v2
    const team = room.mode === 'coop' ? 0 : room.players.filter((p) => p.team === 0).length < perTeam ? 0 : 1;
    room.players.push({ userId, username: prof.username, avatar: prof.avatar, team, stats: prof.stats, stars: prof.stars });
    roomOfUser.set(userId, room.id);
    await supabase.from('encounter_players').insert({ encounter_id: room.id, user_id: userId, team });
  }
  io.in(`user:${userId}`).socketsJoin(`room:${room.id}`);
  if (room.players.length === room.capacity && room.status === 'waiting') startRoom(room);
  else emitState(room);
}

function startRoom(room: Room) {
  room.status = 'active';
  supabase.from('encounters').update({ status: 'active' }).eq('id', room.id).then(() => {});
  beginRound(room);
}

function beginRound(room: Room) {
  room.players.forEach((p) => { p.action = undefined; });
  room.resolving = false;
  room.deadline = Date.now() + BALANCE.roundSeconds * 1000;
  room.timer = setTimeout(() => void settle(room), BALANCE.roundSeconds * 1000);
  emitState(room);
}

export function submitAction(userId: string, approach: Approach, star?: StarPlay) {
  const room = rooms.get(roomOfUser.get(userId) ?? '');
  if (!room || room.status !== 'active' || room.resolving) throw new AppError(409, 'not_accepting_actions');
  const p = room.players.find((x) => x.userId === userId)!;
  if (p.action) throw new AppError(409, 'already_chose');
  if (!room.scenario.scenes[room.sceneKey].choices.some((c) => c.approach === approach)) throw new AppError(400, 'invalid_approach');
  if (star && BALANCE.starCost[star] > p.stars) throw new AppError(402, 'not_enough_stars');
  p.action = { approach, star };
  if (room.players.every((x) => x.action)) void settle(room);
  else emitState(room);
}

async function settle(room: Room) {
  if (room.resolving || room.status !== 'active') return;
  room.resolving = true;
  if (room.timer) clearTimeout(room.timer);
  const io = getIo();
  const scene = room.scenario.scenes[room.sceneKey];
  const rows: RollRow[] = [];

  for (const p of room.players) {
    // AFK players get a random approach, no star
    const action = p.action ?? { approach: scene.choices[Math.floor(Math.random() * scene.choices.length)].approach };
    let star = action.star;
    if (star) {
      try {
        const { data } = await supabase.rpc('apply_stars', {
          p_user: p.userId, p_delta: -BALANCE.starCost[star], p_reason: 'star_play', p_ref: `${room.id}:${room.round}`,
        }).throwOnError();
        p.stars = Number(data);
        io.to(`user:${p.userId}`).emit('stars:update', { stars: p.stars });
      } catch { star = undefined; } // balance changed meanwhile: play without the star
    }
    const choice = scene.choices.find((c) => c.approach === action.approach)!;
    const roll = resolveRoll({ modifier: p.stats[action.approach] ?? 0, dc: choice.dc, star });
    rows.push({
      userId: p.userId, team: p.team, round: room.round, sceneKey: room.sceneKey,
      approach: action.approach, starPlay: star ?? null, ...roll,
    });
  }

  room.rolls.push(...rows);
  const outcome = resolveRound(room.mode, rows);
  if (room.mode === 'coop') room.coopPoints += POINTS[outcome.tier];
  else if (outcome.winnerTeam !== null) room.teamWins[outcome.winnerTeam] = (room.teamWins[outcome.winnerTeam] ?? 0) + 1;

  const next = scene.next[outcome.tier];
  const ends = !next || room.round >= BALANCE.maxRounds;
  io.to(`room:${room.id}`).emit('round:result', {
    round: room.round, rolls: rows, tier: outcome.tier, winnerTeam: outcome.winnerTeam, ends,
  });

  room.timer = setTimeout(() => {
    if (ends) return void finish(room);
    room.sceneKey = next!;
    room.round += 1;
    beginRound(room);
  }, BALANCE.resultDelayMs);
}

async function finish(room: Room) {
  room.status = 'finished';
  const rounds = room.round;
  let winnerTeam: number | null = null;
  let success = false;
  if (room.mode === 'coop') success = room.coopPoints >= rounds * BALANCE.coopPassAvg;
  else {
    const w0 = room.teamWins[0] ?? 0, w1 = room.teamWins[1] ?? 0;
    winnerTeam = w0 === w1 ? null : w0 > w1 ? 0 : 1;
  }

  const results = room.players.map((p) => {
    let result: 'win' | 'loss' | 'draw' | 'success' | 'fail', points: number;
    if (room.mode === 'coop') {
      result = success ? 'success' : 'fail';
      points = success ? BALANCE.points.coopSuccess : BALANCE.points.coopFail;
    } else if (winnerTeam === null) { result = 'draw'; points = BALANCE.points.draw; }
    else if (winnerTeam === p.team) { result = 'win'; points = BALANCE.points.win; }
    else { result = 'loss'; points = BALANCE.points.loss; }
    return { userId: p.userId, username: p.username, team: p.team, result, points };
  });

  getIo().to(`room:${room.id}`).emit('encounter:finished', { roomId: room.id, mode: room.mode, results });
  room.players.forEach((p) => roomOfUser.delete(p.userId)); // free to queue again immediately

  try {
    await supabase.from('encounter_rolls').insert(room.rolls.map((r) => ({
      encounter_id: room.id, round_no: r.round, user_id: r.userId, scene_key: r.sceneKey, approach: r.approach,
      die: r.die, modifier: r.modifier, star_play: r.starPlay, star_bonus: r.starBonus, total: r.total, tier: r.tier,
    })));
    await supabase.from('encounters').update({
      status: 'finished', finished_at: new Date().toISOString(), outcome: { winnerTeam, success, rounds },
    }).eq('id', room.id);
    await Promise.all(results.map(async (r) => {
      await supabase.from('encounter_players').update({ result: r.result, score_delta: r.points })
        .match({ encounter_id: room.id, user_id: r.userId });
      await supabase.rpc('record_result', {
        p_user: r.userId, p_season: weekKey(), p_points: r.points, p_won: r.result === 'win' || r.result === 'success',
      });
      await afterEncounter(r.userId);
    }));
  } catch (e) { console.error('finish persist failed', e); }

  setTimeout(() => { rooms.delete(room.id); if (room.code) roomByCode.delete(room.code); }, 120_000);
}

export async function requestRematch(userId: string, roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'finished' || !room.players.some((p) => p.userId === userId)) throw new AppError(404, 'no_rematch');
  const io = getIo();
  room.rematch.add(userId);
  io.to(`room:${room.id}`).emit('rematch:status', { ready: [...room.rematch] });
  if (room.rematch.size < room.capacity) return;
  const next = await createRoom({ hostId: room.hostId, mode: room.mode, format: room.format });
  io.to(`room:${room.id}`).emit('rematch:start', { roomId: next.id });
  for (const p of room.players) {
    io.in(`user:${p.userId}`).socketsLeave(`room:${room.id}`);
    await joinRoom(next, p.userId);
  }
}

export async function leaveRoom(userId: string) {
  const room = rooms.get(roomOfUser.get(userId) ?? '');
  if (!room || room.status !== 'waiting') return; // live games finish on their own (AFK rounds auto-play)

  room.players = room.players.filter((p) => p.userId !== userId);
  roomOfUser.delete(userId);
  getIo().in(`user:${userId}`).socketsLeave(`room:${room.id}`);
  await supabase.from('encounter_players').delete().match({ encounter_id: room.id, user_id: userId });

  if (room.players.length === 0) {
    rooms.delete(room.id);
    if (room.code) roomByCode.delete(room.code);
    await supabase.from('encounters').update({ status: 'abandoned' }).eq('id', room.id);
  } else {
    if (room.hostId === userId) room.hostId = room.players[0].userId;
    emitState(room);
  }
}