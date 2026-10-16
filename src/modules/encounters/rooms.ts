import { supabase } from '../../db/supabase';
import { getIo } from '../../realtime/context';
import { BALANCE } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { makeCode } from '../../lib/codes';
import { weekKey } from '../../lib/time';
import { applyEdge, rollBase, type RollState } from '../../game-engine/resolver';
import { resolveRound } from '../../game-engine/round';
import { fillTokens, resultLine, APPROACH_LABEL, joinNames } from '../../game-engine/narrative';
import { pickEdge, pickVariant, type Scenario, type Scene } from '../../game-engine/scenario';
import type { Approach, Format, Kind, Mode, StarPlay, Tier } from '../../game-engine/types';
import { pickScenario, dailyScenario, supports } from '../../content';
import { afterEncounter } from '../progress/progress.service';

type Phase = 'choose' | 'edge' | 'reveal';
type Player = {
  userId: string;
  username: string;
  avatar: unknown;
  team: number;
  stats: Record<Approach, number>;
  stars: number;
  action?: { approach: Approach };
  roll: (RollState & { approach: Approach }) | null;
  edge: StarPlay | null; // the bonus used this round
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
    held: Map<string, Map<string, number>>; // userId -> mark -> last round it is active
  world: Map<string, number>; // shared marks
  history: Map<string, Set<string>>; // every mark earned this game -> who earned it
  log: string[]; // one story line per round
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
const EDGES: StarPlay[] = ['reroll', 'nudge']; // the bonuses currently offered
const MIN_EDGE = Math.min(...EDGES.map((id) => BALANCE.starCost[id]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type SceneChoice = Scene['choices'][number];
const alive = (m: Map<string, number> | undefined, round: number, mark: string) => (m?.get(mark) ?? 0) >= round;
const activeIds = (room: Room, m: Map<string, number> | undefined) =>
  [...(m ?? [])].filter(([, until]) => until >= room.round).map(([id]) => id);
const markInfo = (room: Room, id: string) => ({
  id,
  label: room.scenario.marks[id]?.label ?? id,
  tip: room.scenario.marks[id]?.tip ?? '',
});

function holds(room: Room, who: 'self' | 'rival' | 'world', p: Player, mark: string) {
  if (who === 'world') return alive(room.world, room.round, mark);
  if (who === 'self') return alive(room.held.get(p.userId), room.round, mark);
  return room.players.some((o) => o.team !== p.team && alive(room.held.get(o.userId), room.round, mark));
}
const choiceDc = (room: Room, p: Player, c: SceneChoice) =>
  Math.max(5, Math.min(24, c.dc + (c.mods ?? []).reduce((s, m) => s + (holds(room, m.who, p, m.mark) ? m.dc : 0), 0)));
const lockReason = (room: Room, p: Player, c: SceneChoice) =>
  c.lock && holds(room, c.lock.who, p, c.lock.mark) ? c.lock.reason : null;
/** Moves a player may pick. If every move is locked we ignore the locks so nobody is stuck. */
const openChoices = (room: Room, p: Player, scene: Scene) => {
  const open = scene.choices.filter((c) => !lockReason(room, p, c));
  return open.length ? open : scene.choices;
};
function twistsFor(room: Room, scene: Scene): string[] {
  const out: string[] = [];
  for (const t of scene.twists ?? []) {
    const names = room.players.filter((p) => alive(room.held.get(p.userId), room.round, t.if)).map((p) => p.username);
    if (!names.length && !alive(room.world, room.round, t.if)) continue;
    out.push(pickVariant(t.text, room.mode, room.format).replaceAll('{holder}', joinNames(names)));
  }
  return out;
}
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
        held: new Map(),
    world: new Map(),
    history: new Map(),
    log: [],
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
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    recap: room.status === 'active' ? room.recap : null,
    scenario: { id: room.scenario.id, title: room.scenario.title, tagline: room.scenario.tagline },
    world: activeIds(room, room.world).map((id) => markInfo(room, id)),
    scene:
      scene && {
        key: room.sceneKey,
        title: pickVariant(scene.title, m, f),
        text: pickVariant(scene.text, m, f),
        stakes: scene.stakes ? pickVariant(scene.stakes, m, f) : null,
        twists: twistsFor(room, scene),
        choices: scene.choices.map((c) => ({
          approach: c.approach,
          label: pickVariant(c.label, m, f),
          // the base difficulty stays hidden; only the shifts from marks are shown
          mods: (c.mods ?? []).map((x) => ({
            mark: x.mark,
            who: x.who,
            delta: x.dc,
            label: room.scenario.marks[x.mark]?.label ?? x.mark,
          })),
          lock: c.lock ? { mark: c.lock.mark, who: c.lock.who, reason: c.lock.reason } : null,
        })),
      },
    players: room.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      avatar: p.avatar,
      team: p.team,
      acted: room.phase === 'edge' ? p.edgeDone : !!p.action,
      marks: activeIds(room, room.held.get(p.userId)).map((id) => markInfo(room, id)),
    })),
  };
}

export const emitState = (room: Room) => getIo().to(`room:${room.id}`).emit('room:state', publicState(room));

/** Builds a player's private roll payload, or null if they have nothing to show right now. */
function privateRoll(room: Room, userId: string) {
  const p = room.players.find((x) => x.userId === userId);
  if (!p || !p.roll || p.afk || room.phase !== 'edge') return null;
  const r = p.roll;
  const edges = EDGES.map((id) => ({
    id,
    cost: BALANCE.starCost[id],
    usable: !p.edgeDone && p.stars >= BALANCE.starCost[id],
  }));
  return {
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
  };
}

/** A player's own roll, sent only to them. Nobody else sees it until the reveal. */
export function sendPrivate(room: Room, userId: string) {
  const payload = privateRoll(room, userId);
  if (payload) getIo().to(`user:${userId}`).emit('roll:private', payload);
}

/** Lets a client ask for its roll again (refresh, reconnect, missed event). */
export function myRoll(userId: string) {
  const room = rooms.get(roomOfUser.get(userId) ?? '');
  const payload = room ? privateRoll(room, userId) : null;
  if (!payload) throw new AppError(409, 'not_accepting_actions');
  return payload;
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
    const scene = room.scenario.scenes[room.sceneKey];
  const picked = scene.choices.find((c) => c.approach === approach);
  if (!picked) throw new AppError(400, 'invalid_approach');
  if (!openChoices(room, p, scene).includes(picked)) throw new AppError(409, 'move_locked');
  p.action = { approach };
  if (room.players.every((x) => x.action)) startRolls(room);
  else emitState(room);
}

// ---------- Step 2: everyone rolls privately, then may use a bonus ----------
function startRolls(room: Room) {
  if (room.phase !== 'choose' || room.status !== 'active' || room.resolving) return;
  if (room.timer) clearTimeout(room.timer);
  const scene = room.scenario.scenes[room.sceneKey];

  for (const p of room.players) {
    p.afk = !p.action; // AFK players get a random approach and never see a bonus prompt
        const open = openChoices(room, p, scene);
    const approach = p.action?.approach ?? open[Math.floor(Math.random() * open.length)].approach;
    const choice = scene.choices.find((c) => c.approach === approach)!;
    const base = BALANCE.useStats ? Math.min(p.stats[approach] ?? 0, BALANCE.maxModifier) : 0;
    p.roll = { approach, ...rollBase({ modifier: base, dc: choiceDc(room, p, choice) }) };
    // nothing to decide if you're AFK or can't afford the cheapest bonus
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
    if (!EDGES.includes(choice)) throw new AppError(400, 'invalid_edge');
    const cost = BALANCE.starCost[choice];
    if (cost > p.stars) throw new AppError(402, 'not_enough_stars');
    p.edgeBusy = true;
    try {
      // stars are only charged here, when the bonus is actually used
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
    const lead = outcome.lead;
  const route = pickEdge(scene, outcome.kind, outcome.same, lead?.approach ?? null);

  const namesOf = (ids: string[]) => ids.map((id) => room.players.find((p) => p.userId === id)?.username ?? 'Player');
  const winnerNames = namesOf(outcome.winnerIds);
  const loserNames = namesOf(outcome.loserIds);
  const move = lead ? APPROACH_LABEL[lead.approach] : undefined;

  const headline = resultLine({
    mode: room.mode,
    kind: outcome.kind,
    same: outcome.same,
    approach: outcome.sameApproach,
    winner: winnerNames,
    loser: loserNames,
    passers: namesOf(outcome.passers),
    failers: namesOf(outcome.failers),
    move,
  });
  const flavor = route.recap
    ? fillTokens(pickVariant(route.recap, room.mode, room.format), {
        winner: winnerNames,
        loser: loserNames,
        crew: room.players.map((p) => p.username),
        move,
      })
    : '';
  const recap = flavor ? `${headline} ${flavor}` : headline;
  room.log.push(recap);

  // marks earned this round: they apply from the next round on
  const gained: { userId: string | null; mark: string; label: string; tip: string }[] = [];
  for (const g of route.set ?? []) {
    const def = room.scenario.marks[g.mark];
    if (!def) continue;
    const until = room.round + def.rounds;
    const targets: (string | null)[] =
      g.to === 'world'
        ? [null]
        : g.to === 'all'
          ? room.players.map((p) => p.userId)
          : g.to === 'winner'
            ? outcome.winnerIds
            : g.to === 'loser'
              ? outcome.loserIds
              : lead
                ? [lead.userId]
                : [];
    for (const t of targets) {
      const holder = t === null ? room.world : (room.held.get(t) ?? room.held.set(t, new Map()).get(t)!);
      holder.set(g.mark, until);
      const names = room.history.get(g.mark) ?? new Set<string>();
      if (t) names.add(room.players.find((p) => p.userId === t)?.username ?? 'Player');
      room.history.set(g.mark, names);
      gained.push({ userId: t, mark: g.mark, label: def.label, tip: def.tip });
    }
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
        gained,
    lead: lead ?? null,
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
  const epilogue = (room.scenario.epilogues ?? [])
    .filter((x) => room.history.has(x.if))
    .map((x) => fillTokens(pickVariant(x.text, room.mode, room.format), { ...names, holder: [...(room.history.get(x.if) ?? [])] }));

  getIo().to(`room:${room.id}`).emit('encounter:finished', { roomId: room.id, mode: room.mode, results, endings, story: room.log, epilogue });
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