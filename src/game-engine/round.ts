import type { Approach, Kind, Mode, Tier } from './types';

export type RoundRoll = { userId: string; team: number; approach: Approach; tier: Tier; margin: number };
export type RoundOutcome = {
  kind: Kind;
  winnerTeam: number | null;
  same: boolean;
  sameApproach: Approach | null;
  passers: string[];
  failers: string[];
  winnerIds: string[]; // duel: the winning side. co-op: everyone who passed
  loserIds: string[]; // duel: the losing side. co-op: everyone who failed
  lead: { userId: string; approach: Approach } | null; // the move that decided the scene
};

const passed = (t: Tier) => t === 'win' || t === 'legendary';
const best = (rs: RoundRoll[]) => rs.reduce<RoundRoll | null>((b, r) => (!b || r.margin > b.margin ? r : b), null);

export function resolveRound(mode: Mode, rolls: RoundRoll[]): RoundOutcome {
  const passers = rolls.filter((r) => passed(r.tier)).map((r) => r.userId);
  const failers = rolls.filter((r) => !passed(r.tier)).map((r) => r.userId);
  const same = rolls.length > 1 && rolls.every((r) => r.approach === rolls[0].approach);
  const base = { same, sameApproach: same ? rolls[0].approach : null, passers, failers };
  const leadOf = (ids: string[]) => {
    const b = best(rolls.filter((r) => ids.includes(r.userId)));
    return b ? { userId: b.userId, approach: b.approach } : null;
  };

  if (mode === 'coop') {
    const kind: Kind = failers.length === 0 ? 'all_pass' : passers.length === 0 ? 'all_fail' : 'mixed';
    return { ...base, kind, winnerTeam: null, winnerIds: passers, loserIds: failers, lead: leadOf(passers) };
  }

  const side = (team: number) => {
    const mine = rolls.filter((r) => r.team === team);
    return { team, success: mine.some((r) => passed(r.tier)), margin: mine.reduce((s, r) => s + r.margin, 0) };
  };
  const finish = (kind: Kind, winnerTeam: number | null): RoundOutcome => {
    const winnerIds = winnerTeam === null ? [] : rolls.filter((r) => r.team === winnerTeam).map((r) => r.userId);
    const loserIds = winnerTeam === null ? [] : rolls.filter((r) => r.team !== winnerTeam).map((r) => r.userId);
    return { ...base, kind, winnerTeam, winnerIds, loserIds, lead: leadOf(winnerIds) };
  };

  const [a, b] = [...new Set(rolls.map((r) => r.team))].map(side);
  if (!b) return finish('tie', null);
  // exactly one side succeeded: that side takes the scene
  if (a.success !== b.success) return finish('decisive', a.success ? a.team : b.team);
  // both succeeded or both failed: the bigger margin takes it
  if (a.margin === b.margin) return finish('tie', null);
  return finish(a.success ? 'both_succeed' : 'both_fail', a.margin > b.margin ? a.team : b.team);
}