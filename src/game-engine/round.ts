import type { Approach, Kind, Mode, Tier } from './types';

export type RoundRoll = { userId: string; team: number; approach: Approach; tier: Tier; margin: number };
export type RoundOutcome = {
  kind: Kind;
  winnerTeam: number | null;
  same: boolean;
  sameApproach: Approach | null;
  passers: string[];
  failers: string[];
};

const passed = (t: Tier) => t === 'win' || t === 'legendary';

export function resolveRound(mode: Mode, rolls: RoundRoll[]): RoundOutcome {
  const passers = rolls.filter((r) => passed(r.tier)).map((r) => r.userId);
  const failers = rolls.filter((r) => !passed(r.tier)).map((r) => r.userId);
  const same = rolls.length > 1 && rolls.every((r) => r.approach === rolls[0].approach);
  const base = { same, sameApproach: same ? rolls[0].approach : null, passers, failers };

  if (mode === 'coop') {
    const kind: Kind = failers.length === 0 ? 'all_pass' : passers.length === 0 ? 'all_fail' : 'mixed';
    return { ...base, kind, winnerTeam: null };
  }

  const side = (team: number) => {
    const mine = rolls.filter((r) => r.team === team);
    return { team, success: mine.some((r) => passed(r.tier)), margin: mine.reduce((s, r) => s + r.margin, 0) };
  };
  const [a, b] = [...new Set(rolls.map((r) => r.team))].map(side);
  if (!b) return { ...base, kind: 'tie', winnerTeam: null };
  // exactly one side succeeded: that side takes the scene
  if (a.success !== b.success) return { ...base, kind: 'decisive', winnerTeam: a.success ? a.team : b.team };
  // both succeeded or both failed: the bigger margin takes it
  if (a.margin === b.margin) return { ...base, kind: 'tie', winnerTeam: null };
  return { ...base, kind: a.success ? 'both_succeed' : 'both_fail', winnerTeam: a.margin > b.margin ? a.team : b.team };
}