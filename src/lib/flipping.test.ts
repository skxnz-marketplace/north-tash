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

const fourPlayers = [...players, { id: "p4", name: "Four", chips: 20 }];

// dealerIndex 0 => opener/first actor is seat 1 (p2); its previous active player is p1.
function fourPlayerState(seed: number) {
  return classicFlippingRulesEngine.createInitialState({
    players: fourPlayers,
    roomCode,
    seed,
    dealerIndex: 0,
  });
}

function see(state: ReturnType<typeof fourPlayerState>, playerId: string) {
  return classicFlippingRulesEngine.applyAction(state, playerId, { type: "SEE_CARDS" }).state;
}

test("Back Show: seen requester versus seen previous player is allowed", () => {
  let state = fourPlayerState(14);
  const actorId = state.currentActorPlayerId; // p2
  const previousId = "p1";

  state = see(state, previousId);
  state = see(state, actorId);

  assert.equal(
    classicFlippingRulesEngine.validateAction(state, actorId, { type: "REQUEST_PACK_SHOW" }).ok,
    true,
  );

  state = classicFlippingRulesEngine.applyAction(state, actorId, { type: "REQUEST_PACK_SHOW" }).state;

  assert.equal(state.players.filter((player) => player.status === "PACKED").length, 1);
  assert.equal(state.players.filter((player) => player.status === "ACTIVE").length, 3);
  assert.equal(state.phase, "BETTING");
});

test("Back Show: seen requester versus blind previous player is rejected", () => {
  let state = fourPlayerState(14);
  const actorId = state.currentActorPlayerId; // p2, previous p1 still blind

  state = see(state, actorId);

  const result = classicFlippingRulesEngine.validateAction(state, actorId, { type: "REQUEST_PACK_SHOW" });
  assert.equal(result.ok, false);
  assert.throws(() =>
    classicFlippingRulesEngine.applyAction(state, actorId, { type: "REQUEST_PACK_SHOW" }),
  );
});

test("Back Show: blind requester versus seen previous player is rejected", () => {
  let state = fourPlayerState(14);
  const actorId = state.currentActorPlayerId; // p2 stays blind

  state = see(state, "p1");

  const result = classicFlippingRulesEngine.validateAction(state, actorId, { type: "REQUEST_PACK_SHOW" });
  assert.equal(result.ok, false);
  assert.throws(() =>
    classicFlippingRulesEngine.applyAction(state, actorId, { type: "REQUEST_PACK_SHOW" }),
  );
});

test("Back Show: blind requester versus blind previous player is rejected", () => {
  const state = fourPlayerState(14);
  const actorId = state.currentActorPlayerId;

  const result = classicFlippingRulesEngine.validateAction(state, actorId, { type: "REQUEST_PACK_SHOW" });
  assert.equal(result.ok, false);
  assert.throws(() =>
    classicFlippingRulesEngine.applyAction(state, actorId, { type: "REQUEST_PACK_SHOW" }),
  );
});

test("Back Show: targeting a non-previous seen player is rejected", () => {
  let state = fourPlayerState(14);
  const actorId = state.currentActorPlayerId; // p2, previous is p1

  state = see(state, "p1");
  state = see(state, actorId);
  state = see(state, "p3");

  const result = classicFlippingRulesEngine.validateAction(state, actorId, {
    type: "REQUEST_PACK_SHOW",
    targetPlayerId: "p3",
  });
  assert.equal(result.ok, false);
  assert.throws(() =>
    classicFlippingRulesEngine.applyAction(state, actorId, {
      type: "REQUEST_PACK_SHOW",
      targetPlayerId: "p3",
    }),
  );
});

test("Back Show is only offered as a legal action to a seen actor with a seen previous player", () => {
  let state = fourPlayerState(14);
  const actorId = state.currentActorPlayerId;

  const blindActions = classicFlippingRulesEngine.getLegalActions(state, actorId);
  assert.equal(blindActions.actions.some((action) => action.type === "REQUEST_PACK_SHOW"), false);

  state = see(state, "p1");
  state = see(state, actorId);

  const seenActions = classicFlippingRulesEngine.getLegalActions(state, actorId);
  assert.equal(seenActions.actions.some((action) => action.type === "REQUEST_PACK_SHOW"), true);
});

test("Both flipping modes enforce the same seen-versus-seen Back Show rule", () => {
  let state = flippingMoflessRulesEngine.createInitialState({
    players: fourPlayers,
    roomCode,
    seed: 21,
    dealerIndex: 0,
  });
  const actorId = state.currentActorPlayerId;

  // Blind actor cannot back-show.
  assert.equal(
    flippingMoflessRulesEngine.validateAction(state, actorId, { type: "REQUEST_PACK_SHOW" }).ok,
    false,
  );

  state = flippingMoflessRulesEngine.applyAction(state, "p1", { type: "SEE_CARDS" }).state;
  state = flippingMoflessRulesEngine.applyAction(state, actorId, { type: "SEE_CARDS" }).state;

  assert.equal(
    flippingMoflessRulesEngine.validateAction(state, actorId, { type: "REQUEST_PACK_SHOW" }).ok,
    true,
  );
});

test("Blind play is allowed for two rounds, then every active player is auto-seen", () => {
  let state = classicFlippingRulesEngine.createInitialState({ players, roomCode, seed: 30, dealerIndex: 0 });
  assert.equal(state.players.every((player) => player.visibility === "BLIND"), true);

  const blindChaal = (s: typeof state) => {
    const actorId = s.currentActorPlayerId;
    const legal = classicFlippingRulesEngine.getLegalActions(s, actorId);
    const chaal = legal.actions.find((action) => action.type === "PLACE_CHAAL");
    return classicFlippingRulesEngine.applyAction(s, actorId, {
      type: "PLACE_CHAAL",
      amount: chaal?.minimumAmount ?? s.currentBlindEquivalent,
    }).state;
  };

  // Round 1 (3 chaals): blind is still permitted.
  for (let index = 0; index < 3; index += 1) {
    state = blindChaal(state);
  }
  assert.equal(state.roundNumber, 2);
  assert.equal(state.players.some((player) => player.visibility === "BLIND"), true);

  // Round 2 (3 more chaals): once it ends, everyone is flipped to seen.
  for (let index = 0; index < 3; index += 1) {
    state = blindChaal(state);
  }
  assert.equal(state.roundNumber, 3);
  assert.equal(
    state.players.every((player) => player.status !== "ACTIVE" || player.visibility === "SEEN"),
    true,
  );
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

test("Mofless recognises Q-K-A as a sequence (regression: key was Q-K-A not A-Q-K)", () => {
  const qka = evaluateMoflessHand([c("Q", "spades"), c("K", "hearts"), c("A", "clubs")], []);
  assert.equal(qka.category, "sequence-low");
});

test("Mofless recognises 2-3-5 as a sequence (special Aflatoon sequence)", () => {
  const hand = evaluateMoflessHand([c("2", "spades"), c("3", "hearts"), c("5", "clubs")], []);
  assert.equal(hand.category, "sequence-low");
});

test("Mofless 2-3-5 sequence is ranked weaker (higher strength) than 2-3-4", () => {
  const strong = evaluateMoflessHand([c("2", "spades"), c("3", "hearts"), c("4", "clubs")], []);
  const weak = evaluateMoflessHand([c("2", "spades"), c("3", "hearts"), c("5", "clubs")], []);
  // In Mofless, lower strength wins; 2-3-4 should beat 2-3-5
  assert.ok(compareFlippingEvaluations("FLIPPING_MOFLESS", strong, weak) > 0);
});

test("Flipping PLACE_CHAAL rejects odd amounts for a SEEN player (fractional equivalent)", () => {
  const state = classicFlippingRulesEngine.createInitialState({ players, roomCode, seed: 42 });
  const actorId = state.currentActorPlayerId;
  const seenState = classicFlippingRulesEngine.applyAction(state, actorId, { type: "SEE_CARDS" }).state;
  const result = classicFlippingRulesEngine.validateAction(seenState, actorId, { type: "PLACE_CHAAL", amount: 3 });
  assert.equal(result.ok, false);
});
