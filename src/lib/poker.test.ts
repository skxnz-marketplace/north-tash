import assert from "node:assert/strict";
import test from "node:test";

import { describeHoldemHand, winningHoldemPlayerIds } from "./poker.ts";

test("hold'em uses the best five cards from seven", () => {
  const summary = describeHoldemHand(
    [
      { rank: "A", suit: "spades" },
      { rank: "K", suit: "spades" },
    ],
    [
      { rank: "Q", suit: "spades" },
      { rank: "J", suit: "spades" },
      { rank: "10", suit: "spades" },
      { rank: "2", suit: "clubs" },
      { rank: "2", suit: "hearts" },
    ],
  );

  assert.equal(summary?.label, "Royal Flush");
  assert.equal(summary?.bestCards.length, 5);
});

test("hold'em returns split winners when the board plays", () => {
  const winners = winningHoldemPlayerIds(
    [
      { id: "one", holeCards: [{ rank: "A", suit: "clubs" }, { rank: "K", suit: "clubs" }] },
      { id: "two", holeCards: [{ rank: "Q", suit: "clubs" }, { rank: "J", suit: "clubs" }] },
    ],
    [
      { rank: "A", suit: "spades" },
      { rank: "K", suit: "spades" },
      { rank: "Q", suit: "spades" },
      { rank: "J", suit: "spades" },
      { rank: "10", suit: "spades" },
    ],
  );

  assert.deepEqual(winners, ["one", "two"]);
});
