import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { edgeLeaves, scenarioSchema, type Edge, type Scenario } from '../game-engine/scenario';
import { soloProblems } from '../game-engine/soloCheck';
import type { Format, Mode } from '../game-engine/types';

const dir = path.join(process.cwd(), 'src', 'content', 'scenarios');

const scenarios: Scenario[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    try {
      return scenarioSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
    } catch (e) {
      throw new Error(`Scenario file ${f} is invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

for (const s of scenarios) {
  const fail = (where: string, msg: string) => {
    throw new Error(`${s.id}.${where}: ${msg}`);
  };
  const mark = (id: string, where: string) => {
    if (!s.marks[id]) fail(where, `unknown mark "${id}"`);
  };
  if (!s.scenes[s.start]) fail('start', 'missing start scene');

  for (const [key, scene] of Object.entries(s.scenes)) {
    const n = scene.next as Record<string, Edge | undefined>;
    const has = (...ks: string[]) => ks.some((k) => n[k] !== undefined) || n.default !== undefined;
    if (s.modes.includes('rival') || s.modes.includes('team')) {
      if (!has('decisive')) fail(key, 'needs a "decisive" route (or default)');
      if (!has('both_fail')) fail(key, 'needs a "both_fail" route (or default)');
      if (!has('tie')) fail(key, 'needs a "tie" route (or default)');
    }
    if (s.modes.includes('coop')) {
      if (!has('decisive', 'all_pass')) fail(key, 'needs a "decisive" route for co-op');
      if (!has('both_fail', 'all_fail')) fail(key, 'needs a "both_fail" route for co-op');
    }
    const isEnd = Object.values(n).every((e) => edgeLeaves(e).every((l) => l.to === null));
    if (isEnd && (s.modes.includes('rival') || s.modes.includes('team')) && scene.finish === undefined) fail(key, 'final scene needs "finish" (0-3) for race modes');
    for (const e of Object.values(n)) {
      for (const l of edgeLeaves(e)) {
        if (l.to && !s.scenes[l.to]) fail(key, `unknown next scene "${l.to}"`);
        for (const g of l.set ?? []) mark(g.mark, key);
      }
    }
    for (const c of scene.choices) {
      c.mods?.forEach((m) => mark(m.mark, key));
      if (c.lock) mark(c.lock.mark, key);
    }
    scene.twists?.forEach((t) => mark(t.if, key));
  }
  s.epilogues?.forEach((x) => mark(x.if, 'epilogues'));
  s.bonus?.lostBy.forEach((m) => mark(m, 'bonus'));

  // one-player games run on the co-op route: refuse to start if a line would mention a partner who isn't there
  const solo = soloProblems(s);
  if (solo.length) throw new Error(`Scenario ${s.id} is not safe for solo play:\n  ${solo.join('\n  ')}`);
}

export type { Scenario };
export const allScenarios = () => scenarios;
export const getScenario = (id: string) => scenarios.find((x) => x.id === id);
export const supports = (s: Scenario, mode: Mode, format: Format) => s.modes.includes(mode) && s.formats.includes(format);

export function pickScenario(mode: Mode, format: Format) {
  const pool = scenarios.filter((s) => supports(s, mode, format));
  if (!pool.length) throw new Error(`No scenario supports ${mode} ${format}`);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Same scenario for everyone on a given day
export function dailyScenario() {
  const dayNumber = Math.floor(Date.now() / 86_400_000);
  return scenarios[dayNumber % scenarios.length];
}