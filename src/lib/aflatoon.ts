export const AFLATOON_RULES = {
  minPlayers: 2,
  maxPlayers: 7,
  startingChips: 20,
  chipValueRupees: 50,
  bootChips: 2,
  openingChaalChips: 3,
  fixedChaalChips: 1,
  turnTimerSeconds: 15,
  declinesPerHand: 2,
  normalDeclineCosts: [3, 5],
  headsUpDeclineCosts: [4, 6],
  rebuySizes: [10, 20],
} as const;

// The rulebook marks these decisions as open. Keeping the local MVP choices in
// one explicit object makes them visible and replaceable when the group locks them.
export const AFLATOON_MVP_SETTINGS = {
  turnDirection: "clockwise",
  jokersFullyWild: true,
  nextTurnAfterShow: "after-requester",
  specialTieOutcome: "split-with-odd-chip-carried",
  foldEnabled: false,
  mufflisCategoryOrder: [
    "high-card",
    "pair",
    "colour",
    "sequence",
    "pure-sequence",
    "trail",
  ],
  rebuyTiming: "any-time-with-host-approval",
  deckExhaustion: "reshuffle-unused-deck",
} as const;

export const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;

export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type GameMode = "normal" | "mufflis";
export type HandCategory =
  | "high-card"
  | "pair"
  | "colour"
  | "sequence"
  | "pure-sequence"
  | "trail";

export type ShowOutcome = "requester-wins" | "defender-wins" | "split";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export interface EvaluatedHand {
  category: HandCategory;
  label: string;
  tieBreakers: number[];
  bestCards: Card[];
  jokerCount: number;
  sequenceStrength?: number;
}

export interface ShowResolution {
  outcome: ShowOutcome;
  requester: EvaluatedHand;
  defender: EvaluatedHand;
  winnerId?: string;
  loserId?: string;
  reason:
    | "better-hand"
    | "exact-tie-requester-loses"
    | "ace-trail-split"
    | "mufflis-245-split";
}

const RANK_VALUE: Record<Rank, number> = {
  A: 14,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
};

const CATEGORY_STRENGTH: Record<HandCategory, number> = {
  "high-card": 0,
  pair: 1,
  colour: 2,
  sequence: 3,
  "pure-sequence": 4,
  trail: 5,
};

const CATEGORY_LABELS: Record<HandCategory, string> = {
  "high-card": "High card",
  pair: "Pair",
  colour: "Colour",
  sequence: "Sequence",
  "pure-sequence": "Pure sequence",
  trail: "Trail",
};

const SEQUENCE_STRENGTH = new Map<string, number>([
  ["2-3-5", 13],
  ["2-3-A", 12],
  ["Q-K-A", 11],
  ["J-Q-K", 10],
  ["10-J-Q", 9],
  ["9-10-J", 8],
  ["8-9-10", 7],
  ["7-8-9", 6],
  ["6-7-8", 5],
  ["5-6-7", 4],
  ["4-5-6", 3],
  ["3-4-5", 2],
  ["2-3-4", 1],
]);

const DECK: Card[] = SUITS.flatMap((suit) =>
  RANKS.map((rank) => ({ rank, suit })),
);

export function rupeesForChips(chips: number) {
  return chips * AFLATOON_RULES.chipValueRupees;
}

export function getModeForCenterCard(card: Card): GameMode {
  return card.suit === "hearts" || card.suit === "diamonds"
    ? "normal"
    : "mufflis";
}

export function getSequentialJokerRanks(centerRank: Rank): Rank[] {
  const index = RANKS.indexOf(centerRank);
  return [
    RANKS[(index - 1 + RANKS.length) % RANKS.length],
    centerRank,
    RANKS[(index + 1) % RANKS.length],
  ];
}

export function getOpeningCenterAdvance(playerCount: number) {
  if (
    playerCount < AFLATOON_RULES.minPlayers ||
    playerCount > AFLATOON_RULES.maxPlayers
  ) {
    throw new RangeError("Aflatoon supports 2 to 7 players.");
  }

  return playerCount + 1;
}

export function describeCenterCard(card: Card) {
  return {
    mode: getModeForCenterCard(card),
    jokerRanks: getSequentialJokerRanks(card.rank),
  };
}

export function formatCard(card: Card) {
  return `${card.rank}${suitSymbol(card.suit)}`;
}

export function suitSymbol(suit: Suit) {
  switch (suit) {
    case "hearts":
      return "♥";
    case "diamonds":
      return "♦";
    case "clubs":
      return "♣";
    case "spades":
      return "♠";
  }
}

export function evaluateHand(
  cards: Card[],
  options: {
    mode: GameMode;
    jokerRanks?: Rank[];
  },
): EvaluatedHand {
  assertThreeCards(cards);

  const jokerRanks = new Set(options.jokerRanks ?? []);
  const fixedCards = cards.filter((card) => !jokerRanks.has(card.rank));
  const jokerCount = cards.length - fixedCards.length;
  let best: EvaluatedHand | undefined;

  for (const replacements of generateReplacementHands(jokerCount)) {
    const candidate = [...fixedCards, ...replacements];
    const evaluation = evaluateConcreteHand(candidate, jokerCount);

    if (!best || compareEvaluations(evaluation, best, options.mode) > 0) {
      best = evaluation;
    }
  }

  if (!best) {
    throw new Error("Could not evaluate hand.");
  }

  return best;
}

export function compareHands(
  leftCards: Card[],
  rightCards: Card[],
  options: {
    mode: GameMode;
    jokerRanks?: Rank[];
  },
) {
  const left = evaluateHand(leftCards, options);
  const right = evaluateHand(rightCards, options);
  const value = compareEvaluations(left, right, options.mode);

  return { value, left, right };
}

export function resolveShowComparison(input: {
  requesterId: string;
  defenderId: string;
  requesterCards: Card[];
  defenderCards: Card[];
  mode: GameMode;
  jokerRanks?: Rank[];
}): ShowResolution {
  const { value, left, right } = compareHands(input.requesterCards, input.defenderCards, {
    mode: input.mode,
    jokerRanks: input.jokerRanks,
  });

  if (value > 0) {
    return {
      outcome: "requester-wins",
      requester: left,
      defender: right,
      winnerId: input.requesterId,
      loserId: input.defenderId,
      reason: "better-hand",
    };
  }

  if (value < 0) {
    return {
      outcome: "defender-wins",
      requester: left,
      defender: right,
      winnerId: input.defenderId,
      loserId: input.requesterId,
      reason: "better-hand",
    };
  }

  if (isAceTrailTie(input.mode, left, right)) {
    return {
      outcome: "split",
      requester: left,
      defender: right,
      reason: "ace-trail-split",
    };
  }

  if (isMufflis245Tie(input.mode, left, right)) {
    return {
      outcome: "split",
      requester: left,
      defender: right,
      reason: "mufflis-245-split",
    };
  }

  return {
    outcome: "defender-wins",
    requester: left,
    defender: right,
    winnerId: input.defenderId,
    loserId: input.requesterId,
    reason: "exact-tie-requester-loses",
  };
}

export function compareEvaluations(
  left: EvaluatedHand,
  right: EvaluatedHand,
  mode: GameMode,
) {
  const categoryDelta =
    CATEGORY_STRENGTH[left.category] - CATEGORY_STRENGTH[right.category];

  if (categoryDelta !== 0) {
    return mode === "normal" ? Math.sign(categoryDelta) : -Math.sign(categoryDelta);
  }

  const longest = Math.max(left.tieBreakers.length, right.tieBreakers.length);

  for (let index = 0; index < longest; index += 1) {
    const delta = (left.tieBreakers[index] ?? 0) - (right.tieBreakers[index] ?? 0);

    if (delta !== 0) {
      return mode === "normal" ? Math.sign(delta) : -Math.sign(delta);
    }
  }

  return 0;
}

function evaluateConcreteHand(cards: Card[], jokerCount: number): EvaluatedHand {
  const ranks = cards.map((card) => card.rank);
  const rankCounts = countRanks(ranks);
  const counts = [...rankCounts.values()].sort((left, right) => right - left);
  const isFlush = cards.every((card) => card.suit === cards[0].suit);
  const sequenceStrength = getSequenceStrength(ranks);

  let category: HandCategory;
  let tieBreakers: number[];

  if (counts[0] === 3) {
    category = "trail";
    tieBreakers = [RANK_VALUE[ranks[0]]];
  } else if (sequenceStrength && isFlush) {
    category = "pure-sequence";
    tieBreakers = [sequenceStrength];
  } else if (sequenceStrength) {
    category = "sequence";
    tieBreakers = [sequenceStrength];
  } else if (isFlush) {
    category = "colour";
    tieBreakers = highToLowRanks(ranks);
  } else if (counts[0] === 2) {
    const pairRank = findRankByCount(rankCounts, 2);
    const kicker = findRankByCount(rankCounts, 1);
    category = "pair";
    tieBreakers = [RANK_VALUE[pairRank], RANK_VALUE[kicker]];
  } else {
    category = "high-card";
    tieBreakers = highToLowRanks(ranks);
  }

  return {
    category,
    label: CATEGORY_LABELS[category],
    tieBreakers,
    bestCards: sortCardsForDisplay(cards),
    jokerCount,
    sequenceStrength: sequenceStrength ?? undefined,
  };
}

function getSequenceStrength(ranks: Rank[]) {
  const uniqueRanks = new Set(ranks);

  if (uniqueRanks.size !== 3) {
    return null;
  }

  return SEQUENCE_STRENGTH.get(sequenceKey([...uniqueRanks])) ?? null;
}

function sequenceKey(ranks: Rank[]) {
  return ranks
    .sort((left, right) => RANK_VALUE[left] - RANK_VALUE[right])
    .join("-");
}

function highToLowRanks(ranks: Rank[]) {
  return ranks
    .map((rank) => RANK_VALUE[rank])
    .sort((left, right) => right - left);
}

function countRanks(ranks: Rank[]) {
  const rankCounts = new Map<Rank, number>();

  for (const rank of ranks) {
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
  }

  return rankCounts;
}

function findRankByCount(rankCounts: Map<Rank, number>, count: number) {
  for (const [rank, currentCount] of rankCounts.entries()) {
    if (currentCount === count) {
      return rank;
    }
  }

  throw new Error(`No rank found with count ${count}.`);
}

function* generateReplacementHands(count: number): Generator<Card[]> {
  if (count === 0) {
    yield [];
    return;
  }

  for (const card of DECK) {
    for (const rest of generateReplacementHands(count - 1)) {
      yield [card, ...rest];
    }
  }
}

function sortCardsForDisplay(cards: Card[]) {
  return [...cards].sort((left, right) => RANK_VALUE[right.rank] - RANK_VALUE[left.rank]);
}

function isAceTrailTie(
  mode: GameMode,
  requester: EvaluatedHand,
  defender: EvaluatedHand,
) {
  return (
    mode === "normal" &&
    requester.category === "trail" &&
    defender.category === "trail" &&
    requester.tieBreakers[0] === RANK_VALUE.A &&
    defender.tieBreakers[0] === RANK_VALUE.A
  );
}

function isMufflis245Tie(
  mode: GameMode,
  requester: EvaluatedHand,
  defender: EvaluatedHand,
) {
  return (
    mode === "mufflis" &&
    isValidMufflis245(requester) &&
    isValidMufflis245(defender)
  );
}

function isValidMufflis245(hand: EvaluatedHand) {
  return hand.category === "high-card" && rankKey(hand.bestCards) === "2-4-5";
}

function rankKey(cards: Card[]) {
  return cards
    .map((card) => card.rank)
    .sort((left, right) => RANK_VALUE[left] - RANK_VALUE[right])
    .join("-");
}

function assertThreeCards(cards: Card[]) {
  if (cards.length !== 3) {
    throw new RangeError("Aflatoon hands must contain exactly 3 cards.");
  }
}
