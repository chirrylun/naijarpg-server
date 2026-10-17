export const BALANCE = {
  roundSeconds: 40,
  resultDelayMs: 6500,
  tieRerollMs: 2600, // extra reveal time for each tie-break re-roll
  maxRounds: 8,
  maxModifier: 3,
  maxTotalModifier: 4,
  minTotalModifier: -3,
  nudgeBonus: 2,
  starCost: { reroll: 1, nudge: 2, shield: 2 },
  points: { win: 25, draw: 12, loss: 5, coopSuccess: 20, coopFail: 8 },
  coopPassAvg: 1.5,
  useStats: false,
  edgeSeconds: 18,
  referralStars: 10,
  chat: { maxLen: 500, declineCooldownHours: 24 },
  // placeholder prices, adjust freely
    packs: [
    { id: 's8', stars: 8, priceNaira: 200 },
    { id: 's20', stars: 20, priceNaira: 500 },
    { id: 's60', stars: 60, priceNaira: 1200 },
    { id: 's150', stars: 150, priceNaira: 2500 },
  ],
} as const;