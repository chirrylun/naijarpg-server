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
    '1v1': z.string().optional(),
    '2v2': z.string().optional(),
    rival_1v1: z.string().optional(),
    team_2v2: z.string().optional(),
    coop_1v1: z.string().optional(),
    coop_2v2: z.string().optional(),
  }),
]);
export type Variants = z.infer<typeof variants>;

export function pickVariant(v: Variants | undefined, mode: Mode, format: Format): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  const o = v as Record<string, string | undefined>;
  return o[`${mode}_${format}`] ?? o[mode] ?? o[format] ?? v.default;
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
});

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  modes: z.array(z.enum(['rival', 'team', 'coop'])).min(1),
  formats: z.array(z.enum(['1v1', '2v2'])).default(['1v1', '2v2']),
  start: z.string(),
  marks: z.record(z.string(), markDef).default({}),
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

export function pickEdge(sc: Scene, kind: Kind, same: boolean, lead: Approach | null): ResolvedEdge {
  const n = sc.next;
  // a "same move" route only fires when somebody actually succeeded
  const useSame = same && kind !== 'both_fail' && kind !== 'all_fail';
  const order: (keyof typeof n)[] = [...(useSame ? (['same'] as const) : []), kind, ...(ALSO[kind] ?? []), 'default'];
  for (const k of order) {
    const r = resolveEdge(n[k], lead);
    if (r) return r;
  }
  return { to: null };
}