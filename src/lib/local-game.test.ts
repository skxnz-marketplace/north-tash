import assert from "node:assert/strict";
import test from "node:test";

import {
  AFLATOON_RULES,
  describeCenterCard,
  getOpeningCenterAdvance,
} from "./aflatoon.ts";
import {
  buyInChips,
  calculatePlayerSettlements,
  calculateTransferObligations,
  createTableFromPlayers,
  createShowRequest,
  createDeck,
  createLocalTable,
  getActiveCenter,
  getCurrentPlayer,
  netPlayerSettlements,
  payBoot,
  playChaal,
  queueBuyInRequest,
  queueTransferRequest,
  requestFinalShow,
  resolveBuyInRequest,
  resolveTransferRequest,
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

test("opening contributions charge 2 chips each and 3 chips total for the opener", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan", "Ayaan"],
    seed: 7,
  });
  const opener = table.players.find((player) => player.chips === 17);
  const normalBootedPlayers = table.players.filter((player) => player.chips === 18);

  assert.equal(table.roomCode, "123");
  assert.equal(table.players.length, 4);
  assert.equal(table.players[0].name, "Vivaan");
  assert.equal(table.phase, "playing");
  assert.equal(
    table.pot,
    AFLATOON_RULES.bootChips * (table.players.length - 1) + AFLATOON_RULES.openingChaalChips,
  );
  assert.equal(table.centerHistory.length, getOpeningCenterAdvance(4));
  assert.equal(table.players.every((player) => player.hand.length === 3), true);
  assert.ok(opener);
  assert.equal(normalBootedPlayers.length, 3);
});

test("all players pay boots before a hand deals and heads-up starts with a 5-chip pot", () => {
  let table = createTableFromPlayers({
    roomCode: "123",
    userId: "one",
    players: [
      { id: "one", name: "Player 1", chips: 20 },
      { id: "two", name: "Player 2", chips: 20 },
    ],
    seed: 0,
  });

  assert.equal(table.phase, "collecting-boots");
  assert.equal(table.pot, 0);
  assert.equal(table.players.every((player) => player.hand.length === 0), true);

  table = payBoot(table, "one", 0);
  assert.equal(table.phase, "collecting-boots");
  assert.equal(table.pot, 2);

  table = payBoot(table, "two", 0);
  assert.equal(table.phase, "playing");
  assert.equal(table.pot, 5);
  assert.equal(table.players.every((player) => player.hand.length === 3), true);
  assert.deepEqual(table.players.map((player) => player.chips), [18, 17]);
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

test("turns visit every active seat exactly once for two through five players", () => {
  for (let playerCount = 2; playerCount <= 5; playerCount += 1) {
    let table = createLocalTable({
      roomCode: String(120 + playerCount),
      userName: "Player 1",
      botNames: Array.from({ length: playerCount - 1 }, (_, index) => `Player ${index + 2}`),
      seed: 40 + playerCount,
    });
    const firstPlayerId = getCurrentPlayer(table).id;
    const visited = new Set<string>();

    for (let turn = 0; turn < playerCount; turn += 1) {
      const current = getCurrentPlayer(table);
      visited.add(current.id);
      table = playChaal(table, current.id);
    }

    assert.equal(visited.size, playerCount);
    assert.equal(getCurrentPlayer(table).id, firstPlayerId);
  }
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

  let next = startNextHand(
    {
      ...table,
      phase: "hand-complete",
    },
    10,
  );

  for (const playerId of next.pendingBootPlayerIds ?? []) {
    next = payBoot(next, playerId, 0);
  }

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
  assert.equal(next.transferLedger?.length, 1);
  assert.deepEqual(next.transferLedger?.[0], {
    id: next.transferLedger?.[0].id,
    fromPlayerId: giver.id,
    toPlayerId: receiver.id,
    chips: 4,
  });
});

test("buy-in requests persist until the owner resolves them", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Owner",
    botNames: ["Guest"],
    seed: 14,
  });
  const guest = table.players[1];
  const queued = queueBuyInRequest(table, {
    id: "buy-1",
    playerId: guest.id,
    playerName: guest.name,
    chips: 10,
  });
  const resolved = resolveBuyInRequest(queued, "buy-1", "accept");

  assert.equal(queued.pendingBuyInRequests?.length, 1);
  assert.equal(resolved.pendingBuyInRequests?.length, 0);
  assert.equal(resolved.players[1].chips, guest.chips + 10);
  assert.equal(resolved.players[1].totalBuyInChips, guest.totalBuyInChips + 10);
});

test("personal chip requests cannot target self and only the target can resolve them", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Goat",
    botNames: ["Jahan", "Third"],
    seed: 15,
  });
  const requester = table.players[0];
  const target = table.players[1];
  const selfRequest = queueTransferRequest(table, {
    id: "transfer-self",
    requesterId: requester.id,
    requesterName: requester.name,
    targetId: requester.id,
    amount: 3,
  });
  const queued = queueTransferRequest(table, {
    id: "transfer-1",
    requesterId: requester.id,
    requesterName: requester.name,
    targetId: target.id,
    amount: 3,
  });
  const wrongResponder = resolveTransferRequest(queued, "transfer-1", table.players[2].id, "accept");
  const resolved = resolveTransferRequest(queued, "transfer-1", target.id, "accept");

  assert.equal(selfRequest, table);
  assert.equal(queued.pendingTransferRequests?.length, 1);
  assert.equal(wrongResponder, queued);
  assert.equal(resolved.pendingTransferRequests?.length, 0);
  assert.equal(resolved.players[0].chips, requester.chips + 3);
  assert.equal(resolved.players[1].chips, target.chips - 3);
  assert.deepEqual(resolved.transferLedger, [
    {
      id: "transfer-1",
      fromPlayerId: target.id,
      toPlayerId: requester.id,
      chips: 3,
    },
  ]);
});

test("session settlement says which losing player pays each winning player", () => {
  const table = createLocalTable({
    roomCode: "123",
    userName: "Player 1",
    botNames: ["Player 2", "Player 3"],
    seed: 16,
  });
  const players = table.players.map((player, index) => ({
    ...player,
    chips: [10, 26, 24][index],
    totalBuyInChips: 20,
    transferBalanceChips: 0,
    shortChips: 0,
  }));

  assert.deepEqual(calculatePlayerSettlements(players), [
    { fromPlayerId: players[0].id, toPlayerId: players[1].id, chips: 6 },
    { fromPlayerId: players[0].id, toPlayerId: players[2].id, chips: 4 },
  ]);
});

test("reciprocal personal chip requests are netted into one clear obligation", () => {
  assert.deepEqual(
    calculateTransferObligations([
      { id: "one", fromPlayerId: "player-1", toPlayerId: "player-2", chips: 3 },
      { id: "two", fromPlayerId: "player-2", toPlayerId: "player-1", chips: 1 },
    ]),
    [{ fromPlayerId: "player-2", toPlayerId: "player-1", chips: 2 }],
  );
});

test("final settlement nets game results against personal chip obligations", () => {
  assert.deepEqual(
    netPlayerSettlements([
      { fromPlayerId: "player-1", toPlayerId: "player-2", chips: 5 },
      { fromPlayerId: "player-2", toPlayerId: "player-1", chips: 3 },
    ]),
    [{ fromPlayerId: "player-1", toPlayerId: "player-2", chips: 2 }],
  );
});

test("personal chip request history survives the next hand", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Player 1",
    botNames: ["Player 2"],
    seed: 17,
  });
  table = transferPlayerChips(table, table.players[1].id, table.players[0].id, 3, 3, "loan-1");
  table = startNextHand({ ...table, phase: "hand-complete" }, 18);

  assert.deepEqual(table.transferLedger, [
    {
      id: "loan-1",
      fromPlayerId: table.players[1].id,
      toPlayerId: table.players[0].id,
      chips: 3,
    },
  ]);
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

test("declining a queued show never reveals either private hand", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan"],
    seed: 31,
  });
  table = { ...table, turnIndex: 0 };
  table = createShowRequest(table, "you", "show-private", "Back show");

  const next = respondToShowRequest(table, "you", "decline");

  assert.equal(next.pendingShow, undefined);
  assert.equal(next.privateReveal, undefined);
  assert.deepEqual(next.revealedPlayerIds, []);
});

test("accepting a queued show limits the temporary reveal to both participants", () => {
  let table = createLocalTable({
    roomCode: "123",
    userName: "Vivaan",
    botNames: ["Kabir", "Ishaan"],
    seed: 32,
  });
  table = { ...table, turnIndex: 0 };
  table = createShowRequest(table, "you", "show-private", "Back show");
  const defenderId = table.pendingShow?.defenderId;

  const next = respondToShowRequest(table, "you", "accept");

  assert.equal(next.pendingShow, undefined);
  assert.equal(next.privateReveal?.requestId, "show-private");
  assert.deepEqual(next.privateReveal?.viewerIds.sort(), ["you", defenderId].sort());
  assert.deepEqual(next.privateReveal?.playerIds.sort(), ["you", defenderId].sort());
});
