import { supabase } from '../../db/supabase';
import { getIo } from '../../realtime/context';
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { makeCode } from '../../lib/codes';
import { weekKey } from '../../lib/time';
import { applyEdge, rollBase, type RollState } from '../../game-engine/resolver';
import { resolveRound } from '../../game-engine/round';
import { defaultEffects, fillTokens, resultLine, type FX } from '../../game-engine/narrative';
import { pickEdge, pickVariant, type Scenario } from '../../game-engine/scenario';
import type { Approach, Format, Kind, Mode, StarPlay, Tier } from '../../game-engine/types';
import { pickScenario, dailyScenario, supports } from '../../content';
import { afterEncounter } from '../progress/progress.service';

type Carry = { mod: number; label: string };
type Phase = 'choose' | 'edge' | 'reveal';
type Player = {
  userId: string;
  username: string;
  avatar: unknown;
  team: number;
  stats: Record<Approach, number>;
  stars: number;
  action?: { approach: Approach };
  carry: Carry | null;
  roll: (RollState & { approach: Approach }) | null;
  edge: StarPlay | null; // the edge used this round
  edgeDone: boolean; // decided (or had nothing to decide)
  edgeBusy: boolean; // payment in flight
  afk: boolean;
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
  modifier: number;
  starBonus: number;
  total: number;
  tier: Tier;
  dc: number;
  margin: number;
  shielded: boolean;
};
export type Room = {
  id: string;
  code: string | null;
  mode: Mode;
  format: Format;
  capacity: number;
  scenario: Scenario;
  status: 'waiting' | 'active' | 'finished';
  phase: Phase;
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
const MIN_EDGE = Math.min(...Object.values(BALANCE.starCost));
const passed = (t: Tier) => t === 'win' || t === 'legendary';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    phase: 'choose',
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
    phase: room.phase,
    capacity: room.capacity,
    round: room.round,
    maxRounds: BALANCE.maxRounds,
    roundSeconds: BALANCE.roundSeconds,
    edgeSeconds: BALANCE.edgeSeconds,
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
      // "ready" means: chose a move (choose phase) or decided on an edge (edge phase)
      acted: room.phase === 'edge' ? p.edgeDone : !!p.action,
      status: p.carry,
    })),
  };
}
export const emitState = (room: Room) => getIo().to(`room:${room.id}`).emit('room:state', publicState(room));

/** A player's own roll, sent only to them. Nobody else sees it until the reveal. */
export function sendPrivate(room: Room, userId: string) {
  const p = room.players.find((x) => x.userId === userId);
  if (!p || !p.roll || p.afk || room.phase !== 'edge') return;
  const r = p.roll;
  const edges = (Object.keys(BALANCE.starCost) as StarPlay[]).map((id) => ({
    id,
    cost: BALANCE.starCost[id],
    usable: !p.edgeDone && p.stars >= BALANCE.starCost[id] && !(id === 'shield' && passed(r.tier)),
  }));
  getIo().to(`user:${userId}`).emit('roll:private', {
    round: room.round,
    approach: r.approach,
    die: r.die,
    dice: r.dice,
    modifier: r.modifier,
    starBonus: r.starBonus,
    total: r.total,
    tier: r.tier,
    shielded: r.shielded,
    stars: p.stars,
    used: p.edge,
    done: p.edgeDone,
    edges,
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
  });
}

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
      roll: null,
      edge: null,
      edgeDone: false,
      edgeBusy: false,
      afk: false,
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

// ---------- Step 1: choose ----------
function beginRound(room: Room) {
  room.players.forEach((p) => {
    p.action = undefined;
    p.roll = null;
    p.edge = null;
    p.edgeDone = false;
    p.edgeBusy = false;
    p.afk = false;
  });
  room.resolving = false;
  room.phase = 'choose';
  room.deadline = Date.now() + BALANCE.roundSeconds * 1000;
  room.timer = setTimeout(() => startRolls(room), BALANCE.roundSeconds * 1000);
  emitState(room);
}

export function submitAction(userId: string, approach: Approach) {
  const room = rooms.get(roomOfUser.get(userId) ?? '');
  if (!room || room.status !== 'active' || room.phase !== 'choose' || room.resolving) throw new AppError(409, 'not_accepting_actions');
  const p = room.players.find((x) => x.userId === userId)!;
  if (p.action) throw new AppError(409, 'already_chose');
  if (!room.scenario.scenes[room.sceneKey].choices.some((c) => c.approach === approach)) throw new AppError(400, 'invalid_approach');
  p.action = { approach };
  if (room.players.every((x) => x.action)) startRolls(room);
  else emitState(room);
}

// ---------- Step 2: everyone rolls privately, then may use an edge ----------
function startRolls(room: Room) {
  if (room.phase !== 'choose' || room.status !== 'active' || room.resolving) return;
  if (room.timer) clearTimeout(room.timer);
  const scene = room.scenario.scenes[room.sceneKey];

  for (const p of room.players) {
    p.afk = !p.action; // AFK players get a random approach and never see an edge prompt
    const approach = p.action?.approach ?? scene.choices[Math.floor(Math.random() * scene.choices.length)].approach;
    const choice = scene.choices.find((c) => c.approach === approach)!;
    const base = Math.min(p.stats[approach] ?? 0, BALANCE.maxModifier);
    // last round's consequence (Momentum, Rattled...) applies to this roll only
    p.roll = { approach, ...rollBase({ modifier: base + (p.carry?.mod ?? 0), dc: choice.dc }) };
    p.carry = null;
    // nothing to decide if you're AFK or can't afford the cheapest edge
    p.edgeDone = p.afk || p.stars < MIN_EDGE;
  }

  if (room.players.every((p) => p.edgeDone)) return void settle(room);

  room.phase = 'edge';
  room.deadline = Date.now() + BALANCE.edgeSeconds * 1000;
  room.timer = setTimeout(() => void settle(room), BALANCE.edgeSeconds * 1000);
  emitState(room);
  room.players.forEach((p) => sendPrivate(room, p.userId));
}

export async function playEdge(userId: string, choice: StarPlay | 'skip') {
  const room = rooms.get(roomOfUser.get(userId) ?? '');
  const p = room?.players.find((x) => x.userId === userId);
  if (!room || !p || room.status !== 'active' || room.phase !== 'edge' || room.resolving || !p.roll) {
    throw new AppError(409, 'not_accepting_actions');
  }
  if (p.edgeDone || p.edgeBusy) throw new AppError(409, 'already_decided');

  if (choice === 'skip') {
    p.edgeDone = true;
  } else {
    const cost = BALANCE.starCost[choice];
    if (cost > p.stars) throw new AppError(402, 'not_enough_stars');
    if (choice === 'shield' && passed(p.roll.tier)) throw new AppError(400, 'shield_not_needed');
    p.edgeBusy = true;
    try {
      // stars are only charged here, when the edge is actually used
      const { data, error } = await supabase.rpc('apply_stars', {
        p_user: userId,
        p_delta: -cost,
        p_reason: 'star_play',
        p_ref: `${room.id}:${room.round}`,
      });
      if (error) throw error.message.includes('insufficient_stars') ? new AppError(402, 'not_enough_stars') : error;
      p.stars = Number(data);
      p.roll = { approach: p.roll.approach, ...applyEdge(p.roll, choice) };
      p.edge = choice;
      p.edgeDone = true;
      getIo().to(`user:${userId}`).emit('stars:update', { stars: p.stars });
    } finally {
      p.edgeBusy = false;
    }
  }

  sendPrivate(room, userId);
  if (room.players.every((x) => x.edgeDone)) void settle(room);
  else emitState(room);
}

// ---------- Step 3: reveal ----------
async function settle(room: Room) {
  if (room.resolving || room.status !== 'active') return;
  room.resolving = true;
  room.phase = 'reveal';
  room.deadline = null;
  if (room.timer) clearTimeout(room.timer);
  // if somebody's payment is still in flight when the timer ends, let it finish first
  for (let i = 0; i < 40 && room.players.some((p) => p.edgeBusy); i++) await sleep(50);

  const io = getIo();
  const scene = room.scenario.scenes[room.sceneKey];
  const rows: RollRow[] = room.players.map((p) => {
    const r = p.roll!;
    return {
      userId: p.userId,
      team: p.team,
      round: room.round,
      sceneKey: room.sceneKey,
      approach: r.approach,
      starPlay: p.edge,
      die: r.die,
      dice: r.dice,
      modifier: r.modifier,
      starBonus: r.starBonus,
      total: r.total,
      tier: r.tier,
      dc: r.dc,
      margin: r.margin,
      shielded: r.shielded,
    };
  });

  room.rolls.push(...rows);
  const outcome = resolveRound(
    room.mode,
    rows.map((r) => ({ userId: r.userId, team: r.team, approach: r.approach, tier: r.tier, margin: r.margin })),
  );
  const route = pickEdge(scene, outcome.kind, outcome.same);

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
  const flavor = route.recap
    ? fillTokens(pickVariant(route.recap, room.mode, room.format), {
        winner: winnerNames,
        loser: loserNames,
        crew: room.players.map((p) => p.username),
      })
    : '';
  const recap = flavor ? `${headline} ${flavor}` : headline;

  // consequences for the next round: scene-defined if present, otherwise sensible defaults
  const authored = route.winner || route.loser || route.all;
  const fx: FX = authored ? { winner: route.winner, loser: route.loser, all: route.all } : defaultEffects(outcome.kind);
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

  const next = route.to;
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
      modifier: r.modifier,
      starBonus: r.starBonus,
      total: r.total,
      tier: r.tier,
      shielded: r.shielded,
      standing:
        room.mode === 'coop' ? 'crew' : outcome.winnerTeam === null ? 'level' : r.team === outcome.winnerTeam ? 'won' : 'lost',
    })),
    kind: outcome.kind,
    same: outcome.same,
    winnerTeam: outcome.winnerTeam,
    headline,
    effects,
    blocked,
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