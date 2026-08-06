import assert from "node:assert/strict";
import test from "node:test";

import {
  AFLATOON_RULES,
  describeCenterCard,
  getOpeningCenterAdvance,
} from "./aflatoon.ts";
import {
  buyInChips,
  createDeck,
  createLocalTable,
  getActiveCenter,
  getCurrentPlayer,
  playChaal,
  requestFinalShow,
  respondToShowRequest,
  shuffleDeck,
  startNextHand,
  transferPlayerChips,
} from "./local-game.ts";

test("deck has 52 unique cards and seeded shuffle is stable", () => {
  const deck = createDeck();
  const uniqueCards = new Set(deck.map((card) => `${card.rank}-${card.suit}`));

  assert.equal(deck.length, 52);
  assert.equal(uniqueCards.size, 52);
  assert.deepEqual(shuffleDeck(deck, 42), shuffleDeck(deck, 42));
});

test("new table deals, boots, opening chaal and player plus one centre cards", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan", "Ayaan"],
    seed: 7,
  });
  const opener = table.players.find((player) => player.chips === 15);
  const normalBootedPlayers = table.players.filter((player) => player.chips === 18);

  assert.equal(table.roomCode, "123");
  assert.equal(table.players.length, 4);
  assert.equal(table.players[0].name, "Vivaan");
  assert.equal(table.phase, "playing");
  assert.equal(table.pot, AFLATOON_RULES.bootChips * 4 + AFLATOON_RULES.openingChaalChips);
  assert.equal(table.centerHistory.length, getOpeningCenterAdvance(4));
  assert.equal(table.players.every((player) => player.hand.length === 3), true);
  assert.ok(opener);
  assert.equal(normalBootedPlayers.length, 3);
});

test("chaal automatically advances the centre card and turn", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan", "Ayaan"],
    seed: 8,
  });
  const player = getCurrentPlayer(table);
  const oldCenter = getActiveCenter(table);
  const oldHistoryLength = table.centerHistory.length;
  const oldPot = table.pot;
  const next = playChaal(table, player.id);

  assert.equal(next.centerHistory.length, oldHistoryLength + 1);
  assert.notDeepEqual(getActiveCenter(next), oldCenter);
  assert.equal(next.pot, oldPot + AFLATOON_RULES.fixedChaalChips);
  assert.notEqual(getCurrentPlayer(next).id, player.id);
});

test("mode and jokers follow the active centre after automatic chaal", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan", "Ayaan"],
    seed: 8,
  });
  const player = getCurrentPlayer(table);
  const next = playChaal(table, player.id);
  const center = describeCenterCard(getActiveCenter(next));

  assert.ok(center.mode === "normal" || center.mode === "mufflis");
  assert.equal(center.jokerRanks.length, 3);
});

test("final show ends the hand and awards the pot", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan", "Ayaan"],
    seed: 9,
  });

  for (let index = 2; index < table.players.length; index += 1) {
    table.players[index] = {
      ...table.players[index],
      status: "folded",
    };
  }

  table = {
    ...table,
    turnIndex: 0,
  };

  const beforeTotal = table.players.reduce((sum, player) => sum + player.chips, 0) + table.pot;
  const next = requestFinalShow(table, "you");
  const afterTotal =
    next.players.reduce((sum, player) => sum + player.chips, 0) +
    next.pot +
    next.carryOverPot;

  assert.equal(next.phase, "hand-complete");
  assert.equal(next.pot, 0);
  assert.equal(next.revealedPlayerIds.length, 4);
  assert.equal(afterTotal, beforeTotal);
});

test("buy-in and next-hand reset preserve table state", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan", "Ayaan"],
    seed: 9,
  });
  table = buyInChips(table, "you", 20);

  assert.equal(table.players[0].chips, 38);
  assert.equal(table.players[0].totalBuyInChips, 40);

  const next = startNextHand(
    {
      ...table,
      phase: "hand-complete",
    },
    10,
  );

  assert.equal(next.handNumber, 2);
  assert.equal(next.players[0].hand.length, 3);
});

test("player transfers support full or partial whole-chip approval without changing buy-in", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir"],
    seed: 12,
  });
  const giver = table.players[1];
  const receiver = table.players[0];
  const next = transferPlayerChips(table, giver.id, receiver.id, 7, 4);

  assert.equal(next.players[1].chips, giver.chips - 4);
  assert.equal(next.players[0].chips, receiver.chips + 4);
  assert.equal(next.players[1].transferBalanceChips, -4);
  assert.equal(next.players[0].transferBalanceChips, 4);
  assert.equal(next.players[0].totalBuyInChips, receiver.totalBuyInChips);
});

test("a third decline request is forced to accept", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan"],
    seed: 13,
  });
  table = { ...table, turnIndex: 0 };
  const defenderIndex = table.players.length - 1;
  table.players[defenderIndex] = {
    ...table.players[defenderIndex],
    declinesUsed: AFLATOON_RULES.declinesPerHand,
  };

  const next = respondToShowRequest(table, "you", "decline");

  assert.equal(next.log[0].text.toLowerCase().includes("declined"), false);
  assert.equal(next.actionCount, table.actionCount + 1);
});

test("heads-up decline costs four chips and flips one centre card", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir"],
    seed: 21,
  });
  table = { ...table, turnIndex: 0 };
  const defenderBefore = table.players[1].chips;
  const centerCountBefore = table.centerHistory.length;
  const next = respondToShowRequest(table, "you", "decline");

  assert.equal(next.players[1].chips, defenderBefore - AFLATOON_RULES.headsUpDeclineCosts[0]);
  assert.equal(next.players[1].declinesUsed, 1);
  assert.equal(next.centerHistory.length, centerCountBefore + 1);
  assert.equal(next.turnIndex, table.turnIndex);
  assert.equal(next.players[next.turnIndex].id, "you");

  const secondDefenderBefore = next.players[1].chips;
  const second = respondToShowRequest(next, "you", "decline");

  assert.equal(
    second.players[1].chips,
    secondDefenderBefore - AFLATOON_RULES.headsUpDeclineCosts[1],
  );
  assert.equal(second.centerHistory.length, centerCountBefore + 2);
  assert.equal(second.turnIndex, table.turnIndex);
});
