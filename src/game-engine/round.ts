import type { Approach, Kind, Mode, Tier } from './types';

export type RoundRoll = { userId: string; team: number; approach: Approach; tier: Tier; margin: number; total: number; dc: number };
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
const bestBy = (rs: RoundRoll[], score: (r: RoundRoll) => number) =>
  rs.reduce<RoundRoll | null>((b, r) => (!b || score(r) > score(b) ? r : b), null);

/**
 * Duels: players whose roll is level at the top of both sides.
 * Empty when one side clearly rolled higher. The caller re-rolls these players until the tie breaks.
 */
export function duelTie(rolls: RoundRoll[]): string[] {
  const teams = [...new Set(rolls.map((r) => r.team))];
  if (teams.length < 2) return [];
  const tops = teams.map((t) => Math.max(...rolls.filter((r) => r.team === t).map((r) => r.total)));
  if (tops[0] !== tops[1]) return [];
  return rolls.filter((r) => r.total === tops[teams.indexOf(r.team)]).map((r) => r.userId);
}

/**
 * Co-op: everyone rolls against the difficulty, same as before.
 * Duels: the HIGHEST roll wins the scene. If the top rolls are level, the caller re-rolls and passes the
 * winning team in as `tiebreakTeam`. The scene's story route still depends on whether the winner (and the
 * loser) cleared the difficulty, so the story keeps its "close call" and "total mess" versions.
 */
export function resolveRound(mode: Mode, rolls: RoundRoll[], tiebreakTeam: number | null = null): RoundOutcome {
  // in a duel one shared bar is used for "did they pull it off", so a higher roll can never count as the worse result
  const bar = Math.min(...rolls.map((r) => r.dc));
  const pass = (r: RoundRoll) => (mode === 'coop' ? passed(r.tier) : r.total >= bar);
  const score = (r: RoundRoll) => (mode === 'coop' ? r.margin : r.total);

  const passers = rolls.filter(pass).map((r) => r.userId);
  const failers = rolls.filter((r) => !pass(r)).map((r) => r.userId);
  const same = rolls.length > 1 && rolls.every((r) => r.approach === rolls[0].approach);
  const base = { same, sameApproach: same ? rolls[0].approach : null, passers, failers };
  const leadOf = (ids: string[]) => {
    const b = bestBy(rolls.filter((r) => ids.includes(r.userId)), score);
    return b ? { userId: b.userId, approach: b.approach } : null;
  };

  if (mode === 'coop') {
    const kind: Kind = failers.length === 0 ? 'all_pass' : passers.length === 0 ? 'all_fail' : 'mixed';
    // when nobody passed, the best attempt still leads, so a failed move can branch the story by the move that failed
    return { ...base, kind, winnerTeam: null, winnerIds: passers, loserIds: failers, lead: leadOf(passers.length ? passers : failers) };
  }

  const finish = (kind: Kind, winnerTeam: number | null): RoundOutcome => {
    const winnerIds = winnerTeam === null ? [] : rolls.filter((r) => r.team === winnerTeam).map((r) => r.userId);
    const loserIds = winnerTeam === null ? [] : rolls.filter((r) => r.team !== winnerTeam).map((r) => r.userId);
    return { ...base, kind, winnerTeam, winnerIds, loserIds, lead: leadOf(winnerIds) };
  };
  const side = (team: number) => {
    const best = Math.max(...rolls.filter((r) => r.team === team).map((r) => r.total));
    return { team, best, pass: best >= bar };
  };

  const [a, b] = [...new Set(rolls.map((r) => r.team))].map(side);
  if (!b) return finish('tie', null);
  let win = a;
  if (a.best !== b.best) win = a.best > b.best ? a : b;
  else if (tiebreakTeam !== null) win = tiebreakTeam === a.team ? a : b;
  else return finish('tie', null); // only if the caller did not re-roll
  const lose = win === a ? b : a;
  return finish(win.pass ? (lose.pass ? 'both_succeed' : 'decisive') : 'both_fail', win.team);
}
