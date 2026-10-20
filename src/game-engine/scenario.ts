import { z } from 'zod';
import { APPROACHES } from './types';
import type { Approach, Format, Kind, Mode } from './types';

// Text that can change with the match type: pick by mode+format, then mode, then format, then default
const variants = z.union([
  z.string(),
  z.object({
    default: z.string(),
    rival: z.string().optional(),
    team: z.string().optional(),
    coop: z.string().optional(),
    solo: z.string().optional(), // one-player games (falls back to the co-op text)
    '1v1': z.string().optional(),
    '2v2': z.string().optional(),
    rival_1v1: z.string().optional(),
    team_2v2: z.string().optional(),
    coop_1v1: z.string().optional(),
    coop_2v2: z.string().optional(),
  }),
]);
export type Variants = z.infer<typeof variants>;

export function pickVariant(v: Variants | undefined, mode: Mode | 'solo', format: Format): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  const o = v as Record<string, string | undefined>;
  return o[`${mode}_${format}`] ?? o[mode] ?? (mode === 'solo' ? o.coop : undefined) ?? o[format] ?? v.default;
}

// A mark is a piece of story state attached to a player (or the whole scene)
const markDef = z.object({
  label: z.string(),
  tip: z.string(),
  rounds: z.number().int().min(1).max(6).default(2), // how many following rounds it lasts
});

// winner/loser: in a duel, the winning/losing side. In co-op: whoever passed / whoever failed.
// lead: the single best roller on the winning side. world: shared by everyone in the scene.
const grant = z.object({
  mark: z.string(),
  to: z.enum(['winner', 'loser', 'all', 'lead', 'world']),
});

const leaf = z.object({
  to: z.string().nullable(), // next scene, or null to end
  recap: variants.optional(), // story line shown at the top of the next scene
  set: z.array(grant).optional(),
});
const plain = z.union([z.string(), z.null(), leaf]);

// "What the winner did decides what happens". Keys are the winning move, plus an optional default.
const byMove = z
  .strictObject({
    charm: plain.optional(),
    hustle: plain.optional(),
    gragra: plain.optional(),
    wisdom: plain.optional(),
    default: plain.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'empty move map');

const edge = z.union([leaf, z.string(), z.null(), byMove]);

const next = z.strictObject({
  default: edge.optional(),
  same: edge.optional(), // everyone chose the same move
  decisive: edge.optional(), // one side took the scene (also used for co-op all_pass / mixed, and both_succeed)
  both_succeed: edge.optional(),
  both_fail: edge.optional(), // also used for co-op all_fail
  tie: edge.optional(),
  all_pass: edge.optional(),
  mixed: edge.optional(),
  all_fail: edge.optional(),
});

const who = z.enum(['self', 'rival', 'world']).default('self');
const modRule = z.object({ mark: z.string(), dc: z.number().int().min(-5).max(5), who }); // negative = easier
const lockRule = z.object({ mark: z.string(), reason: z.string(), who });

const choice = z.object({
  approach: z.enum(APPROACHES),
  label: variants,
  dc: z.number().int().min(5).max(25),
  mods: z.array(modRule).optional(),
  lock: lockRule.optional(),
});

const scene = z.object({
  title: variants,
  text: variants,
  stakes: variants.optional(),
  twists: z.array(z.object({ if: z.string(), text: variants })).optional(), // shown when someone holds the mark; {holder} = their name
  choices: z.array(choice).min(2),
  next,
  // Race games, final scenes only: how well this road ends (0 = worst, 3 = best). Decides who got home better.
  finish: z.number().int().min(0).max(3).optional(),
  // Race games, final scenes only: the closing paragraph for a player who ENDS on this scene (falls back to scenario endings)
  endings: z
    .object({ win: variants.optional(), loss: variants.optional(), success: variants.optional(), fail: variants.optional() })
    .optional(),
});

// One optional story bonus per scenario. You keep it until you earn one of the "lostBy" marks.
const bonusDef = z.object({
  label: z.string(), // shown on the meter, e.g. "Keep your cash"
  lostBy: z.array(z.string()).min(1),
  lostMessage: z.string(), // shown at the moment it is lost
  earnedLine: z.string(), // results screen, when kept
});

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  modes: z.array(z.enum(['rival', 'team', 'coop'])).min(1),
  formats: z.array(z.enum(['1v1', '2v2'])).default(['1v1', '2v2']),
  start: z.string(),
  marks: z.record(z.string(), markDef).default({}),
  bonus: bonusDef.optional(),
  scenes: z.record(z.string(), scene),
  endings: z
    .object({
      win: variants.optional(),
      loss: variants.optional(),
      draw: variants.optional(),
      success: variants.optional(),
      fail: variants.optional(),
    })
    .optional(),
  epilogues: z.array(z.object({ if: z.string(), text: variants })).optional(), // closing lines for marks earned during the game
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Scene = Scenario['scenes'][string];
export type Leaf = z.infer<typeof leaf>;
export type Edge = z.infer<typeof edge>;
export type ResolvedEdge = { to: string | null; recap?: Variants; set?: Leaf['set'] };

function toLeaf(v: string | null | Leaf): ResolvedEdge {
  if (v === null) return { to: null };
  if (typeof v === 'string') return { to: v };
  return v;
}

function resolveEdge(e: Edge | undefined, lead: Approach | null): ResolvedEdge | undefined {
  if (e === undefined) return undefined;
  if (e === null || typeof e === 'string') return toLeaf(e);
  if ('to' in e) return toLeaf(e as Leaf);
  const m = e as Partial<Record<Approach | 'default', string | null | Leaf>>;
  const v = lead && m[lead] !== undefined ? m[lead] : m.default;
  return v === undefined ? undefined : toLeaf(v);
}

/** Every destination an edge can lead to (used to validate scenario files at startup). */
export function edgeLeaves(e: Edge | undefined): ResolvedEdge[] {
  if (e === undefined) return [];
  if (e === null || typeof e === 'string') return [toLeaf(e)];
  if ('to' in e) return [toLeaf(e as Leaf)];
  return Object.values(e as Record<string, string | null | Leaf | undefined>)
    .filter((v) => v !== undefined)
    .map((v) => toLeaf(v as string | null | Leaf));
}

// co-op outcomes borrow the duel routes, so one set of authored routes serves both modes
const ALSO: Partial<Record<Kind, Kind[]>> = {
  both_succeed: ['decisive'],
  all_pass: ['decisive'],
  mixed: ['decisive'],
  all_fail: ['both_fail'],
};

/** Every scene (or null = the story ends) that a route could lead to: the move that decided it first, then the default, then the other moves. */
function destinationsOf(e: Edge | undefined, lead: Approach | null): (string | null)[] {
  if (e === undefined) return [];
  if (e === null || typeof e === 'string') return [e];
  if ('to' in e) return [(e as Leaf).to];
  const m = e as Partial<Record<Approach | 'default', string | null | Leaf>>;
  const keys = [...(lead ? [lead] : []), 'default', ...APPROACHES.filter((a) => a !== lead)] as const;
  return keys.flatMap((k) => (m[k] === undefined ? [] : [toLeaf(m[k] as string | null | Leaf).to]));
}

/**
 * Where the story goes next.
 *
 * What the player reads (the story line) and the marks they earn ALWAYS come from the route for the move they played and
 * how it went. Only the destination can change, and only when `allow` rules the written destination out (a scene
 * already played, or one that can't reach an ending before the last round). Then, in this order:
 *   1. another destination for the same result (the other moves' routes, the default),
 *   2. any other destination from this scene (only when every one for this result is ruled out).
 * `allow` can be a list of rules, strictest first: the first rule that leaves a destination is used.
 * With no `allow`, or when nothing is ruled out, the route written in the scenario file is used exactly.
 */
export function pickEdge(
  sc: Scene,
  kind: Kind,
  same: boolean,
  lead: Approach | null,
  allow?: ((to: string) => boolean) | ((to: string) => boolean)[],
): ResolvedEdge {
  const n = sc.next;
  // a "same move" route only fires when somebody actually succeeded
  const useSame = same && kind !== 'both_fail' && kind !== 'all_fail';
  const order: (keyof typeof n)[] = [...(useSame ? (['same'] as const) : []), kind, ...(ALSO[kind] ?? []), 'default'];

  let written: ResolvedEdge | undefined;
  for (const k of order) {
    written = resolveEdge(n[k], lead);
    if (written) break;
  }
  if (!written) return { to: null };
  if (written.to === null || !allow) return written;

  const sameResult = order.flatMap((k) => destinationsOf(n[k], lead));
  const anywhere = Object.values(n).flatMap((e) => destinationsOf(e, lead));
  const rules = Array.isArray(allow) ? allow : [allow];
  const ok = (to: string | null, rule: (to: string) => boolean) => to === null || rule(to);

  for (const pool of [[written.to, ...sameResult], anywhere]) {
    for (const rule of rules) {
      const to = pool.find((d) => ok(d, rule));
      if (to !== undefined) return to === written.to ? written : { ...written, to };
    }
  }
  return { ...written, to: null };
}

const outCache = new WeakMap<Scenario, Record<string, (string | null)[]>>();
const targetsOf = (s: Scenario) => {
  let hit = outCache.get(s);
  if (!hit) {
    hit = Object.fromEntries(
      Object.entries(s.scenes).map(([k, sc]) => [k, Object.values(sc.next as Record<string, Edge | undefined>).flatMap(edgeLeaves).map((l) => l.to)]),
    );
    outCache.set(s, hit);
  }
  return hit;
};

/**
 * The fewest scenes (this one included) that must still be played, starting at `from`, before the story can end,
 * without stepping on a scene in `avoid` (the ones already played). Infinity when every way on leads back to one of those.
 * A scene that can end the story straight away counts as 1.
 */
export function stepsToEnd(s: Scenario, from: string, avoid: ReadonlySet<string> = new Set()): number {
  const outs = targetsOf(s);
  const seen = new Set<string>([from, ...avoid]);
  let frontier = [from];
  for (let steps = 1; frontier.length; steps++) {
    const next: string[] = [];
    for (const k of frontier) {
      const to = outs[k] ?? [];
      if (!to.length || to.some((t) => t === null || !(t in outs))) return steps;
      for (const t of to) {
        if (t && !seen.has(t)) {
          seen.add(t);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}

/**
 * The rules a road's next scene must meet, strictest first: not played before AND able to reach an ending in the
 * rounds left; then not played before and not a dead end; then just not played before.
 */
export function routeRules(s: Scenario, played: ReadonlySet<string>, roundsLeft: number) {
  return [
    (to: string) => !played.has(to) && stepsToEnd(s, to, played) <= roundsLeft,
    (to: string) => !played.has(to) && stepsToEnd(s, to, played) !== Infinity,
    (to: string) => !played.has(to),
  ];
}

/** Routes that lead back to a scene already passed on the way (each one is a loop a player could walk round). */
export function findLoops(s: Scenario): string[] {
  const out = Object.fromEntries(
    Object.entries(s.scenes).map(([k, sc]) => [k, [...new Set(Object.values(sc.next as Record<string, Edge | undefined>).flatMap(edgeLeaves).map((l) => l.to))]]),
  );
  const loops = new Set<string>();
  const state: Record<string, 1 | 2> = {}; // 1 = on the current path, 2 = fully explored
  const walk = (k: string, path: string[]) => {
    state[k] = 1;
    const here = [...path, k];
    for (const to of out[k] ?? []) {
      if (!to || !out[to]) continue;
      if (state[to] === 1) loops.add([...here.slice(here.indexOf(to)), to].join(' -> '));
      else if (!state[to]) walk(to, here);
    }
    state[k] = 2;
  };
  walk(s.start, []);
  return [...loops];
}