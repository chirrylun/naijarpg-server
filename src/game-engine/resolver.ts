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
  const first = rng();
  const second = input.star === 'reroll' ? rng() : null;
  const die = second === null ? first : Math.max(first, second);
  const modifier = Math.max(BALANCE.minTotalModifier, Math.min(input.modifier, BALANCE.maxTotalModifier));
  const starBonus = input.star === 'nudge' ? BALANCE.nudgeBonus : 0;
  const total = die + modifier + starBonus;

  let tier = tierFor(die, total, input.dc);
  let margin = total - input.dc;
  let shielded = false;
  // Shield only matters when the roll would fail: the miss is softened, and (see rooms.ts)
  // no penalty carries into the next scene
  if (input.star === 'shield' && tier !== 'win' && tier !== 'legendary') {
    shielded = true;
    if (tier === 'disaster') tier = 'struggle';
    margin = Math.max(margin, -1);
  }
  return { die, dice: second === null ? [first] : [first, second], modifier, starBonus, total, tier, margin, shielded };
}