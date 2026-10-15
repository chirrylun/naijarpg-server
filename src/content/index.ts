import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { scenarioSchema, type Scenario } from '../game-engine/scenario';
import type { Mode } from '../game-engine/types';

// Reads from the project root, so deploy the repo with src/ (not only dist/)
const dir = path.join(process.cwd(), 'src', 'content', 'scenarios');

const scenarios: Scenario[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => scenarioSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))));

// Fail at startup if a scene points to a scene that doesn't exist
for (const s of scenarios) {
  if (!s.scenes[s.start]) throw new Error(`${s.id}: missing start scene`);
  for (const [key, scene] of Object.entries(s.scenes))
    for (const n of Object.values(scene.next))
      if (n && !s.scenes[n]) throw new Error(`${s.id}.${key}: unknown next scene "${n}"`);
}

export type { Scenario };
export const allScenarios = () => scenarios;
export const getScenario = (id: string) => scenarios.find((s) => s.id === id);

export function pickScenario(mode: Mode) {
  const pool = scenarios.filter((s) => s.modes.includes(mode));
  if (!pool.length) throw new Error(`No scenario supports mode ${mode}`);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Same scenario for everyone on a given Lagos day
export function dailyScenario() {
  const dayNumber = Math.floor(Date.now() / 86_400_000);
  return scenarios[dayNumber % scenarios.length];
}