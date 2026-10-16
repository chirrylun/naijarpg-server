import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { scenarioSchema, type Scenario } from '../game-engine/scenario';
import type { Format, Mode } from '../game-engine/types';

const dir = path.join(process.cwd(), 'src', 'content', 'scenarios');

const scenarios: Scenario[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => scenarioSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))));

// Every scene must say what happens for every outcome of every mode the scenario supports
const NEED: Record<Mode, string[]> = {
  rival: ['decisive', 'both_succeed', 'both_fail', 'tie'],
  team: ['decisive', 'both_succeed', 'both_fail', 'tie'],
  coop: ['all_pass', 'mixed', 'all_fail'],
};

for (const s of scenarios) {
  if (!s.scenes[s.start]) throw new Error(`${s.id}: missing start scene`);
  for (const [key, scene] of Object.entries(s.scenes)) {
    const n = scene.next as Record<string, unknown>;
    for (const mode of s.modes)
      for (const k of NEED[mode])
        if (n[k] === undefined && n.default === undefined) throw new Error(`${s.id}.${key}: no outcome for "${k}" (${mode})`);
    for (const e of Object.values(n)) {
      const to = typeof e === 'string' ? e : e && typeof e === 'object' ? (e as { to: string | null }).to : null;
      if (to && !s.scenes[to]) throw new Error(`${s.id}.${key}: unknown next scene "${to}"`);
    }
  }
}

export type { Scenario };
export const allScenarios = () => scenarios;
export const getScenario = (id: string) => scenarios.find((s) => s.id === id);
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