import type { Approach, Kind, Mode } from './types';
import type { Effect } from './scenario';

export const APPROACH_LABEL: Record<Approach, string> = {
  charm: 'Charm',
  hustle: 'Hustle',
  gragra: 'Gra-Gra',
  wisdom: 'Wisdom',
};

export const joinNames = (names: string[]) =>
  names.length === 0 ? 'nobody' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;

export function fillTokens(text: string, v: { winner: string[]; loser: string[]; crew: string[] }) {
  return text
    .replaceAll('{winner}', joinNames(v.winner))
    .replaceAll('{loser}', joinNames(v.loser))
    .replaceAll('{crew}', joinNames(v.crew));
}

// The line that always states plainly what happened, including same-move clashes
export function resultLine(i: {
  mode: Mode;
  kind: Kind;
  same: boolean;
  approach: Approach | null;
  winner: string[];
  loser: string[];
  passers: string[];
  failers: string[];
}): string {
  const lead =
    i.same && i.approach
      ? i.mode === 'coop'
        ? `Everyone went ${APPROACH_LABEL[i.approach]}. `
        : `Same move on both sides: ${APPROACH_LABEL[i.approach]}. `
      : '';
  const w = joinNames(i.winner);
  const l = joinNames(i.loser);
  switch (i.kind) {
    case 'decisive':
      return `${lead}${w} pulled it off while ${l} came up short.`;
    case 'both_succeed':
      return `${lead}Both landed it, but ${w} did it cleaner.`;
    case 'both_fail':
      return `${lead}Both fumbled it. ${w} fumbled less.`;
    case 'tie':
      return `${lead}Dead level. Neither side blinked.`;
    case 'all_pass':
      return `${lead}Everyone came through.`;
    case 'mixed':
      return `${lead}${joinNames(i.passers)} carried it while ${joinNames(i.failers)} struggled.`;
    case 'all_fail':
      return `${lead}Nobody got it right.`;
  }
}

export type FX = { winner?: Effect; loser?: Effect; all?: Effect };

// Used when a scene does not define its own consequences
export function defaultEffects(kind: Kind): FX {
  switch (kind) {
    case 'decisive':
      return { winner: { mod: 1, label: 'Momentum' }, loser: { mod: -1, label: 'Rattled' } };
    case 'both_succeed':
      return { winner: { mod: 1, label: 'Edge' } };
    case 'both_fail':
      return { all: { mod: -1, label: 'Frazzled' } };
    case 'all_pass':
      return { all: { mod: 1, label: 'In the zone' } };
    case 'all_fail':
      return { all: { mod: -1, label: 'Shaken' } };
    default:
      return {};
  }
}