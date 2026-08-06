import assert from "node:assert/strict";
import test from "node:test";

import {
  compareEvaluations,
  describeCenterCard,
  evaluateHand,
  getModeForCenterCard,
  getOpeningCenterAdvance,
  getSequentialJokerRanks,
  resolveShowComparison,
} from "./aflatoon.ts";
import type { Card, Rank, Suit } from "./aflatoon.ts";

const card = (rank: Rank, suit: Suit): Card => ({ rank, suit });

test("centre card controls mode and sequential joker wrapping", () => {
  assert.equal(getModeForCenterCard(card("9", "hearts")), "normal");
  assert.equal(getModeForCenterCard(card("9", "diamonds")), "normal");
  assert.equal(getModeForCenterCard(card("9", "clubs")), "mufflis");
  assert.equal(getModeForCenterCard(card("9", "spades")), "mufflis");
  assert.deepEqual(getSequentialJokerRanks("A"), ["K", "A", "2"]);
  assert.deepEqual(getSequentialJokerRanks("2"), ["A", "2", "3"]);
  assert.deepEqual(getSequentialJokerRanks("K"), ["Q", "K", "A"]);
  assert.equal(getOpeningCenterAdvance(4), 5);
});

test("custom normal sequence order is used for sequence and pure sequence", () => {
  const twoThreeFive = evaluateHand(
    [card("2", "spades"), card("3", "hearts"), card("5", "diamonds")],
    { mode: "normal" },
  );
  const aceTwoThree = evaluateHand(
    [card("A", "spades"), card("2", "hearts"), card("3", "diamonds")],
    { mode: "normal" },
  );
  const aceKingQueen = evaluateHand(
    [card("A", "spades"), card("K", "hearts"), card("Q", "diamonds")],
    { mode: "normal" },
  );
  const kingQueenJackPure = evaluateHand(
    [card("K", "clubs"), card("Q", "clubs"), card("J", "clubs")],
    { mode: "normal" },
  );

  assert.equal(twoThreeFive.category, "sequence");
  assert.equal(kingQueenJackPure.category, "pure-sequence");
  assert.ok(compareEvaluations(twoThreeFive, aceTwoThree, "normal") > 0);
  assert.ok(compareEvaluations(aceTwoThree, aceKingQueen, "normal") > 0);
  assert.ok(compareEvaluations(kingQueenJackPure, twoThreeFive, "normal") > 0);
});

test("normal mode compares same-category hands high to low", () => {
  const aceQueenSeven = evaluateHand(
    [card("A", "hearts"), card("Q", "spades"), card("7", "diamonds")],
    { mode: "normal" },
  );
  const aceJackSeven = evaluateHand(
    [card("A", "clubs"), card("J", "hearts"), card("7", "clubs")],
    { mode: "normal" },
  );
  const kingPairTen = evaluateHand(
    [card("K", "hearts"), card("K", "spades"), card("10", "diamonds")],
    { mode: "normal" },
  );
  const kingPairEight = evaluateHand(
    [card("K", "clubs"), card("K", "diamonds"), card("8", "hearts")],
    { mode: "normal" },
  );

  assert.ok(compareEvaluations(aceQueenSeven, aceJackSeven, "normal") > 0);
  assert.ok(compareEvaluations(kingPairTen, kingPairEight, "normal") > 0);
});

test("mufflis treats mixed-suit 2-4-5 as the strongest natural high-card hand", () => {
  const twoFourFive = evaluateHand(
    [card("2", "spades"), card("4", "hearts"), card("5", "diamonds")],
    { mode: "mufflis" },
  );
  const twoFourSix = evaluateHand(
    [card("2", "clubs"), card("4", "diamonds"), card("6", "hearts")],
    { mode: "mufflis" },
  );
  const lowPair = evaluateHand(
    [card("2", "spades"), card("2", "hearts"), card("5", "diamonds")],
    { mode: "mufflis" },
  );

  assert.equal(twoFourFive.category, "high-card");
  assert.ok(compareEvaluations(twoFourFive, twoFourSix, "mufflis") > 0);
  assert.ok(compareEvaluations(twoFourFive, lowPair, "mufflis") > 0);
});

test("mufflis reverses category priority and compares cards low to high", () => {
  const lowPair = evaluateHand(
    [card("2", "spades"), card("2", "hearts"), card("A", "diamonds")],
    { mode: "mufflis" },
  );
  const colour = evaluateHand(
    [card("2", "spades"), card("4", "spades"), card("7", "spades")],
    { mode: "mufflis" },
  );
  const sevenFourThree = evaluateHand(
    [card("7", "spades"), card("4", "hearts"), card("3", "diamonds")],
    { mode: "mufflis" },
  );
  const sevenFiveTwo = evaluateHand(
    [card("7", "clubs"), card("5", "diamonds"), card("2", "hearts")],
    { mode: "mufflis" },
  );

  assert.ok(compareEvaluations(lowPair, colour, "mufflis") > 0);
  assert.ok(compareEvaluations(sevenFourThree, sevenFiveTwo, "mufflis") > 0);
});

test("jokers complete the best normal hand and the best mufflis low hand", () => {
  const normalJokerTrail = evaluateHand(
    [card("7", "spades"), card("K", "diamonds"), card("K", "clubs")],
    { mode: "normal", jokerRanks: ["6", "7", "8"] },
  );
  const normalPureSequence = evaluateHand(
    [card("7", "clubs"), card("J", "clubs"), card("Q", "clubs")],
    { mode: "normal", jokerRanks: ["6", "7", "8"] },
  );
  const mufflisJokerLow = evaluateHand(
    [card("A", "spades"), card("4", "hearts"), card("5", "diamonds")],
    { mode: "mufflis", jokerRanks: ["K", "A", "2"] },
  );

  assert.equal(normalJokerTrail.category, "trail");
  assert.deepEqual(normalJokerTrail.tieBreakers, [13]);
  assert.equal(normalPureSequence.category, "pure-sequence");
  assert.equal(mufflisJokerLow.category, "high-card");
  assert.deepEqual(
    mufflisJokerLow.bestCards.map((shownCard) => shownCard.rank).sort(),
    ["2", "4", "5"],
  );
});

test("show resolution makes requester lose exact ties except locked split hands", () => {
  const kingTrailTie = resolveShowComparison({
    requesterId: "amit",
    defenderId: "kabir",
    requesterCards: [card("K", "hearts"), card("7", "spades"), card("7", "diamonds")],
    defenderCards: [card("K", "clubs"), card("7", "hearts"), card("7", "clubs")],
    mode: "normal",
    jokerRanks: ["7"],
  });
  const aceTrailTie = resolveShowComparison({
    requesterId: "amit",
    defenderId: "kabir",
    requesterCards: [card("A", "hearts"), card("7", "spades"), card("7", "diamonds")],
    defenderCards: [card("A", "clubs"), card("7", "hearts"), card("7", "clubs")],
    mode: "normal",
    jokerRanks: ["7"],
  });
  const mufflis245Tie = resolveShowComparison({
    requesterId: "amit",
    defenderId: "kabir",
    requesterCards: [card("2", "spades"), card("4", "hearts"), card("5", "diamonds")],
    defenderCards: [card("2", "clubs"), card("4", "diamonds"), card("5", "hearts")],
    mode: "mufflis",
  });

  assert.equal(kingTrailTie.outcome, "defender-wins");
  assert.equal(kingTrailTie.reason, "exact-tie-requester-loses");
  assert.equal(aceTrailTie.outcome, "split");
  assert.equal(aceTrailTie.reason, "ace-trail-split");
  assert.equal(mufflis245Tie.outcome, "split");
  assert.equal(mufflis245Tie.reason, "mufflis-245-split");
});

test("describeCenterCard bundles the currently active mode and jokers", () => {
  assert.deepEqual(describeCenterCard(card("3", "diamonds")), {
    mode: "normal",
    jokerRanks: ["2", "3", "4"],
  });
});
