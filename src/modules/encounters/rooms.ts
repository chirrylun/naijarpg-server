import { supabase } from '../../db/supabase';
import { getIo } from '../../realtime/context';
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { makeCode } from '../../lib/codes';
import { weekKey } from '../../lib/time';
import { resolveRoll } from '../../game-engine/resolver';
import { resolveRound } from '../../game-engine/round';
import { defaultEffects, fillTokens, resultLine, type FX } from '../../game-engine/narrative';
import { pickEdge, pickVariant, type Scenario } from '../../game-engine/scenario';
import type { Approach, Format, Kind, Mode, StarPlay, Tier } from '../../game-engine/types';
import { pickScenario, dailyScenario, supports } from '../../content';
import { afterEncounter } from '../progress/progress.service';

type Carry = { mod: number; label: string };
type Player = {
  userId: string;
  username: string;
  avatar: unknown;
  team: number;
  stats: Record<Approach, number>;
  stars: number;
  action?: { approach: Approach; star?: StarPlay };
  carry: Carry | null;
};
type RollRow = {
  userId: string;
  team: number;
  round: number;
  sceneKey: string;
  approach: Approach;
  starPlay: StarPlay | null;
  die: number;
  dice: number[];
  shielded: boolean;
  modifier: number;
  starBonus: number;
  total: number;
  tier: Tier;
  dc: number;
  margin: number;
};
export type Room = {
  id: string;
  code: string | null;
  mode: Mode;
  format: Format;
  capacity: number;
  scenario: Scenario;
  status: 'waiting' | 'active' | 'finished';
  hostId: string;
  isDaily: boolean;
  players: Player[];
  sceneKey: string;
  round: number;
  teamWins: Record<number, number>;
  coopPoints: number;
  recap: string | null;
  rolls: RollRow[];
  deadline: number | null;
  timer: NodeJS.Timeout | null;
  resolving: boolean;
  rematch: Set<string>;
};

const COOP_POINTS: Partial<Record<Kind, number>> = { all_pass: 3, mixed: 2, all_fail: 0 };

// Active games live in memory (fast). Results are saved to Supabase when a game ends.
export const rooms = new Map<string, Room>();
export const roomByCode = new Map<string, string>();
export const roomOfUser = new Map<string, string>();

export async function createRoom(o: { hostId: string; mode: Mode; format: Format; daily?: boolean; invite?: boolean }) {
  let scenario = o.daily ? dailyScenario() : pickScenario(o.mode, o.format);
  if (!supports(scenario, o.mode, o.format)) scenario = pickScenario(o.mode, o.format);
  const code = o.invite ? makeCode() : null;
  const { data, error } = await supabase
    .from('encounters')
    .insert({
      mode: o.mode,
      format: o.format,
      scenario_id: scenario.id,
      invite_code: code,
      is_daily: !!o.daily,
      created_by: o.hostId,
    })
    .select('id')
    .single();
  if (error) throw error;
  const room: Room = {
    id: data.id,
    code,
    mode: o.mode,
    format: o.format,
    capacity: o.format === '1v1' ? 2 : 4,
    scenario,
    status: 'waiting',
    hostId: o.hostId,
    isDaily: !!o.daily,
    players: [],
    sceneKey: scenario.start,
    round: 1,
    teamWins: {},
    coopPoints: 0,
    recap: null,
    rolls: [],
    deadline: null,
    timer: null,
    resolving: false,
    rematch: new Set(),
  };
  rooms.set(room.id, room);
  if (code) roomByCode.set(code, room.id);
  return room;
}

export function publicState(room: Room) {
  const scene = room.status === 'active' ? room.scenario.scenes[room.sceneKey] : null;
  const m = room.mode;
  const f = room.format;
  return {
    id: room.id,
    code: room.code,
    mode: room.mode,
    format: room.format,
    status: room.status,
    capacity: room.capacity,
    round: room.round,
    maxRounds: BALANCE.maxRounds,
    roundSeconds: BALANCE.roundSeconds,
    // time left rather than a clock time, so a phone with a wrong clock still counts down correctly
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    recap: room.status === 'active' ? room.recap : null,
    scenario: { id: room.scenario.id, title: room.scenario.title, tagline: room.scenario.tagline },
    scene:
      scene && {
        key: room.sceneKey,
        title: pickVariant(scene.title, m, f),
        text: pickVariant(scene.text, m, f),
        stakes: scene.stakes ? pickVariant(scene.stakes, m, f) : null,
        choices: scene.choices.map((c) => ({ approach: c.approach, label: pickVariant(c.label, m, f) })), // DC stays hidden
      },
    players: room.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      avatar: p.avatar,
      team: p.team,
      acted: !!p.action,
      status: p.carry,
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
      .from('profiles')
      .select('username, avatar, stats, stars')
      .eq('id', userId)
      .single();
    if (error) throw error;
    if (room.players.length >= room.capacity) throw new AppError(409, 'room_full');
    const perTeam = room.capacity / 2;
    // fill team 0 first, so a friend who joins your invite is on YOUR team in 2v2
    const team = room.mode === 'coop' ? 0 : room.players.filter((p) => p.team === 0).length < perTeam ? 0 : 1;
    room.players.push({
      userId,
      username: prof.username,
      avatar: prof.avatar,
      team,
      stats: prof.stats,
      stars: prof.stars,
      carry: null,
    });
    roomOfUser.set(userId, room.id);
    await supabase.from('encounter_players').insert({ encounter_id: room.id, user_id: userId, team });
  }
  io.in(`user:${userId}`).socketsJoin(`room:${room.id}`);
  if (room.players.length === room.capacity && room.status === 'waiting') startRoom(room);
  else emitState(room);
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

function startRoom(room: Room) {
  room.status = 'active';
  supabase.from('encounters').update({ status: 'active' }).eq('id', room.id).then(() => {});
  beginRound(room);
}

function beginRound(room: Room) {
  room.players.forEach((p) => {
    p.action = undefined;
  });
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
  room.deadline = null;
  if (room.timer) clearTimeout(room.timer);
  const io = getIo();
  const scene = room.scenario.scenes[room.sceneKey];
  const rows: RollRow[] = [];

  for (const p of room.players) {
    // AFK players get a random approach, no star
    const action: { approach: Approach; star?: StarPlay } =
      p.action ?? { approach: scene.choices[Math.floor(Math.random() * scene.choices.length)].approach };
    let star = action.star;
    if (star) {
      try {
        const { data } = await supabase
          .rpc('apply_stars', {
            p_user: p.userId,
            p_delta: -BALANCE.starCost[star],
            p_reason: 'star_play',
            p_ref: `${room.id}:${room.round}`,
          })
          .throwOnError();
        p.stars = Number(data);
        io.to(`user:${p.userId}`).emit('stars:update', { stars: p.stars });
      } catch {
        star = undefined; // balance changed meanwhile: play without the star
      }
    }
    const choice = scene.choices.find((c) => c.approach === action.approach)!;
    const base = Math.min(p.stats[action.approach] ?? 0, BALANCE.maxModifier);
    // last round's consequence (Momentum, Rattled...) applies to this roll only
    const roll = resolveRoll({ modifier: base + (p.carry?.mod ?? 0), dc: choice.dc, star });
    rows.push({
      userId: p.userId,
      team: p.team,
      round: room.round,
      sceneKey: room.sceneKey,
      approach: action.approach,
      starPlay: star ?? null,
      dc: choice.dc,
      ...roll,
    });
  }
  room.players.forEach((p) => {
    p.carry = null;
  });

  room.rolls.push(...rows);
  const outcome = resolveRound(
    room.mode,
    rows.map((r) => ({ userId: r.userId, team: r.team, approach: r.approach, tier: r.tier, margin: r.margin })),
  );
  const edge = pickEdge(scene, outcome.kind, outcome.same);

  const namesOf = (ids: string[]) => ids.map((id) => room.players.find((p) => p.userId === id)?.username ?? 'Player');
  const winnerNames = outcome.winnerTeam === null ? [] : room.players.filter((p) => p.team === outcome.winnerTeam).map((p) => p.username);
  const loserNames = outcome.winnerTeam === null ? [] : room.players.filter((p) => p.team !== outcome.winnerTeam).map((p) => p.username);

  const headline = resultLine({
    mode: room.mode,
    kind: outcome.kind,
    same: outcome.same,
    approach: outcome.sameApproach,
    winner: winnerNames,
    loser: loserNames,
    passers: namesOf(outcome.passers),
    failers: namesOf(outcome.failers),
  });
  const flavor = edge.recap
    ? fillTokens(pickVariant(edge.recap, room.mode, room.format), {
        winner: winnerNames,
        loser: loserNames,
        crew: room.players.map((p) => p.username),
      })
    : '';
  const recap = flavor ? `${headline} ${flavor}` : headline;

  // consequences for the next round: scene-defined if present, otherwise sensible defaults
    const authored = edge.winner || edge.loser || edge.all;
  const fx: FX = authored ? { winner: edge.winner, loser: edge.loser, all: edge.all } : defaultEffects(outcome.kind);
  const shieldedIds = new Set(rows.filter((r) => r.shielded).map((r) => r.userId));
  const effects: { userId: string; mod: number; label: string }[] = [];
  const blocked: { userId: string; label: string }[] = [];
  for (const p of room.players) {
    const specific = outcome.winnerTeam === null ? undefined : p.team === outcome.winnerTeam ? fx.winner : fx.loser;
    const e = specific ?? fx.all;
    if (!e) continue;
    // a Shield stops a penalty from following you into the next scene
    if (e.mod < 0 && shieldedIds.has(p.userId)) {
      blocked.push({ userId: p.userId, label: e.label });
      continue;
    }
    p.carry = { mod: e.mod, label: e.label };
    effects.push({ userId: p.userId, mod: e.mod, label: e.label });
  }

  if (room.mode === 'coop') room.coopPoints += COOP_POINTS[outcome.kind] ?? 0;
  else if (outcome.winnerTeam !== null) room.teamWins[outcome.winnerTeam] = (room.teamWins[outcome.winnerTeam] ?? 0) + 1;

  const next = edge.to;
  const ends = next === null || !room.scenario.scenes[next] || room.round >= BALANCE.maxRounds;

  io.to(`room:${room.id}`).emit('round:result', {
    round: room.round,
    rolls: rows.map((r) => ({
      userId: r.userId,
      team: r.team,
      round: r.round,
      sceneKey: r.sceneKey,
      approach: r.approach,
      starPlay: r.starPlay,
      die: r.die,
      dice: r.dice,
      shielded: r.shielded,
      modifier: r.modifier,
      starBonus: r.starBonus,
      total: r.total,
      tier: r.tier,
      standing:
        room.mode === 'coop' ? 'crew' : outcome.winnerTeam === null ? 'level' : r.team === outcome.winnerTeam ? 'won' : 'lost',
    })),
    kind: outcome.kind,
    same: outcome.same,
    winnerTeam: outcome.winnerTeam,
    headline,
    effects,
    ends,
    revealMs: BALANCE.resultDelayMs,
  });

  room.timer = setTimeout(() => {
    if (ends || next === null) return void finish(room);
    room.sceneKey = next;
    room.recap = recap; // shown at the top of the next scene
    room.round += 1;
    beginRound(room);
  }, BALANCE.resultDelayMs);
}

async function finish(room: Room) {
  room.status = 'finished';
  room.recap = null;
  const rounds = room.round;
  let winnerTeam: number | null = null;
  let success = false;
  if (room.mode === 'coop') success = room.coopPoints >= rounds * BALANCE.coopPassAvg;
  else {
    const w0 = room.teamWins[0] ?? 0;
    const w1 = room.teamWins[1] ?? 0;
    winnerTeam = w0 === w1 ? null : w0 > w1 ? 0 : 1;
  }

  const results = room.players.map((p) => {
    let result: 'win' | 'loss' | 'draw' | 'success' | 'fail';
    let points: number;
    if (room.mode === 'coop') {
      result = success ? 'success' : 'fail';
      points = success ? BALANCE.points.coopSuccess : BALANCE.points.coopFail;
    } else if (winnerTeam === null) {
      result = 'draw';
      points = BALANCE.points.draw;
    } else if (winnerTeam === p.team) {
      result = 'win';
      points = BALANCE.points.win;
    } else {
      result = 'loss';
      points = BALANCE.points.loss;
    }
    return { userId: p.userId, username: p.username, team: p.team, result, points };
  });

  // closing paragraph for each possible outcome; the web app shows the one that matches the player
  const names = {
    winner: winnerTeam === null ? [] : room.players.filter((p) => p.team === winnerTeam).map((p) => p.username),
    loser: winnerTeam === null ? [] : room.players.filter((p) => p.team !== winnerTeam).map((p) => p.username),
    crew: room.players.map((p) => p.username),
  };
  const endings: Record<string, string> = {};
  const e = room.scenario.endings;
  if (e) {
    for (const k of ['win', 'loss', 'draw', 'success', 'fail'] as const) {
      const v = e[k];
      if (v) endings[k] = fillTokens(pickVariant(v, room.mode, room.format), names);
    }
  }

  getIo().to(`room:${room.id}`).emit('encounter:finished', { roomId: room.id, mode: room.mode, results, endings });
  room.players.forEach((p) => roomOfUser.delete(p.userId)); // free to queue again immediately

  try {
    await supabase.from('encounter_rolls').insert(
      room.rolls.map((r) => ({
        encounter_id: room.id,
        round_no: r.round,
        user_id: r.userId,
        scene_key: r.sceneKey,
        approach: r.approach,
        die: r.die,
        modifier: r.modifier,
        star_play: r.starPlay,
        star_bonus: r.starBonus,
        total: r.total,
        tier: r.tier,
      })),
    );
    await supabase
      .from('encounters')
      .update({ status: 'finished', finished_at: new Date().toISOString(), outcome: { winnerTeam, success, rounds } })
      .eq('id', room.id);
    await Promise.all(
      results.map(async (r) => {
        await supabase.from('encounter_players').update({ result: r.result, score_delta: r.points }).match({ encounter_id: room.id, user_id: r.userId });
        await supabase.rpc('record_result', {
          p_user: r.userId,
          p_season: weekKey(),
          p_points: r.points,
          p_won: r.result === 'win' || r.result === 'success',
        });
        await afterEncounter(r.userId);
      }),
    );
  } catch (err) {
    console.error('finish persist failed', err);
  }

  setTimeout(() => {
    rooms.delete(room.id);
    if (room.code) roomByCode.delete(room.code);
  }, 120_000);
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