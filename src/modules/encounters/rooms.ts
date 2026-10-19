import { supabase } from '../../db/supabase';
import { getIo } from '../../realtime/context';
import { BALANCE, entryKindOf } from '../../config/balance';
import { AppError } from '../../lib/errors';
import { makeCode } from '../../lib/codes';
import { lagosDate, weekKey } from '../../lib/time';
import { applyEdge, rollBase, type RollState } from '../../game-engine/resolver';
import { decideDuel, duelRoadOutcome, resolveRound } from '../../game-engine/round';
import { d20 } from '../../game-engine/dice';
import { fillTokens, resultLine, APPROACH_LABEL, joinNames } from '../../game-engine/narrative';
import { pickEdge, pickVariant, stepsToEnd, type Scenario, type Scene } from '../../game-engine/scenario';
import type { Approach, Format, Kind, Mode, StarPlay, Tier } from '../../game-engine/types';
import { allScenarios, pickScenario, dailyScenario, supports } from '../../content';
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
  solo: boolean; // one player against the story (stored as co-op with a single seat)
  players: Player[];
  sceneKey: string; // co-op / solo: the shared scene
  track: Record<number, { key: string; recap: string | null }>; // race modes: each side walks its own road
  arrived: Record<number, { score: number; sceneKey: string; round: number }>; // race modes: sides that reached the end
  round: number;
  visited: Map<number, Set<string>>; // scenes each road has already played (road 0 for co-op and solo), so no scene is ever replayed
    held: Map<string, Map<string, number>>; // userId -> mark -> last round it is active
  world: Map<string, number>; // shared marks
  history: Map<string, Set<string>>; // every mark earned this game -> who earned it
  bonusLost: Set<string>; // players who have lost the story bonus
  log: Record<number, string[]>; // one story line per round, per road (co-op uses road 0)
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
/** Face-off games (Face Off / Team): the higher roll wins. There is no number to beat, so none is ever shown. */
const isDuel = (room: Pick<Room, 'mode'>) => room.mode !== 'coop';
/** Stars each player pays when this game starts, and the total a winner gets back. */
const kindOf = (room: Pick<Room, 'mode' | 'solo'>) => entryKindOf(room.mode, room.solo);
const entryCostOf = (room: Pick<Room, 'mode' | 'solo'>) => BALANCE.entryCost[kindOf(room)];
const payoutOf = (room: Pick<Room, 'mode' | 'solo'>) => BALANCE.payout[kindOf(room)];
type SceneChoice = Scene['choices'][number];
const alive = (m: Map<string, number> | undefined, round: number, mark: string) => (m?.get(mark) ?? 0) >= round;
const activeIds = (room: Room, m: Map<string, number> | undefined) =>
  [...(m ?? [])].filter(([, until]) => until >= room.round).map(([id]) => id);
/** The scene a player is currently on: shared in co-op, their own road in race modes */
const sceneKeyOf = (room: Room, p: Player) => (room.mode === 'coop' ? room.sceneKey : room.track[p.team].key);
const sceneOf = (room: Room, p: Player) => room.scenario.scenes[sceneKeyOf(room, p)];
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
/** The number a player must roll (d20 + modifier) to pull the move off. Shown on the move and on the dice. */
const choiceDc = (room: Room, p: Player, c: SceneChoice) => {
  const story = BALANCE.storyMods ? (c.mods ?? []).reduce((s, m) => s + (holds(room, m.who, p, m.mark) ? m.dc : 0), 0) : 0;
  const ease = room.solo ? BALANCE.soloDcEase : 0;
  return Math.max(5, Math.min(24, c.dc + story - ease));
};
const lockReason = (room: Room, p: Player, c: SceneChoice) =>
  c.lock && holds(room, c.lock.who, p, c.lock.mark) ? c.lock.reason : null;
/** Moves a player may pick. If every move is locked we ignore the locks so nobody is stuck. */
const openChoices = (room: Room, p: Player, scene: Scene) => {
  const open = scene.choices.filter((c) => !lockReason(room, p, c));
  return open.length ? open : scene.choices;
};
function twistsFor(room: Room, scene: Scene, viewer?: Player): string[] {
  const out: string[] = [];
  const crew = room.mode === 'coop' || !viewer ? room.players : room.players.filter((p) => p.team === viewer.team);
  for (const t of scene.twists ?? []) {
    const names = crew.filter((p) => alive(room.held.get(p.userId), room.round, t.if)).map((p) => p.username);
    if (!names.length && !alive(room.world, room.round, t.if)) continue;
    out.push(pickVariant(t.text, textMode(room), room.format).replaceAll('{holder}', joinNames(names)));
    break; // one story note per scene is enough; more just clutters the screen
  }
  return out;
}
/** Which text version to show: one-player games read the solo text, then the co-op text */
const textMode = (room: Room): Mode | 'solo' => (room.solo ? 'solo' : room.mode);
// Active games live in memory (fast). Results are saved to Supabase when a game ends.
export const rooms = new Map<string, Room>();
export const roomByCode = new Map<string, string>();
export const roomOfUser = new Map<string, string>();

/**
 * Picks the scenario that these players have gone longest without playing (one they have never played comes first),
 * so a new game or a rematch is not the story they just finished. `avoid` is ruled out whenever there is another choice.
 */
async function pickFreshScenario(mode: Mode, format: Format, playerIds: string[], avoid?: string): Promise<Scenario> {
  let pool = allScenarios().filter((s) => supports(s, mode, format));
  if (avoid && pool.length > 1) pool = pool.filter((s) => s.id !== avoid);
  if (pool.length <= 1) return pool[0] ?? pickScenario(mode, format);
  try {
    const { data } = await supabase
      .from('encounters')
      .select('scenario_id, encounter_players!inner(user_id)')
      .in('encounter_players.user_id', playerIds)
      .in('status', ['active', 'finished'])
      .order('created_at', { ascending: false })
      .limit(12);
    const recent = [...new Set((data ?? []).map((r: { scenario_id: string }) => r.scenario_id))]; // newest first
    const age = (s: Scenario) => (recent.indexOf(s.id) === -1 ? Infinity : recent.indexOf(s.id));
    const oldest = Math.max(...pool.map(age));
    const best = pool.filter((s) => age(s) === oldest);
    return best[Math.floor(Math.random() * best.length)];
  } catch (err) {
    console.error('scenario rotation failed, picking at random', err);
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

export async function createRoom(o: {
  hostId: string;
  mode: Mode;
  format: Format;
  daily?: boolean;
  invite?: boolean;
  solo?: boolean;
  players?: string[]; // everyone who will play, so the scenario can be one they haven't just played
  avoid?: string; // a scenario id to skip (the one a rematch is coming from)
}) {
  let scenario = o.daily ? dailyScenario() : await pickFreshScenario(o.mode, o.format, o.players?.length ? o.players : [o.hostId], o.avoid);
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
    capacity: o.solo ? 1 : o.format === '1v1' ? 2 : 4,
    scenario,
    status: 'waiting',
    phase: 'choose',
    hostId: o.hostId,
        held: new Map(),
    world: new Map(),
    history: new Map(),
    bonusLost: new Set(),
    log: {},
    isDaily: !!o.daily,
    solo: !!o.solo,
    players: [],
    sceneKey: scenario.start,
    track: { 0: { key: scenario.start, recap: null }, 1: { key: scenario.start, recap: null } },
    arrived: {},
    round: 1,
    visited: new Map([
      [0, new Set([scenario.start])],
      [1, new Set([scenario.start])],
    ]),
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

export function publicState(room: Room, viewerId?: string) {
  const viewer = room.players.find((p) => p.userId === viewerId) ?? (room.mode === 'coop' ? undefined : room.players[0]);
  const scene = room.status === 'active' ? (viewer ? sceneOf(room, viewer) : room.scenario.scenes[room.sceneKey]) : null;
  const sceneKey = viewer ? sceneKeyOf(room, viewer) : room.sceneKey;
  const recap = room.mode === 'coop' || !viewer ? room.recap : room.track[viewer.team].recap;
  const m = textMode(room);
  const f = room.format;
  return {
    id: room.id,
    code: room.code,
    mode: room.mode,
    solo: room.solo,
    format: room.format,
    status: room.status,
    phase: room.phase,
    capacity: room.capacity,
    round: room.round,
    maxRounds: BALANCE.maxRounds,
    roundSeconds: BALANCE.roundSeconds,
    edgeSeconds: BALANCE.edgeSeconds,
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    recap: room.status === 'active' ? recap : null,
    scenario: { id: room.scenario.id, title: room.scenario.title, tagline: room.scenario.tagline },
    world: activeIds(room, room.world).map((id) => markInfo(room, id)),
    entry: entryCostOf(room), // stars each player pays to start
    // stars is the TOTAL paid out to a winner (the entry comes back inside it)
    win: room.solo
      ? { points: BALANCE.soloSuccess, stars: payoutOf(room) }
      : { points: room.mode === 'coop' ? BALANCE.points.coopSuccess : BALANCE.points.win, stars: payoutOf(room) },
    wins: room.mode === 'coop' ? null : { 0: room.teamWins[0] ?? 0, 1: room.teamWins[1] ?? 0 },
    bonus: room.scenario.bonus
      ? { label: room.scenario.bonus.label, stars: BALANCE.bonus.stars, points: BALANCE.bonus.points }
      : null,
    scene:
      scene && {
        key: sceneKey,
        title: pickVariant(scene.title, m, f),
        text: pickVariant(scene.text, m, f),
        stakes: scene.stakes ? pickVariant(scene.stakes, m, f) : null,
        twists: twistsFor(room, scene, viewer),
        choices: scene.choices.map((c) => ({
          approach: c.approach,
          label: pickVariant(c.label, m, f),
          // the number you need to roll. Only co-op and solo have one: in a face-off the higher roll wins
          dc: isDuel(room) ? null : viewer ? choiceDc(room, viewer, c) : c.dc,
          // story marks that shift the number (switched off while BALANCE.storyMods is false, and never used in a face-off)
          mods: (BALANCE.storyMods && !isDuel(room) ? (c.mods ?? []) : []).map((x) => ({
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
      bonusKept: !room.bonusLost.has(p.userId),
      marks: activeIds(room, room.held.get(p.userId)).map((id) => markInfo(room, id)),
    })),
  };
}

/** Race modes: every player gets the state of their own road. Co-op shares one state. */
export const emitState = (room: Room) => {
  const io = getIo();
  if (room.mode === 'coop' || room.status !== 'active') return void io.to(`room:${room.id}`).emit('room:state', publicState(room));
  room.players.forEach((p) => io.to(`user:${p.userId}`).emit('room:state', publicState(room, p.userId)));
};

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
    dc: isDuel(room) ? null : r.dc,
    passed: isDuel(room) ? null : r.tier === 'win' || r.tier === 'legendary',
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
    // nobody is charged while waiting, but you need the entry stars to take a seat
    if (prof.stars < entryCostOf(room)) throw new AppError(402, 'not_enough_stars');
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
  if (room.players.length === room.capacity && room.status === 'waiting') await startRoom(room);
  else emitState(room);
}

/** Throws 402 if the player can't pay `cost` stars right now. */
export async function assertCanAfford(userId: string, cost: number) {
  const { data, error } = await supabase.from('profiles').select('stars').eq('id', userId).single();
  if (error) throw error;
  if (data.stars < cost) throw new AppError(402, 'not_enough_stars');
}

/** Which of these players can't pay `cost` stars right now. */
export async function playersShort(userIds: string[], cost: number): Promise<string[]> {
  const { data, error } = await supabase.from('profiles').select('id, stars').in('id', userIds);
  if (error) throw error;
  const have = new Map((data ?? []).map((r) => [r.id, r.stars]));
  return userIds.filter((id) => (have.get(id) ?? 0) < cost);
}

export const entryCostFor = (mode: string, solo: boolean) => BALANCE.entryCost[entryKindOf(mode, solo)];

/**
 * Cancels a game that never got going: gives the entry back to `refund`, tells everyone in the room,
 * and frees the seats. Safe to call more than once for the same room.
 */
async function abortRoom(room: Room, reason: 'not_enough_stars' | 'nobody_moved' | 'server_error', refund: Player[] = []) {
  if (room.timer) clearTimeout(room.timer);
  if (room.status === 'finished') return;
  room.status = 'finished';
  const cost = entryCostOf(room);
  let refundsOk = true;
  for (const p of refund) {
    try {
      // idempotent per (user, game), so a retry or the orphan sweep can never pay twice
      await supabase.rpc('apply_stars', { p_user: p.userId, p_delta: cost, p_reason: 'entry_refund', p_ref: room.id }).throwOnError();
    } catch (err) {
      refundsOk = false;
      console.error('entry refund failed', room.id, p.userId, err);
    }
  }
  const io = getIo();
  io.to(`room:${room.id}`).emit('room:aborted', { roomId: room.id, reason, refunded: refund.length > 0 });
  for (const p of room.players) {
    roomOfUser.delete(p.userId);
    io.to(`user:${p.userId}`).emit('stars:refresh');
  }
  io.in(`room:${room.id}`).socketsLeave(`room:${room.id}`);
  rooms.delete(room.id);
  if (room.code) roomByCode.delete(room.code);
  // if a refund failed the game stays 'active' on purpose, so the orphan sweep retries it
  if (refundsOk) await supabase.from('encounters').update({ status: 'abandoned' }).eq('id', room.id);
}

/**
 * Games that were running when the server restarted are gone from memory, but their entry stars were taken.
 * Give those back. Only touches games that have been "active" for a while and aren't live on this server.
 */
export async function sweepOrphanedGames() {
  try {
    const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
    const { data: games } = await supabase.from('encounters').select('id').eq('status', 'active').lt('created_at', cutoff);
    for (const g of games ?? []) {
      if (rooms.has(g.id)) continue;
      const { data: rows } = await supabase
        .from('star_ledger')
        .select('user_id, delta, reason')
        .eq('ref_id', g.id)
        .in('reason', ['game_entry', 'solo_entry', 'game_refund', 'game_win', 'entry_refund']);
      const settled = new Set((rows ?? []).filter((r) => ['game_refund', 'game_win', 'entry_refund'].includes(r.reason)).map((r) => r.user_id));
      let ok = true;
      for (const r of (rows ?? []).filter((x) => x.reason === 'game_entry' || x.reason === 'solo_entry')) {
        if (settled.has(r.user_id)) continue;
        const { error } = await supabase.rpc('apply_stars', { p_user: r.user_id, p_delta: -r.delta, p_reason: 'entry_refund', p_ref: g.id });
        if (error) {
          ok = false;
          console.error('orphan refund failed', g.id, r.user_id, error.message);
        } else getIo().to(`user:${r.user_id}`).emit('stars:refresh');
      }
      if (ok) await supabase.from('encounters').update({ status: 'abandoned' }).eq('id', g.id);
    }
  } catch (err) {
    console.error('orphan sweep failed', err);
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

/** The seats are full: take everyone's entry stars, then play. If anyone can't pay, nobody pays. */
async function startRoom(room: Room) {
  room.status = 'active'; // locks the seats while the stars are taken
  const cost = entryCostOf(room);
  const reason = room.solo ? 'solo_entry' : 'game_entry';
  const charged: Player[] = [];
  for (const p of room.players) {
    // idempotent per (user, game): the same game can never charge a player twice
    const { data, error } = await supabase.rpc('apply_stars', { p_user: p.userId, p_delta: -cost, p_reason: reason, p_ref: room.id });
    if (error) {
      const short = error.message.includes('insufficient_stars');
      if (!short) console.error('entry charge failed', room.id, p.userId, error.message);
      await abortRoom(room, short ? 'not_enough_stars' : 'server_error', charged);
      return;
    }
    p.stars = Number(data);
    charged.push(p);
    getIo().to(`user:${p.userId}`).emit('stars:update', { stars: p.stars });
  }
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
  const scene = sceneOf(room, p);
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

  // Somebody never moved in round 1 (left, lost signal): the game never really began, so everyone gets their entry back
  if (room.round === 1 && room.players.some((p) => !p.action)) {
    void abortRoom(room, 'nobody_moved', room.players);
    return;
  }

  for (const p of room.players) {
    const scene = sceneOf(room, p);
    p.afk = !p.action; // AFK players get a random approach and never see a bonus prompt
        const open = openChoices(room, p, scene);
    const approach = p.action?.approach ?? open[Math.floor(Math.random() * open.length)].approach;
    const choice = scene.choices.find((c) => c.approach === approach)!;
    const base = BALANCE.useStats ? Math.min(p.stats[approach] ?? 0, BALANCE.maxModifier) : 0;
    // everyone rolls against their own road's difficulty; marks make it easier or harder
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
// Co-op: one group (the crew) walks one road. Race modes: each side is its own group on its own road.
// Every group is routed by ITS OWN move and ITS OWN pass or fail, so nobody's choice is thrown away.
async function settle(room: Room) {
  if (room.resolving || room.status !== 'active') return;
  room.resolving = true;
  room.phase = 'reveal';
  room.deadline = null;
  if (room.timer) clearTimeout(room.timer);
  // if somebody's payment is still in flight when the timer ends, let it finish first
  for (let i = 0; i < 40 && room.players.some((p) => p.edgeBusy); i++) await sleep(50);

  const io = getIo();
  const race = room.mode !== 'coop';
  const rows: RollRow[] = room.players.map((p) => {
    const r = p.roll!;
    return {
      userId: p.userId,
      team: p.team,
      round: room.round,
      sceneKey: sceneKeyOf(room, p),
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

  const namesOf = (ids: string[]) => ids.map((id) => room.players.find((p) => p.userId === id)?.username ?? 'Player');
  const bonusDef = room.scenario.bonus;
  const gained: { userId: string | null; mark: string; label: string; tip: string }[] = [];
  const bonusLostNow = new Set<string>();

  // Face-off: the HIGHER roll wins the round, there is no number to beat. Level rolls are settled by re-rolls,
  // which are sent along so the screen can show them. Co-op and solo still roll against the difficulty.
  const duel = race ? decideDuel(rows) : null;
  const leadTeam: number | null = duel ? duel.winnerTeam : null;
  const tieRounds = duel?.tieRounds ?? [];
  const revealMs = BALANCE.resultDelayMs + tieRounds.length * BALANCE.tieRerollMs;

  type Group = {
    g: number; // 0 for co-op, the team number in race modes
    ids: string[];
    scene: Scene;
    outcome: ReturnType<typeof resolveRound>;
    route: ReturnType<typeof pickEdge>;
    headline: string;
    flavor: string;
    arrives: boolean;
  };
  const groups: Group[] = (race ? [0, 1] : [0]).map((g) => {
    const crew = race ? room.players.filter((p) => p.team === g) : room.players;
    const scene = sceneOf(room, crew[0]);
    const rr = rows.filter((r) => crew.some((p) => p.userId === r.userId));
    const rolls = rr.map((r) => ({ userId: r.userId, team: r.team, approach: r.approach, tier: r.tier, margin: r.margin, total: r.total, dc: r.dc }));
    // a face-off road is "pulled off" by the side that rolled higher; co-op and solo pass or fail against the difficulty
    const outcome = race ? duelRoadOutcome(rolls, g === leadTeam) : resolveRound('coop', rolls);
    // A road never replays a scene it has already played. Routes are tried strictest first: a scene that can still reach
    // an ending in time without replaying anything, then any scene that isn't a dead end, then any scene not yet played.
    const played = room.visited.get(g)!;
    const left = BALANCE.maxRounds - room.round; // rounds still to play after this one
    const rules = [
      (to: string) => !played.has(to) && stepsToEnd(room.scenario, to, played) <= left,
      (to: string) => !played.has(to) && stepsToEnd(room.scenario, to, played) !== Infinity,
      (to: string) => !played.has(to),
    ];
    const route = pickEdge(scene, outcome.kind, outcome.same, outcome.lead?.approach ?? null, rules);
    const move = outcome.lead ? APPROACH_LABEL[outcome.lead.approach] : undefined;
    const headline = resultLine({
      mode: 'coop',
      kind: outcome.kind,
      same: outcome.same,
      approach: outcome.sameApproach,
      winner: namesOf(outcome.winnerIds),
      loser: namesOf(outcome.loserIds),
      passers: namesOf(outcome.passers),
      failers: namesOf(outcome.failers),
      move,
      solo: room.solo || crew.length === 1,
    });
    // race roads read the "you" (co-op) wording of each story line
    const flavor = route.recap
      ? fillTokens(pickVariant(route.recap, race ? 'coop' : textMode(room), room.format), {
          winner: namesOf(outcome.winnerIds),
          loser: namesOf(outcome.loserIds),
          crew: crew.map((p) => p.username),
          move,
        })
      : '';
    const to = route.to;
    const arrives = to === null || !room.scenario.scenes[to];
    return { g, ids: crew.map((p) => p.userId), scene, outcome, route, headline, flavor, arrives };
  });

  // the side that rolled higher takes the lead point
  if (leadTeam !== null) room.teamWins[leadTeam] = (room.teamWins[leadTeam] ?? 0) + 1;

  for (const grp of groups) {
    const { outcome, route } = grp;
    const lead = outcome.lead;
    for (const gr of route.set ?? []) {
      const def = room.scenario.marks[gr.mark];
      if (!def) continue;
      const until = room.round + def.rounds;
      const targets: (string | null)[] =
        gr.to === 'world'
          ? [null]
          : gr.to === 'all'
            ? grp.ids
            : gr.to === 'winner'
              ? outcome.winnerIds
              : gr.to === 'loser'
                ? outcome.loserIds
                : lead
                  ? [lead.userId]
                  : [];
      for (const t of targets) {
        const holder = t === null ? room.world : (room.held.get(t) ?? room.held.set(t, new Map()).get(t)!);
        holder.set(gr.mark, until);
        const names = room.history.get(gr.mark) ?? new Set<string>();
        if (t) names.add(room.players.find((p) => p.userId === t)?.username ?? 'Player');
        room.history.set(gr.mark, names);
        gained.push({ userId: t, mark: gr.mark, label: def.label, tip: def.tip });
        if (bonusDef?.lostBy.includes(gr.mark)) {
          // Link Up shares the bonus: one slip loses it for the whole crew
          const hit = t === null || room.mode === 'coop' ? room.players.map((p) => p.userId) : [t];
          for (const id of hit) if (!room.bonusLost.has(id)) (room.bonusLost.add(id), bonusLostNow.add(id));
        }
      }
    }
    if (race) {
      // reaching the end of the road: how well it ended (authored per final scene) plus how cleanly the last move landed
      if (grp.arrives) {
        const tail = outcome.kind === 'all_pass' ? 2 : outcome.kind === 'mixed' ? 1 : 0;
        room.arrived[grp.g] = { score: (grp.scene.finish ?? 1) * 2 + tail, sceneKey: sceneKeyOf(room, room.players.find((p) => p.team === grp.g)!), round: room.round };
      }
    } else room.coopPoints += COOP_POINTS[outcome.kind] ?? 0;
  }

  // what each viewer reads: their own road, plus one line on how the other road is going
  const raceLine = (me: Group) => {
    if (!race) return '';
    const other = groups[1 - me.g];
    const rival = joinNames(namesOf(other.ids));
    const doing = other.outcome.kind === 'all_pass' ? 'got it done' : other.outcome.kind === 'all_fail' ? 'ran into trouble' : 'scraped through';
    const pos = leadTeam === null ? 'Neck and neck.' : leadTeam === me.g ? 'You edge ahead.' : `${rival} pulls ahead.`;
    return `Meanwhile ${rival} ${doing}. ${pos}`;
  };
  const recapFor = (grp: Group) => [grp.headline, grp.flavor, raceLine(grp)].filter(Boolean).join(' ');
  for (const grp of groups) (room.log[grp.g] ??= []).push(recapFor(grp));

  const anyArrived = groups.some((x) => x.arrives);
  const ends = anyArrived || room.round >= BALANCE.maxRounds || (!race && groups[0].arrives);

  const send = (userId: string, grp: Group) =>
    io.to(`user:${userId}`).emit('round:result', {
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
        dc: race ? null : r.dc, // a face-off has no number to beat
        passed: race ? null : r.tier === 'win' || r.tier === 'legendary',
        tier: r.tier,
        shielded: r.shielded,
        standing: !race ? 'crew' : r.team === leadTeam ? 'won' : 'lost',
      })),
      kind: grp.outcome.kind,
      same: grp.outcome.same,
      winnerTeam: race ? leadTeam : null,
      headline: recapFor(grp),
      gained,
      lead: grp.outcome.lead ?? null,
      bonusLost: [...bonusLostNow],
      bonusLostMessage: bonusLostNow.size && bonusDef ? bonusDef.lostMessage : null,
      ends,
      tieRounds,
      revealMs,
    });
  room.players.forEach((p) => send(p.userId, groups[race ? p.team : 0]));

  room.timer = setTimeout(() => {
    if (ends) return void finish(room);
    for (const grp of groups) {
      const to = grp.route.to as string;
      room.visited.get(grp.g)!.add(to);
      if (race) room.track[grp.g] = { key: to, recap: recapFor(grp) };
      else {
        room.sceneKey = to;
        room.recap = recapFor(grp); // shown at the top of the next scene
      }
    }
    room.round += 1;
    beginRound(room);
  }, revealMs);
}

/**
 * How many more PROFIT stars a player may earn today. Game profit and the streak bonus share one daily cap.
 * The entry coming back ('game_refund') is not profit, so it never counts against the cap.
 */
async function starsLeftToday(userId: string): Promise<number> {
  const dayStart = new Date(`${lagosDate()}T00:00:00+01:00`).toISOString(); // Lagos is UTC+1 all year
  const { data } = await supabase
    .from('star_ledger')
    .select('delta')
    .eq('user_id', userId)
    .in('reason', ['game_win', 'game_bonus', 'streak'])
    .gte('created_at', dayStart);
  const used = (data ?? []).reduce((sum, row) => sum + row.delta, 0);
  return Math.max(0, BALANCE.dailyGameStarCap - used);
}

async function finish(room: Room) {
  room.status = 'finished';
  room.recap = null;
  const rounds = room.round;
  let winnerTeam: number | null = null;
  let success = false;
  let decider: { team: number; die: number }[][] = [];
  if (room.mode === 'coop') success = room.coopPoints >= rounds * BALANCE.coopPassAvg;
  else {
    // The race: whoever reached home first wins. If both got there in the same round, the better ending wins
    // (what you lost on the road counts), then the lead points. Still level: one die each decides it.
    const w0 = room.teamWins[0] ?? 0;
    const w1 = room.teamWins[1] ?? 0;
    const rank = (t: number) => (room.arrived[t] ? [-room.arrived[t].round, room.arrived[t].score, t === 0 ? w0 : w1] : [-99, 0, t === 0 ? w0 : w1]);
    const [ra, rb] = [rank(0), rank(1)];
    // arriving in an earlier round beats everything; otherwise compare ending score, then lead points
    winnerTeam = null;
    for (let i = 0; i < 3 && winnerTeam === null; i++) if (ra[i] !== rb[i]) winnerTeam = ra[i] > rb[i] ? 0 : 1;
    // Level after all that: one die each decides it, and a tie rolls again. No game ends as a draw.
    for (let i = 0; winnerTeam === null && i < 25; i++) {
      const throwN = [0, 1].map((team) => ({ team, die: d20() }));
      decider.push(throwN);
      if (throwN[0].die !== throwN[1].die) winnerTeam = throwN[0].die > throwN[1].die ? 0 : 1;
    }
    if (winnerTeam === null) winnerTeam = Math.random() < 0.5 ? 0 : 1; // safety net, practically unreachable
  }

  const bonusDef = room.scenario.bonus;
  const base = room.players.map((p) => {
    let result: 'win' | 'loss' | 'success' | 'fail';
    let points: number;
    if (room.mode === 'coop') {
      result = success ? 'success' : 'fail';
      points = room.solo ? (success ? BALANCE.soloSuccess : BALANCE.soloFail) : success ? BALANCE.points.coopSuccess : BALANCE.points.coopFail;
    } else if (winnerTeam === p.team) {
      result = 'win';
      points = BALANCE.points.win;
    } else {
      result = 'loss';
      points = BALANCE.points.loss;
    }
    const won = result === 'win' || result === 'success';
    const bonusKept = !!bonusDef && !room.bonusLost.has(p.userId);
    return { p, result, won, bonusKept, points: points + (bonusKept ? BALANCE.bonus.points : 0) };
  });

  // Work out stars before the result is shown, so the screen tells the truth.
  // A winner first gets the entry back (always), then the profit on top (limited by the daily cap).
  const entry = entryCostOf(room);
  const profitPrize = Math.max(0, payoutOf(room) - entry);
  const results = await Promise.all(
    base.map(async ({ p, result, won, bonusKept, points }) => {
      const left = await starsLeftToday(p.userId);
      const refundStars = won ? entry : 0;
      const winStars = Math.min(won ? profitPrize : 0, left);
      const bonusStars = Math.min(bonusKept ? BALANCE.bonus.stars : 0, left - winStars);
      const wanted = (won ? profitPrize : 0) + (bonusKept ? BALANCE.bonus.stars : 0);
      return {
        userId: p.userId,
        username: p.username,
        team: p.team,
        result,
        points,
        entry, // what this player paid to start
        stars: refundStars + winStars + bonusStars, // the total paid out (entry back + profit)
        refundStars,
        winStars,
        bonusStars,
        capped: winStars + bonusStars < wanted,
        bonus: !bonusDef ? null : bonusKept ? ('earned' as const) : ('missed' as const),
      };
    }),
  );

  // closing paragraph: in race modes it comes from the road YOU ended on, so a robbed player never reads the "intact" ending
  const bonusInfo = bonusDef ? { label: bonusDef.label, earnedLine: bonusDef.earnedLine, lostMessage: bonusDef.lostMessage } : null;
  for (const p of room.players) {
    const crewNames = room.players.filter((x) => x.team === p.team).map((x) => x.username);
    const names = {
      winner: winnerTeam === null ? [] : room.players.filter((x) => x.team === winnerTeam).map((x) => x.username),
      loser: winnerTeam === null ? [] : room.players.filter((x) => x.team !== winnerTeam).map((x) => x.username),
      crew: room.mode === 'coop' ? room.players.map((x) => x.username) : crewNames,
    };
    const endKey = room.mode === 'coop' ? room.sceneKey : (room.arrived[p.team]?.sceneKey ?? room.track[p.team].key);
    const own = room.scenario.scenes[endKey]?.endings;
    const endings: Record<string, string> = {};
    for (const k of ['win', 'loss', 'success', 'fail'] as const) {
      const v = own?.[k] ?? room.scenario.endings?.[k];
      if (v) endings[k] = fillTokens(pickVariant(v, textMode(room), room.format), names);
    }
    // only the marks this player's side (or the whole scene) earned belong in their epilogue
    const mine = (mark: string) => {
      const who = room.history.get(mark);
      return !!who && (room.mode === 'coop' || who.size === 0 || crewNames.some((n) => who.has(n)));
    };
    const epilogue = (room.scenario.epilogues ?? [])
      .filter((x) => mine(x.if))
      .map((x) => fillTokens(pickVariant(x.text, textMode(room), room.format), { ...names, holder: [...(room.history.get(x.if) ?? [])].filter((n) => room.mode === 'coop' || crewNames.includes(n)) }));
    getIo().to(`user:${p.userId}`).emit('encounter:finished', {
      roomId: room.id,
      mode: room.mode,
      results,
      endings,
      story: room.log[room.mode === 'coop' ? 0 : p.team] ?? [],
      epilogue,
      decider,
      bonus: bonusInfo,
    });
  }
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
      .update({ status: 'finished', finished_at: new Date().toISOString(), outcome: { winnerTeam, success, rounds, decidedByDice: decider.length > 0 } })
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
        // apply_stars is idempotent per (user, reason, game), so a retry can never pay twice
        if (r.refundStars > 0) await supabase.rpc('apply_stars', { p_user: r.userId, p_delta: r.refundStars, p_reason: 'game_refund', p_ref: room.id });
        if (r.winStars > 0) await supabase.rpc('apply_stars', { p_user: r.userId, p_delta: r.winStars, p_reason: 'game_win', p_ref: room.id });
        if (r.bonusStars > 0) await supabase.rpc('apply_stars', { p_user: r.userId, p_delta: r.bonusStars, p_reason: 'game_bonus', p_ref: room.id });
        await afterEncounter(r.userId, { solo: room.solo }); // also tells the client to refresh its stars
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
  await assertCanAfford(userId, entryCostOf(room)); // a rematch is a new game: it costs a new entry
  room.rematch.add(userId);
  io.to(`room:${room.id}`).emit('rematch:status', { ready: [...room.rematch] });
  if (room.rematch.size < room.capacity) return;
  // everyone said yes: make sure everyone can still pay before the new room is made, so nobody is left waiting in a dead room
  const short = await playersShort(room.players.map((p) => p.userId), entryCostOf(room));
  if (short.length) {
    room.rematch.clear();
    io.to(`room:${room.id}`).emit('room:aborted', { roomId: room.id, reason: 'not_enough_stars', refunded: false });
    return;
  }
  const next = await createRoom({
    hostId: room.hostId,
    mode: room.mode,
    format: room.format,
    solo: room.solo,
    players: room.players.map((p) => p.userId),
    avoid: room.scenario.id, // a rematch is a new story, not the one they just finished
  });
  io.to(`room:${room.id}`).emit('rematch:start', { roomId: next.id });
  for (const p of room.players) {
    io.in(`user:${p.userId}`).socketsLeave(`room:${room.id}`);
    await joinRoom(next, p.userId);
  }
}

/** Start a one-player game right away: no queue, no waiting. */
export async function startSolo(userId: string) {
  if (roomOfUser.has(userId)) throw new AppError(409, 'already_in_encounter');
  await assertCanAfford(userId, BALANCE.entryCost.solo);
  const room = await createRoom({ hostId: userId, mode: 'coop', format: '1v1', solo: true });
  await joinRoom(room, userId);
  return { roomId: room.id };
}
