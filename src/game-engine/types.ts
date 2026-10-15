export const APPROACHES = ['charm', 'hustle', 'gragra', 'wisdom'] as const;
export const TIERS = ['disaster', 'struggle', 'win', 'legendary'] as const;
export type Approach = (typeof APPROACHES)[number];
export type Tier = (typeof TIERS)[number];
export type StarPlay = 'reroll' | 'nudge' | 'shield';
export type Mode = 'rival' | 'coop' | 'team';
export type Format = '1v1' | '2v2';