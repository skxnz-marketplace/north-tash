import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPokerPots,
  createPokerDeck,
  describeHoldemHand,
  sanitizePokerForPublic,
  texasHoldemRulesEngine,
  winningHoldemPlayerIds,
  type PokerPlayerState,
} from "./poker.ts";
import type { Card } from "./aflatoon.ts";

const c = (rank: Card["rank"], suit: Card["suit"]): Card => ({ rank, suit });

test("hold'em uses the best five cards from seven", () => {
  const summary = describeHoldemHand(
    [c("A", "spades"), c("K", "spades")],
    [
      c("Q", "spades"),
      c("J", "spades"),
      c("10", "spades"),
      c("2", "clubs"),
      c("3", "diamonds"),
    ],
  );

  assert.equal(summary?.label, "Royal Flush");
  assert.deepEqual(summary?.bestCards.map((card) => card.rank), ["A", "K", "Q", "J", "10"]);
});

test("hold'em returns split winners when the board plays", () => {
  const board = [
    c("A", "spades"),
    c("K", "hearts"),
    c("Q", "diamonds"),
    c("J", "clubs"),
    c("10", "spades"),
  ];
  const winners = winningHoldemPlayerIds(
    [
      { id: "p1", holeCards: [c("2", "clubs"), c("3", "clubs")] },
      { id: "p2", holeCards: [c("4", "clubs"), c("5", "clubs")] },
    ],
    board,
  );

  assert.deepEqual(winners, ["p1", "p2"]);
});

test("poker deck contains 52 unique cards", () => {
  const deck = createPokerDeck();
  const unique = new Set(deck.map((card) => `${card.rank}-${card.suit}`));

  assert.equal(deck.length, 52);
  assert.equal(unique.size, 52);
});

test("heads-up dealer posts small blind and acts first pre-flop", () => {
  const state = texasHoldemRulesEngine.createInitialState({
    roomCode: "101",
    dealerIndex: 0,
    seed: 12,
    players: [
      { id: "p1", name: "Goat", chips: 20 },
      { id: "p2", name: "Jahan", chips: 20 },
    ],
  });

  assert.equal(state.dealerPlayerId, "p1");
  assert.equal(state.smallBlindPlayerId, "p1");
  assert.equal(state.bigBlindPlayerId, "p2");
  assert.equal(state.currentActorPlayerId, "p1");
  assert.equal(state.players[0].stack, 19);
  assert.equal(state.players[1].stack, 18);
  assert.equal(state.players.every((player) => player.holeCards.length === 2), true);
});

test("call only deducts the chips still owed", () => {
  let state = texasHoldemRulesEngine.createInitialState({
    roomCode: "102",
    dealerIndex: 0,
    seed: 16,
    players: [
      { id: "p1", name: "Goat", chips: 20 },
      { id: "p2", name: "Jahan", chips: 20 },
    ],
  });

  state = texasHoldemRulesEngine.applyAction(state, "p1", { type: "CALL" }).state;

  assert.equal(state.players[0].stack, 18);
  assert.equal(state.players[0].currentStreetContribution, 2);
  assert.equal(state.players[0].totalHandContribution, 2);
});

test("big blind option can check and then flop is dealt", () => {
  let state = texasHoldemRulesEngine.createInitialState({
    roomCode: "103",
    dealerIndex: 0,
    seed: 22,
    players: [
      { id: "p1", name: "Goat", chips: 20 },
      { id: "p2", name: "Jahan", chips: 20 },
    ],
  });

  state = texasHoldemRulesEngine.applyAction(state, "p1", { type: "CALL" }).state;
  state = texasHoldemRulesEngine.applyAction(state, "p2", { type: "CHECK" }).state;

  assert.equal(state.street, "FLOP");
  assert.equal(state.communityCards.length, 3);
  assert.equal(state.burnCards.length, 1);
  assert.equal(state.currentActorPlayerId, "p2");
});

test("big blind option exposes check or raise, not a fresh bet", () => {
  let state = texasHoldemRulesEngine.createInitialState({
    roomCode: "103",
    dealerIndex: 0,
    seed: 24,
    players: [
      { id: "p1", name: "Goat", chips: 20 },
      { id: "p2", name: "Jahan", chips: 20 },
    ],
  });

  state = texasHoldemRulesEngine.applyAction(state, "p1", { type: "CALL" }).state;
  const actions = texasHoldemRulesEngine.getLegalActions(state, "p2").actions.map((action) => action.type);

  assert.equal(actions.includes("CHECK"), true);
  assert.equal(actions.includes("RAISE_TO"), true);
  assert.equal(actions.includes("BET"), false);
});

test("public poker snapshot strips private hole cards and deck order", () => {
  const state = texasHoldemRulesEngine.createInitialState({
    roomCode: "104",
    seed: 50,
    players: [
      { id: "p1", name: "Goat", chips: 20 },
      { id: "p2", name: "Jahan", chips: 20 },
    ],
  });
  const publicState = sanitizePokerForPublic(state);

  assert.equal(publicState.deck.length, 0);
  assert.equal(publicState.burnCards.length, 0);
  assert.equal(publicState.players.every((player) => player.holeCards.length === 0), true);
});

test("side pots are built by contribution layers and folded players are ineligible", () => {
  const players: PokerPlayerState[] = [
    pokerPlayer("a", 0, 0, 17, "ALL_IN"),
    pokerPlayer("b", 1, 0, 40, "ACTIVE"),
    pokerPlayer("c", 2, 0, 40, "FOLDED"),
  ];
  const pots = buildPokerPots(players);

  assert.equal(pots[0].amount, 51);
  assert.deepEqual(pots[0].eligiblePlayerIds, ["b", "a"]);
  assert.equal(pots[1].amount, 46);
  assert.deepEqual(pots[1].eligiblePlayerIds, ["b"]);
});

test("showdown settlement preserves chip total across a split board", () => {
  let state = texasHoldemRulesEngine.createInitialState({
    roomCode: "105",
    seed: 80,
    players: [
      { id: "p1", name: "Goat", chips: 20 },
      { id: "p2", name: "Jahan", chips: 20 },
    ],
  });

  state = {
    ...state,
    street: "RIVER",
    communityCards: [
      c("A", "spades"),
      c("K", "hearts"),
      c("Q", "diamonds"),
      c("J", "clubs"),
      c("10", "spades"),
    ],
    players: state.players.map((player, index) => ({
      ...player,
      holeCards: index === 0 ? [c("2", "clubs"), c("3", "clubs")] : [c("4", "clubs"), c("5", "clubs")],
      stack: 18,
      totalHandContribution: 2,
      currentStreetContribution: 0,
      status: "ACTIVE",
    })),
  };

  const settlement = texasHoldemRulesEngine.settleHand(state);

  assert.equal(settlement.winners.reduce((sum, winner) => sum + winner.chips, 0), 4);
  assert.deepEqual(settlement.winners.map((winner) => winner.playerId), ["p2", "p1"]);
});

function pokerPlayer(
  playerId: string,
  seatIndex: number,
  stack: number,
  totalHandContribution: number,
  status: PokerPlayerState["status"],
): PokerPlayerState {
  return {
    playerId,
    name: playerId,
    seatIndex,
    holeCards: [],
    status,
    stack,
    currentStreetContribution: 0,
    totalHandContribution,
    hasActedThisStreet: false,
    lastAction: null,
  };
}
