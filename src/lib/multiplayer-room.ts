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

export async function joinMultiplayerRoom(code: string, playerId: string) {
  const supabase = getSupabaseBrowserClient();
  const userId = await ensureAnonymousSession();

  if (!supabase || !userId) {
    return null;
  }

  const { error: memberError } = await supabase.from("game_room_members").upsert(
    { room_code: code, user_id: userId, player_id: playerId },
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

  return { userId, snapshot: room.state };
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

  let channel: RealtimeChannel | null = supabase
    .channel(`north-tash-room-${code}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "game_rooms", filter: `code=eq.${code}` },
      (payload) => {
        const nextSnapshot = (payload.new as RoomRow).state;

        if (nextSnapshot?.room) {
          onSnapshot(nextSnapshot);
        }
      },
    )
    .subscribe();

  return () => {
    if (channel) {
      void supabase.removeChannel(channel);
      channel = null;
    }
  };
}
