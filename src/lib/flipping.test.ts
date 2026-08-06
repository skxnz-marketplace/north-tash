import assert from "node:assert/strict";
import test from "node:test";

import type { Card } from "./aflatoon.ts";
import {
  classicFlippingRulesEngine,
  compareFlippingEvaluations,
  evaluateClassicFlippingHand,
  evaluateMoflessHand,
  flippingMoflessRulesEngine,
} from "./flipping.ts";

const c = (rank: Card["rank"], suit: Card["suit"]): Card => ({ rank, suit });
const players = [
  { id: "p1", name: "One", chips: 20 },
  { id: "p2", name: "Two", chips: 20 },
  { id: "p3", name: "Three", chips: 20 },
];
const roomCode = "123";

test("Classic Flipping rejects fewer than three players", () => {
  assert.throws(() =>
    classicFlippingRulesEngine.createInitialState({
      players: players.slice(0, 2),
      roomCode,
      seed: 5,
    }),
  );
});

test("Classic Flipping starts with private hands and three center jokers", () => {
  const state = classicFlippingRulesEngine.createInitialState({ players, roomCode, seed: 10 });

  assert.equal(state.players.length, 3);
  assert.equal(state.activeJokerCards.length, 3);
  assert.equal(state.players.every((player) => player.cards.length === 3), true);
  assert.equal(state.players.every((player) => player.visibility === "BLIND"), true);
  assert.equal(new Set(state.activeJokerCards.map((card) => `${card.rank}-${card.suit}`)).size, 3);
});

test("Seen players pay double the blind equivalent", () => {
  let state = classicFlippingRulesEngine.createInitialState({ players, roomCode, seed: 11, dealerIndex: 0 });
  const actorId = state.currentActorPlayerId;

  state = classicFlippingRulesEngine.applyAction(state, actorId, { type: "SEE_CARDS" }).state;
  state = classicFlippingRulesEngine.applyAction(state, actorId, { type: "PLACE_CHAAL", amount: 4 }).state;

  const actor = state.players.find((player) => player.playerId === actorId);
  assert.equal(actor?.visibility, "SEEN");
  assert.equal(actor?.stack, 16);
  assert.equal(state.currentBlindEquivalent, 2);
  assert.equal(state.pot, 4);
});

test("Pack replaces jokers and locks them when three become two", () => {
  let state = classicFlippingRulesEngine.createInitialState({ players, roomCode, seed: 12, dealerIndex: 0 });
  const actorId = state.currentActorPlayerId;
  const actorCards = state.players.find((player) => player.playerId === actorId)?.cards ?? [];

  state = classicFlippingRulesEngine.applyAction(state, actorId, { type: "PACK" }).state;

  assert.deepEqual(state.activeJokerCards, actorCards);
  assert.equal(state.jokersLocked, true);
  assert.equal(state.players.find((player) => player.playerId === actorId)?.publicCards.length, 3);
});

test("Final show resolves automatically with no decline state", () => {
  let state = classicFlippingRulesEngine.createInitialState({ players, roomCode, seed: 13, dealerIndex: 0 });

  state = classicFlippingRulesEngine.applyAction(state, state.currentActorPlayerId, { type: "PACK" }).state;
  state = classicFlippingRulesEngine.applyAction(state, state.currentActorPlayerId, { type: "REQUEST_SHOW" }).state;

  assert.equal(state.phase, "COMPLETE");
  assert.ok(state.lastShow);
});

test("Pack Show packs the losing player and keeps the hand alive with more than two players", () => {
  const fourPlayers = [...players, { id: "p4", name: "Four", chips: 20 }];
  let state = classicFlippingRulesEngine.createInitialState({ players: fourPlayers, roomCode, seed: 14, dealerIndex: 0 });

  state = classicFlippingRulesEngine.applyAction(state, state.currentActorPlayerId, { type: "REQUEST_PACK_SHOW" }).state;

  assert.equal(state.players.filter((player) => player.status === "PACKED").length, 1);
  assert.equal(state.players.filter((player) => player.status === "ACTIVE").length, 3);
  assert.equal(state.phase, "BETTING");
});

test("Mofless compares lowest cards first with Ace low", () => {
  const left = evaluateMoflessHand([c("A", "spades"), c("4", "hearts"), c("8", "clubs")], []);
  const right = evaluateMoflessHand([c("A", "clubs"), c("5", "diamonds"), c("6", "hearts")], []);

  assert.ok(compareFlippingEvaluations("FLIPPING_MOFLESS", left, right) > 0);
});

test("Mofless joker avoids Classic high optimization", () => {
  const classic = evaluateClassicFlippingHand([c("A", "spades"), c("4", "hearts"), c("7", "clubs")], ["7"]);
  const mofless = evaluateMoflessHand([c("A", "spades"), c("4", "hearts"), c("7", "clubs")], ["7"]);

  assert.notEqual(classic.displayName, mofless.displayName);
  assert.equal(mofless.effectiveCards[0]?.rank, "A");
});

test("Mofless engine starts as its own mode", () => {
  const state = flippingMoflessRulesEngine.createInitialState({ players, roomCode, seed: 15 });

  assert.equal(state.mode, "FLIPPING_MOFLESS");
  assert.equal(state.players.length, 3);
});
