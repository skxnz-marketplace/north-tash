import assert from "node:assert/strict";
import test from "node:test";

import { mapGameActionRow, stripPrivateHands } from "./multiplayer-room.ts";

test("Supabase action rows are mapped to the camel-case game contract", () => {
  const action = mapGameActionRow({
    id: "action-1",
    action_type: "chaal",
    payload: { source: "button" },
    base_revision: 7,
    actor_user_id: "user-1",
    created_at: "2026-08-07T00:00:00.000Z",
  });

  assert.deepEqual(action, {
    id: "action-1",
    actionType: "chaal",
    payload: { source: "button" },
    baseRevision: 7,
    actorUserId: "user-1",
    createdAt: "2026-08-07T00:00:00.000Z",
  });
});

test("shared snapshots contain no private hands or private reveal metadata", () => {
  const snapshot = stripPrivateHands({
    room: { code: "123" },
    table: {
      userId: "p-user-1",
      players: [
        { id: "p-user-1", hand: [{ rank: "A", suit: "spades" }] },
        { id: "p-user-2", hand: [{ rank: "K", suit: "hearts" }] },
      ],
      privateReveal: { requestId: "show-1" },
    },
  });

  assert.equal(snapshot.table?.userId, "");
  assert.deepEqual(snapshot.table?.players, [
    { id: "p-user-1", hand: [] },
    { id: "p-user-2", hand: [] },
  ]);
  assert.equal(snapshot.table?.privateReveal, undefined);
});
