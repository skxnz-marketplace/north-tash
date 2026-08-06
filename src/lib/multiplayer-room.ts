import type { RealtimeChannel } from "@supabase/supabase-js";

import { getSupabaseBrowserClient } from "./supabase-client";

export type MultiplayerSnapshot = {
  room: Record<string, unknown>;
  table: Record<string, unknown> | null;
};

type RoomRow = {
  code: string;
  host_user_id: string;
  state: MultiplayerSnapshot;
};

const MULTIPLAYER_TIMEOUT_MS = 10000;

export function withMultiplayerTimeout<T>(promise: Promise<T>, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), MULTIPLAYER_TIMEOUT_MS);

    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function ensureAnonymousSession() {
  const supabase = getSupabaseBrowserClient();

  if (!supabase) {
    return null;
  }

  const existing = await supabase.auth.getUser();

  if (existing.data.user) {
    return existing.data.user.id;
  }

  const result = await supabase.auth.signInAnonymously();

  if (result.error) {
    throw result.error;
  }

  return result.data.user?.id ?? null;
}

export async function createMultiplayerRoom(
  code: string,
  playerId: string,
  snapshot: MultiplayerSnapshot,
) {
  const supabase = getSupabaseBrowserClient();
  const userId = await ensureAnonymousSession();

  if (!supabase || !userId) {
    return null;
  }

  const { error: roomError } = await supabase.from("game_rooms").insert({
    code,
    host_user_id: userId,
    state: snapshot,
  });

  if (roomError) {
    throw roomError;
  }

  const { error: memberError } = await supabase.from("game_room_members").insert({
    room_code: code,
    user_id: userId,
    player_id: playerId,
  });

  if (memberError) {
    throw memberError;
  }

  return userId;
}

export async function joinMultiplayerRoom(
  code: string,
  player: { id: string; name: string; chips: number },
) {
  const supabase = getSupabaseBrowserClient();
  const userId = await ensureAnonymousSession();

  if (!supabase || !userId) {
    return null;
  }

  const { error: memberError } = await supabase.from("game_room_members").upsert(
    { room_code: code, user_id: userId, player_id: player.id },
    { onConflict: "room_code,user_id" },
  );

  if (memberError) {
    throw memberError;
  }

  const { data: room, error: roomError } = await supabase
    .from("game_rooms")
    .select("code, host_user_id, state")
    .eq("code", code)
    .maybeSingle<RoomRow>();

  if (roomError) {
    throw roomError;
  }

  if (!room) {
    throw new Error(`Room ${code} was not found.`);
  }

  const currentRoom = room.state.room as {
    code?: string;
    players?: Array<{ id: string; name: string; chips: number; isHost?: boolean; isBot?: boolean }>;
  };
  const players = Array.isArray(currentRoom.players) ? currentRoom.players : [];

  let nextSnapshot = room.state;

  if (!players.some((currentPlayer) => currentPlayer.id === player.id)) {
    nextSnapshot = {
      ...room.state,
      room: {
        ...currentRoom,
        players: [
          ...players,
          {
            id: player.id,
            name: player.name,
            chips: player.chips,
            isHost: false,
            isBot: false,
          },
        ],
      },
    };

    const { error: snapshotError } = await supabase
      .from("game_rooms")
      .update({ state: nextSnapshot })
      .eq("code", code);

    if (snapshotError) {
      throw snapshotError;
    }
  }

  return { userId, snapshot: nextSnapshot };
}

export async function saveMultiplayerSnapshot(code: string, snapshot: MultiplayerSnapshot) {
  const supabase = getSupabaseBrowserClient();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.from("game_rooms").update({ state: snapshot }).eq("code", code);

  if (error) {
    throw error;
  }
}

export function subscribeToMultiplayerRoom(
  code: string,
  onSnapshot: (snapshot: MultiplayerSnapshot) => void,
) {
  const supabase = getSupabaseBrowserClient();

  if (!supabase) {
    return () => undefined;
  }

  let lastSnapshot = "";
  const publish = (nextSnapshot: MultiplayerSnapshot | null) => {
    if (!nextSnapshot?.room) {
      return;
    }

    const serialized = JSON.stringify(nextSnapshot);

    if (serialized === lastSnapshot) {
      return;
    }

    lastSnapshot = serialized;
    onSnapshot(nextSnapshot);
  };

  const refreshSnapshot = async () => {
    const { data, error } = await supabase
      .from("game_rooms")
      .select("code, host_user_id, state")
      .eq("code", code)
      .maybeSingle<RoomRow>();

    if (!error) {
      publish(data?.state ?? null);
    }
  };

  void refreshSnapshot();
  const poller = window.setInterval(() => void refreshSnapshot(), 1200);

  let channel: RealtimeChannel | null = supabase
    .channel(`north-tash-room-${code}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "game_rooms", filter: `code=eq.${code}` },
      (payload) => {
        const nextSnapshot = (payload.new as RoomRow).state;

        publish(nextSnapshot);
      },
    )
    .subscribe();

  return () => {
    window.clearInterval(poller);
    if (channel) {
      void supabase.removeChannel(channel);
      channel = null;
    }
  };
}
