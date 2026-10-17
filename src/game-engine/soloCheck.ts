import { edgeLeaves, type Edge, type Scenario } from './scenario';

type V = string | Record<string, string | undefined> | undefined;

/** The text a one-player game would actually show for this field. */
const soloText = (v: V): string => (typeof v === 'string' ? v : v ? (v.solo ?? v.coop ?? v.default ?? '') : '');
const hasSolo = (v: V) => typeof v === 'object' && v !== null && typeof v.solo === 'string';

/**
 * One-player games are played on the co-op route, so they read the "solo" text and then fall back to the "coop" text.
 * That fallback is fine for most lines (co-op text is written as "you"), but a line that talks about a partner or a
 * rival makes no sense with nobody else there. This returns every such line that has no "solo" version.
 * An empty list means the scenario is safe to play alone.
 */
export function soloProblems(s: Scenario): string[] {
  if (!s.modes.includes('coop')) return []; // solo runs on co-op, so only co-op scenarios can be played alone
  const bad: string[] = [];
  const check = (where: string, v: V) => {
    if (hasSolo(v)) return;
    const t = soloText(v);
    const tokens = ['{partner}', '{rival}', '{loser}'].filter((k) => t.includes(k));
    if (tokens.length) bad.push(`${s.id}.${where}: uses ${tokens.join(', ')} but has no "solo" version`);
  };
  for (const [key, scene] of Object.entries(s.scenes)) {
    check(`${key}.title`, scene.title as V);
    check(`${key}.text`, scene.text as V);
    check(`${key}.stakes`, scene.stakes as V);
    scene.choices.forEach((c, i) => check(`${key}.choices[${i}].label`, c.label as V));
    for (const [kind, e] of Object.entries(scene.next as Record<string, Edge | undefined>)) {
      for (const l of edgeLeaves(e)) if (l.recap) check(`${key}.next.${kind}.recap`, l.recap as V);
    }
  }
  // a solo player either makes it or doesn't, so only these two endings are ever shown
  for (const k of ['success', 'fail'] as const) check(`endings.${k}`, s.endings?.[k] as V);
  s.epilogues?.forEach((x, i) => check(`epilogues[${i}]`, x.text as V));
  return bad;
}
