import { z } from 'zod';
import { APPROACHES } from './types';
import type { Format, Kind, Mode } from './types';

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

// What carries into the next round: a modifier on the next roll plus a label players can see
const effect = z.object({ mod: z.number().int().min(-2).max(2), label: z.string() });
export type Effect = z.infer<typeof effect>;

const edge = z.union([
  z.string(), // next scene
  z.null(), // encounter ends
  z.object({
    to: z.string().nullable(),
    recap: variants.optional(), // story line shown at the top of the next scene
    winner: effect.optional(),
    loser: effect.optional(),
    all: effect.optional(),
  }),
]);
export type Edge = z.infer<typeof edge>;

const next = z.object({
  default: edge.optional(),
  same: edge.optional(), // everyone chose the same approach
  decisive: edge.optional(),
  both_succeed: edge.optional(),
  both_fail: edge.optional(),
  tie: edge.optional(),
  all_pass: edge.optional(),
  mixed: edge.optional(),
  all_fail: edge.optional(),
});

const scene = z.object({
  title: variants,
  text: variants,
  stakes: variants.optional(),
  choices: z
    .array(
      z.object({
        approach: z.enum(APPROACHES),
        label: variants,
        dc: z.number().int().min(5).max(25),
      }),
    )
    .min(2),
  next,
});

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  modes: z.array(z.enum(['rival', 'team', 'coop'])).min(1),
  formats: z.array(z.enum(['1v1', '2v2'])).default(['1v1', '2v2']),
  start: z.string(),
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
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Scene = Scenario['scenes'][string];
export type ResolvedEdge = { to: string | null; recap?: Variants; winner?: Effect; loser?: Effect; all?: Effect };

export function pickEdge(sc: Scene, kind: Kind, same: boolean): ResolvedEdge {
  const n = sc.next;
  // a "same move" scene only fires when somebody actually succeeded, so it never contradicts a failure
  const useSame = same && kind !== 'both_fail' && kind !== 'all_fail';
  const found = [useSame ? n.same : undefined, n[kind], n.default].find((e) => e !== undefined);
  if (found === undefined || found === null) return { to: null };
  if (typeof found === 'string') return { to: found };
  return found;
}