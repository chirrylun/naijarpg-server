import { BALANCE } from '../config/balance';
import { d20 } from './dice';
import type { StarPlay, Tier } from './types';

export type RollState = {
  dc: number;
  die: number; // the die that counts
  dice: number[]; // every die rolled (two after a Reroll)
  modifier: number;
  starBonus: number;
  total: number;
  tier: Tier;
  margin: number;
  shielded: boolean;
};

function tierFor(die: number, total: number, dc: number): Tier {
  if (die === 1) return 'disaster';
  if (die === 20) return 'legendary';
  if (total >= dc + 6) return 'legendary';
  if (total >= dc) return 'win';
  if (total >= dc - 4) return 'struggle';
  return 'disaster';
}

function build(dc: number, dice: number[], modifier: number, starBonus: number, shield: boolean): RollState {
  const die = Math.max(...dice);
  const total = die + modifier + starBonus;
  let tier = tierFor(die, total, dc);
  let margin = total - dc;
  let shielded = false;
  // Shield only does something when the roll would fail
  if (shield && tier !== 'win' && tier !== 'legendary') {
    shielded = true;
    if (tier === 'disaster') tier = 'struggle';
    margin = Math.max(margin, -1);
  }
  return { dc, die, dice, modifier, starBonus, total, tier, margin, shielded };
}

/** The plain roll, before any edge */
export function rollBase(input: { modifier: number; dc: number; rng?: () => number }): RollState {
  const rng = input.rng ?? d20;
  const modifier = Math.max(BALANCE.minTotalModifier, Math.min(input.modifier, BALANCE.maxTotalModifier));
  return build(input.dc, [rng()], modifier, 0, false);
}

/** One edge per round, applied after the player has seen their roll */
export function applyEdge(r: RollState, edge: StarPlay, rng: () => number = d20): RollState {
  if (edge === 'reroll') return build(r.dc, [...r.dice, rng()], r.modifier, 0, false);
  if (edge === 'nudge') return build(r.dc, r.dice, r.modifier, BALANCE.nudgeBonus, false);
  return build(r.dc, r.dice, r.modifier, 0, true);
}