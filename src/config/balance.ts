export const BALANCE = {
  roundSeconds: 40,
  resultDelayMs: 6500,
  tieRerollMs: 2600, // extra reveal time for each tie-break re-roll
  maxRounds: 6, // a game ends at a real ending, or here. Routes are steered so a game can always reach an ending in time
  maxModifier: 3,
  maxTotalModifier: 4,
  minTotalModifier: -3,
  nudgeBonus: 2,
  starCost: { reroll: 1, nudge: 2, shield: 2 },
  points: { win: 25, draw: 12, loss: 5, coopSuccess: 20, coopFail: 8 }, // draw is no longer used: every duel has a winner
  soloSuccess: 15, // playing alone: fewer points, so it can't be farmed
  soloFail: 5,

  // ---- STAR ECONOMY ----
  // Stars are the ticket into a game. Everyone is charged the moment a game really starts (never while waiting
  // for an opponent), and refunded if the game is cancelled before round 1 is played.
  entryCost: { solo: 1, duel: 2, coop: 2 },
  // The TOTAL a winner gets back. The entry comes back first; whatever is left is profit.
  //   duel: both players put in 2 (4 in the pot), the winner takes 3, the house keeps 1.
  //   coop: a success pays 3 to each player, a fail pays 0.
  //   solo: a success only returns the entry (breakeven), so solo is "free if you win" and can't be farmed.
  payout: { solo: 1, duel: 3, coop: 3 },
  bonus: { stars: 0, points: 5 }, // the story bonus is points only now
  dailyGameStarCap: 6, // most PROFIT stars a player can earn from games + streak in one Lagos day (the entry coming back doesn't count)
  streakMaxStars: 2, // streak bonus: 1 star on day 1, 2 stars from day 2 on
  comebackStars: 1, // one free star a day, only claimable at 0 stars, so nobody is locked out
  firstPurchaseBonus: 2, // extra stars on a player's very first pack
  referralStars: 5, // each, once the friend has finished referralMinGames real games
  referralMinGames: 2, // 2 (not 3): a new player's 5 starting stars pay for exactly two duels
  coopPassAvg: 1.5,
  useStats: false,
  storyMods: false, // story marks change the number you need to roll. Off for now; set true to bring them back
  soloDcEase: 2, // playing alone: every number you need is this much lower, so a solo run is winnable
  edgeSeconds: 18,
  chat: { maxLen: 500, declineCooldownHours: 24 },
  // placeholder prices, adjust freely
  packs: [
    { id: 's8', stars: 8, priceNaira: 200 },
    { id: 's20', stars: 20, priceNaira: 500 },
    { id: 's60', stars: 60, priceNaira: 1200 },
    { id: 's150', stars: 150, priceNaira: 2500 },
  ],
} as const;

export type EntryKind = keyof typeof BALANCE.entryCost;

/** Which price list a game uses: solo, a duel (Face Off / team), or co-op (Link Up). */
export const entryKindOf = (mode: string, solo: boolean): EntryKind => (solo ? 'solo' : mode === 'coop' ? 'coop' : 'duel');
