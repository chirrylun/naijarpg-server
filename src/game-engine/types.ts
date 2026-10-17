export const APPROACHES = ['charm', 'gragra', 'lie', 'wisdom'] as const;
export const TIERS = ['disaster', 'struggle', 'win', 'legendary'] as const;
export type Approach = (typeof APPROACHES)[number];
export type Tier = (typeof TIERS)[number];
export type StarPlay = 'reroll' | 'nudge' | 'shield';
export type Mode = 'rival' | 'coop' | 'team';
export type Format = '1v1' | '2v2';
export type Kind = 'decisive' | 'both_succeed' | 'both_fail' | 'tie' | 'all_pass' | 'mixed' | 'all_fail';