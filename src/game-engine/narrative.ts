import type { Approach, Kind, Mode } from './types';

export const APPROACH_LABEL: Record<Approach, string> = {
  charm: 'Charm',
  hustle: 'Hustle',
  gragra: 'Lie',
  wisdom: 'Wisdom',
};

export const joinNames = (names: string[]) =>
  names.length === 0 ? 'nobody' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;

export function fillTokens(
  text: string,
  v: { winner: string[]; loser: string[]; crew: string[]; move?: string; holder?: string[] },
) {
  return text
    .replaceAll('{winner}', joinNames(v.winner))
    .replaceAll('{loser}', joinNames(v.loser))
    .replaceAll('{crew}', joinNames(v.crew))
    .replaceAll('{move}', v.move ?? 'move')
    .replaceAll('{holder}', joinNames(v.holder ?? []));
}

// The line that always states plainly what happened
export function resultLine(i: {
  mode: Mode;
  kind: Kind;
  same: boolean;
  approach: Approach | null;
  winner: string[];
  loser: string[];
  passers: string[];
  failers: string[];
  move?: string;
  solo?: boolean;
}): string {
  const lead =
    !i.solo && i.same && i.approach
      ? i.mode === 'coop'
        ? `Everyone went ${APPROACH_LABEL[i.approach]}. `
        : `Same move on both sides: ${APPROACH_LABEL[i.approach]}. `
      : '';
  const w = joinNames(i.winner);
  const l = joinNames(i.loser);
  let main = '';
  switch (i.kind) {
    case 'decisive':
      main = `${lead}${w} pulled it off while ${l} came up short.`;
      break;
    case 'both_succeed':
      main = `${lead}Both landed it, but ${w} did it cleaner.`;
      break;
    case 'both_fail':
      main = `${lead}Both fumbled it. ${w} fumbled less.`;
      break;
    case 'tie':
      main = `${lead}Dead level. Neither side blinked.`;
      break;
    case 'all_pass':
      main = i.solo ? 'You pulled it off.' : `${lead}Everyone came through.`;
      break;
    case 'mixed':
      main = `${lead}${joinNames(i.passers)} carried it while ${joinNames(i.failers)} struggled.`;
      break;
    case 'all_fail':
      main = i.solo ? "It didn't work out." : `${lead}Nobody got it right.`;
      break;
  }
  const deciding = i.kind === 'decisive' || i.kind === 'both_succeed' || i.kind === 'both_fail';
  const tail = i.move && i.mode !== 'coop' && deciding ? ` ${w}'s ${i.move} decided it.` : '';
  return main + tail;
}