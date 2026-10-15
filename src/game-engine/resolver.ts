import { BALANCE } from '../config/balance';
import { d20 } from './dice';
import type { StarPlay, Tier } from './types';

function tierFor(die: number, total: number, dc: number): Tier {
  if (die === 1) return 'disaster';
  if (die === 20) return 'legendary';
  if (total >= dc + 6) return 'legendary';
  if (total >= dc) return 'win';
  if (total >= dc - 4) return 'struggle';
  return 'disaster';
}

export function resolveRoll(input: { modifier: number; dc: number; star?: StarPlay; rng?: () => number }) {
  const rng = input.rng ?? d20;
  let die = rng();
  if (input.star === 'reroll') die = Math.max(die, rng());
  const modifier = Math.min(input.modifier, BALANCE.maxModifier);
  const starBonus = input.star === 'nudge' ? BALANCE.nudgeBonus : 0;
  const total = die + modifier + starBonus;
  let tier = tierFor(die, total, input.dc);
  if (input.star === 'shield' && tier === 'disaster') tier = 'struggle';
  return { die, modifier, starBonus, total, tier };
}