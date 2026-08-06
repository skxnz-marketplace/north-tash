import solver from "pokersolver";

import type { Card } from "./aflatoon.ts";

const { Hand } = solver;

export const TEXAS_HOLDEM_RULES = {
  minPlayers: 2,
  maxPlayers: 7,
  smallBlind: 1,
  bigBlind: 2,
} as const;

export type PokerStreet = "preflop" | "flop" | "turn" | "river" | "showdown";

export type PokerHandSummary = {
  label: string;
  bestCards: Card[];
};

const SUIT_CODES: Record<Card["suit"], string> = {
  spades: "s",
  hearts: "h",
  diamonds: "d",
  clubs: "c",
};

const SUIT_NAMES: Record<string, Card["suit"]> = {
  s: "spades",
  h: "hearts",
  d: "diamonds",
  c: "clubs",
};

function cardCode(card: Card) {
  return `${card.rank === "10" ? "T" : card.rank}${SUIT_CODES[card.suit]}`;
}

function fromSolvedCard(card: { value: string; suit: string }): Card {
  return {
    rank: (card.value === "T" ? "10" : card.value) as Card["rank"],
    suit: SUIT_NAMES[card.suit] ?? "spades",
  };
}

export function describeHoldemHand(holeCards: Card[], board: Card[]): PokerHandSummary | null {
  const available = [...holeCards, ...board];

  if (available.length < 5) {
    return null;
  }

  const solved = Hand.solve(available.map(cardCode));

  return {
    label: solved.descr || solved.name,
    bestCards: solved.cards.map(fromSolvedCard),
  };
}

export function winningHoldemPlayerIds(
  players: Array<{ id: string; holeCards: Card[]; folded?: boolean }>,
  board: Card[],
) {
  const live = players.filter((player) => !player.folded && player.holeCards.length === 2);
  const solved = live.map((player) => ({
    id: player.id,
    hand: Hand.solve([...player.holeCards, ...board].map(cardCode)),
  }));
  const winners = new Set(Hand.winners(solved.map((entry) => entry.hand)));

  return solved.filter((entry) => winners.has(entry.hand)).map((entry) => entry.id);
}
