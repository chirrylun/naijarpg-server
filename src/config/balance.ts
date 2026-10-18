export const BALANCE = {
  roundSeconds: 40,
  resultDelayMs: 6500,
  tieRerollMs: 2600, // extra reveal time for each tie-break re-roll
  maxRounds: 6, // every path through the current stories is exactly 4 scenes
  maxModifier: 3,
  maxTotalModifier: 4,
  minTotalModifier: -3,
  nudgeBonus: 2,
  starCost: { reroll: 1, nudge: 2, shield: 2 },
  points: { win: 25, draw: 12, loss: 5, coopSuccess: 20, coopFail: 8 }, // draw is no longer used: every duel has a winner
  soloSuccess: 15, // playing alone: fewer points and stars, so it can't be farmed
  soloFail: 5,
  soloWinStars: 1,
  winStars: 2, // stars for winning a game (Link Up: for making it)
  bonus: { stars: 1, points: 5 }, // the story bonus, earned win or lose
  dailyGameStarCap: 6, // most stars a player can earn from games in one Lagos day
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