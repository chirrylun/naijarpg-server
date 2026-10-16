export const BALANCE = {
  roundSeconds: 40,
  resultDelayMs: 6500,
  maxRounds: 6,
  maxModifier: 3,
  maxTotalModifier: 4,
 minTotalModifier: -2,
  nudgeBonus: 2,
  starCost: { reroll: 1, nudge: 2, shield: 2 },
  points: { win: 25, draw: 12, loss: 5, coopSuccess: 20, coopFail: 8 },
  coopPassAvg: 1.5,
  referralStars: 10,
  chat: { maxLen: 500, declineCooldownHours: 24 },
  // placeholder prices, adjust freely
  packs: [
    { id: 's20', stars: 20, priceNaira: 500 },
    { id: 's60', stars: 60, priceNaira: 1200 },
    { id: 's150', stars: 150, priceNaira: 2500 },
  ],
} as const;