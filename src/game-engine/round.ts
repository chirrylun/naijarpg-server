import type { Mode, Tier } from './types';

export const POINTS: Record<Tier, number> = { disaster: 0, struggle: 1, win: 2, legendary: 3 };
const BY_POINTS: Tier[] = ['disaster', 'struggle', 'win', 'legendary'];

type Roll = { team: number; tier: Tier; total: number };

// Returns the "group tier" (drives which scene comes next) and the winning team (rival/team modes).
export function resolveRound(mode: Mode, rolls: Roll[]): { tier: Tier; winnerTeam: number | null } {
  if (mode === 'coop') {
    const avg = Math.floor(rolls.reduce((s, r) => s + POINTS[r.tier], 0) / rolls.length);
    return { tier: BY_POINTS[avg], winnerTeam: null };
  }
  const totals = new Map<number, number>();
  rolls.forEach((r) => totals.set(r.team, (totals.get(r.team) ?? 0) + r.total));
  const [a, b] = [...totals.entries()];
  if (!b || a[1] === b[1]) return { tier: 'struggle', winnerTeam: null };
  const winnerTeam = a[1] > b[1] ? a[0] : b[0];
  const best = Math.max(...rolls.filter((r) => r.team === winnerTeam).map((r) => POINTS[r.tier]));
  return { tier: BY_POINTS[best], winnerTeam };
}