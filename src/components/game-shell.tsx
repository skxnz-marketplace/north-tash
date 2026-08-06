"use client";

import {
  ArrowLeft,
  ArrowRightLeft,
  Coins,
  Download,
  LogIn,
  LogOut,
  Menu,
  Play,
  Plus,
  RotateCcw,
  Trophy,
  Users,
  X,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, SVGProps } from "react";
import { useLayoutEffect } from "react";
import { gsap } from "gsap";
import * as PlayingCards from "@letele/playing-cards/dist/index.esm.js";
import {
  createMultiplayerRoom,
  cleanupOwnStaleMemberships,
  createPrivateReveals,
  ensureAnonymousSession,
  joinMultiplayerRoom,
  listPendingGameActions,
  loadPrivateHand,
  loadPrivateReveals,
  markGameActionProcessed,
  leaveMultiplayerRoom,
  saveMultiplayerSnapshot,
  savePrivateHands,
  stripPrivateHands,
  subscribeToMultiplayerRoom,
  submitGameAction,
  touchMultiplayerMembership,
  withMultiplayerTimeout,
} from "@/lib/multiplayer-room";
import { isSupabaseConfigured } from "@/lib/supabase-client";

import {
  AFLATOON_RULES,
  describeCenterCard,
  evaluateHand,
  formatCard,
  rupeesForChips,
} from "@/lib/aflatoon";
import type { Card, GameMode } from "@/lib/aflatoon";
import {
  buyInChips,
  calculatePlayerSettlements,
  calculateTransferObligations,
  canUserAct,
  createTableFromPlayers,
  createShowRequest,
  foldPlayer,
  getActiveCenter,
  getActivePlayers,
  getCurrentPlayer,
  makeRoomCode,
  netPlayerSettlements,
  payBoot,
  playChaal,
  queueBuyInRequest,
  queueTransferRequest,
  requestBackShow,
  resolveBuyInRequest,
  resolveTransferRequest,
  respondToShowRequest,
  runBotTurn,
  standPlayer,
  startNextHand,
  transferPlayerChips,
} from "@/lib/local-game";
import type {
  BuyInRequest,
  LogTone,
  TablePlayer,
  TableState,
  TransferLedgerEntry,
} from "@/lib/local-game";

type Screen = "landing" | "room-code" | "buy-in" | "lobby" | "table";
type RoomMode = "create" | "join";

type LobbyPlayer = {
  id: string;
  name: string;
  chips: number;
  isBot?: boolean;
  isHost: boolean;
};

type RoomState = {
  code: string;
  hostId: string;
  players: LobbyPlayer[];
};

type Overlay = {
  tone: "neutral" | "good" | "warn";
  text: string;
};

type PendingShow = {
  requestId: string;
  requesterId: string;
  defenderId: string;
  label: "Show" | "Back show";
};

type TransferDraft = {
  amount: number;
  targetId: string;
};

type TestRoomScenario = "bot-owner" | "player-owner" | null;

type IncomingChipRequest = {
  fromId: string;
  fromName: string;
  amount: number;
};

type NormalBotRequestStage = "idle" | "personal-pending" | "personal-approved" | "buy-in-pending" | "done";

type ChipMotion = {
  direction: "to-pot" | "to-stack";
  amount: number;
  key: number;
};

type CardSvgComponent = (props: SVGProps<SVGSVGElement>) => ReactNode;

const ROOM_PREFIX = "north-tash-room-";
const ACTIVE_ROOM_KEY = "north-tash-active-room";
const HIDDEN_HAND_PLACEHOLDERS: Card[] = [
  { rank: "2", suit: "clubs" },
  { rank: "3", suit: "clubs" },
  { rank: "4", suit: "clubs" },
];

export function normalizeSharedTable(value: unknown): TableState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<TableState>;
  const validPhase =
    candidate.phase === "collecting-boots" ||
    candidate.phase === "playing" ||
    candidate.phase === "hand-complete";

  if (
    !validPhase ||
    typeof candidate.roomCode !== "string" ||
    !Array.isArray(candidate.players) ||
    candidate.players.length < AFLATOON_RULES.minPlayers ||
    !Array.isArray(candidate.centerHistory) ||
    (candidate.phase !== "collecting-boots" && candidate.centerHistory.length === 0) ||
    !Number.isInteger(candidate.turnIndex) ||
    !Number.isInteger(candidate.dealerIndex)
  ) {
    return null;
  }

  return {
    ...(candidate as TableState),
    userId: "",
    revision:
      typeof candidate.revision === "number" && Number.isFinite(candidate.revision)
        ? candidate.revision
        : 0,
    deck: Array.isArray(candidate.deck) ? candidate.deck : [],
    log: Array.isArray(candidate.log) ? candidate.log : [],
    revealedPlayerIds: Array.isArray(candidate.revealedPlayerIds)
      ? candidate.revealedPlayerIds
      : [],
    players: candidate.players.map((player) => ({
      ...player,
      hand: Array.isArray(player.hand) ? player.hand : [],
    })),
    pendingBuyInRequests: Array.isArray(candidate.pendingBuyInRequests)
      ? candidate.pendingBuyInRequests
      : [],
    pendingTransferRequests: Array.isArray(candidate.pendingTransferRequests)
      ? candidate.pendingTransferRequests
      : [],
    transferLedger: Array.isArray(candidate.transferLedger) ? candidate.transferLedger : [],
    pendingBootPlayerIds: Array.isArray(candidate.pendingBootPlayerIds)
      ? candidate.pendingBootPlayerIds
      : [],
  };
}

export function GameShell() {
  const [screen, setScreen] = useState<Screen>("landing");
  const [roomMode, setRoomMode] = useState<RoomMode>("create");
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [buyIn, setBuyIn] = useState<number>(AFLATOON_RULES.startingChips);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [table, setTable] = useState<TableState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [pendingShow, setPendingShow] = useState<PendingShow | null>(null);
  const [chipRequests, setChipRequests] = useState<BuyInRequest[]>([]);
  const [temporaryRevealIds, setTemporaryRevealIds] = useState<string[]>([]);
  const [sessionTallyOpen, setSessionTallyOpen] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [testModeOpen, setTestModeOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [transferDraft, setTransferDraft] = useState<TransferDraft | null>(null);
  const [pendingFold, setPendingFold] = useState(false);
  const [chipMotion, setChipMotion] = useState<ChipMotion | null>(null);
  const [testRoomScenario, setTestRoomScenario] = useState<TestRoomScenario>(null);
  const [incomingChipRequest, setIncomingChipRequest] = useState<IncomingChipRequest | null>(null);
  const [onlineUserId, setOnlineUserId] = useState<string | null>(null);
  const [joinPending, setJoinPending] = useState(false);
  const [lobbyPending, setLobbyPending] = useState(false);
  const [pendingOnlineRoom, setPendingOnlineRoom] = useState<RoomState | null>(null);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [turnRemainingMs, setTurnRemainingMs] = useState(
    AFLATOON_RULES.turnTimerSeconds * 1000,
  );
  const generatedPlayerId = useId().replaceAll(":", "");
  const localPlayerId = `p-${generatedPlayerId}`;
  const currentPlayerId = onlineUserId ? `p-${onlineUserId}` : localPlayerId;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const chipRequestSeqRef = useRef(1);
  const turnKey = table
    ? `${table.handNumber}:${table.actionCount}:${table.turnIndex}:${table.phase}`
    : "idle";
  const turnIsPlaying = table?.phase === "playing";
  const sharedChipRequests = table?.pendingBuyInRequests ?? [];
  const displayedChipRequests = [
    ...sharedChipRequests,
    ...chipRequests.filter(
      (request) => !sharedChipRequests.some((shared) => shared.id === request.id),
    ),
  ];
  const incomingTransferRequest = table?.pendingTransferRequests?.find(
    (request) => request.targetId === table.userId,
  );
  const multiplayerRoomCode = room?.code ?? "";
  const previousPotRef = useRef<number | null>(null);
  const chipMotionSeqRef = useRef(0);
  const testRequestStartedRef = useRef(false);
  const normalBotRequestStageRef = useRef<NormalBotRequestStage>("idle");
  const normalBotBuyInTriggerRef = useRef<number | null>(null);
  const applyingRemoteSnapshotRef = useRef(false);
  const canonicalRevisionRef = useRef(0);
  const processingActionIdsRef = useRef(new Set<string>());
  const tableRef = useRef<TableState | null>(null);
  const pendingActionRevisionRef = useRef<number | null>(null);
  const announcedBuyInRequestIdsRef = useRef(new Set<string>());
  const announcedTransferRequestIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const savedSession = readActiveRoomSession();

    if (!savedSession || !isSupabaseConfigured()) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const userId = await withMultiplayerTimeout(
          ensureAnonymousSession(),
          "Room reconnect timed out.",
        );

        if (!userId) {
          throw new Error("Online room service is unavailable.");
        }

        const joined = await withMultiplayerTimeout(
          joinMultiplayerRoom(savedSession.code, {
            id: `p-${userId}`,
            name: savedSession.name,
            chips: savedSession.chips,
          }),
          "Room reconnect timed out.",
        );

        if (cancelled || !joined?.snapshot.room) {
          return;
        }

        const restoredRoom = joined.snapshot.room as unknown as RoomState;
        setOnlineUserId(userId);
        setPlayerName(savedSession.name);
        setBuyIn(savedSession.chips);
        setRoomCode(savedSession.code);
        setRoom(restoredRoom);
        setPendingOnlineRoom(restoredRoom);
        setScreen(joined.snapshot.table ? "table" : "lobby");
      } catch {
        clearActiveRoomSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    tableRef.current = table;
  }, [table]);

  const showOverlay = useCallback((text: string, tone: Overlay["tone"]) => {
    setOverlay({ text, tone });
    window.setTimeout(() => setOverlay(null), 2600);
  }, []);

  useEffect(() => {
    if (!table || room?.hostId !== table.userId) {
      return;
    }

    const unseenRequest = (table.pendingBuyInRequests ?? []).find(
      (request) => !announcedBuyInRequestIdsRef.current.has(request.id),
    );

    if (!unseenRequest) {
      return;
    }

    announcedBuyInRequestIdsRef.current.add(unseenRequest.id);
    setMenuOpen(true);
    showOverlay(
      `${unseenRequest.playerName} requested ${unseenRequest.chips} buy-in chips`,
      "neutral",
    );
  }, [room?.hostId, showOverlay, table]);

  useEffect(() => {
    if (!incomingTransferRequest) {
      return;
    }

    if (announcedTransferRequestIdsRef.current.has(incomingTransferRequest.id)) {
      return;
    }

    announcedTransferRequestIdsRef.current.add(incomingTransferRequest.id);
    showOverlay(
      `${incomingTransferRequest.requesterName} requested ${incomingTransferRequest.amount} chips`,
      "neutral",
    );
  }, [incomingTransferRequest, showOverlay]);

  useEffect(() => {
    if (
      actionPending &&
      pendingActionRevisionRef.current !== null &&
      table &&
      table.revision > pendingActionRevisionRef.current
    ) {
      pendingActionRevisionRef.current = null;
      setActionPending(false);
    }
  }, [actionPending, table]);

  useEffect(() => {
    if (!actionPending) {
      return;
    }

    const timeout = window.setTimeout(() => {
      pendingActionRevisionRef.current = null;
      setActionPending(false);
      showOverlay("Action was not acknowledged. Please try again.", "warn");
    }, 12000);

    return () => window.clearTimeout(timeout);
  }, [actionPending, showOverlay]);

  const dispatchGameAction = useCallback((
    actionType: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!table || actionPending) {
      return false;
    }

    if (!multiplayerRoomCode || !onlineUserId || !isSupabaseConfigured()) {
      return false;
    }

    setActionPending(true);
    pendingActionRevisionRef.current = table.revision;
    void submitGameAction(multiplayerRoomCode, onlineUserId, {
      actionType,
      payload,
      baseRevision: table.revision,
    }).catch((error) => {
      pendingActionRevisionRef.current = null;
      setActionPending(false);
      showOverlay(error instanceof Error ? error.message : "Action failed", "warn");
    });
    return true;
  }, [actionPending, multiplayerRoomCode, onlineUserId, showOverlay, table]);

  useEffect(() => {
    if (!room?.code || !onlineUserId || room.hostId !== currentPlayerId || !table) {
      return;
    }

    let cancelled = false;
    const processActions = async () => {
      let actions;

      try {
        actions = await listPendingGameActions(room.code);
      } catch (error) {
        showOverlay(error instanceof Error ? error.message : "Action sync failed", "warn");
        return;
      }

      for (const action of actions) {
        if (cancelled || !action.id || processingActionIdsRef.current.has(action.id)) {
          continue;
        }

        processingActionIdsRef.current.add(action.id);
        const current = tableRef.current;
        const actorId = action.actorUserId ? `p-${action.actorUserId}` : "";

        if (!current || action.baseRevision !== current.revision) {
          await markGameActionProcessed(action.id, { ok: false, reason: "stale_revision" }).catch(() => undefined);
          continue;
        }

        let next = current;
        const requestId = String(action.payload.requestId ?? action.id);

        if (action.actionType === "pay_boot") {
          next = payBoot(current, actorId, Date.now() + 3300);
        } else if (action.actionType === "chaal") {
          next = playChaal(current, actorId);
        } else if (action.actionType === "fold") {
          next = foldPlayer(current, actorId);
        } else if (action.actionType === "show_request") {
          next = createShowRequest(
            current,
            actorId,
            requestId,
            action.payload.label === "Show" ? "Show" : "Back show",
          );
        } else if (action.actionType === "show_response") {
          if (current.pendingShow?.defenderId !== actorId) {
            await markGameActionProcessed(action.id, { ok: false, reason: "not_defender" }).catch(() => undefined);
            continue;
          }
          next = respondToShowRequest(
            current,
            current.pendingShow.requesterId,
            action.payload.response === "accept" ? "accept" : "decline",
          );
        } else if (action.actionType === "buy_in_self") {
          const chips = Number(action.payload.chips);
          if (actorId !== room.hostId || (chips !== 10 && chips !== 20)) {
            await markGameActionProcessed(action.id, { ok: false, reason: "invalid_buy_in" }).catch(() => undefined);
            continue;
          }
          next = buyInChips(current, actorId, chips);
        } else if (action.actionType === "buy_in_request") {
          const chips = Number(action.payload.chips);
          const player = current.players.find((candidate) => candidate.id === actorId);
          if (!player || (chips !== 10 && chips !== 20)) {
            await markGameActionProcessed(action.id, { ok: false, reason: "invalid_buy_in_request" }).catch(() => undefined);
            continue;
          }
          next = queueBuyInRequest(current, {
            id: requestId,
            playerId: actorId,
            playerName: player.name,
            chips,
          });
        } else if (action.actionType === "buy_in_response") {
          if (actorId !== room.hostId) {
            await markGameActionProcessed(action.id, { ok: false, reason: "not_host" }).catch(() => undefined);
            continue;
          }
          next = resolveBuyInRequest(
            current,
            requestId,
            action.payload.response === "accept" ? "accept" : "decline",
          );
        } else if (action.actionType === "transfer_request") {
          const targetId = String(action.payload.targetId ?? "");
          const amount = Number(action.payload.amount);
          const requester = current.players.find((candidate) => candidate.id === actorId);
          next = requester
            ? queueTransferRequest(current, {
                id: requestId,
                requesterId: actorId,
                requesterName: requester.name,
                targetId,
                amount,
              })
            : current;
        } else if (action.actionType === "transfer_response") {
          next = resolveTransferRequest(
            current,
            requestId,
            actorId,
            action.payload.response === "accept" ? "accept" : "decline",
          );
        }

        if (next === current) {
          await markGameActionProcessed(action.id, { ok: false, reason: "invalid_action" }).catch(() => undefined);
          continue;
        }

        next = { ...next, revision: current.revision + 1 };
        canonicalRevisionRef.current = next.revision;
        setPendingShow(
          next.pendingShow
            ? {
                requestId: next.pendingShow.requestId,
                requesterId: next.pendingShow.requesterId,
                defenderId: next.pendingShow.defenderId,
                label: next.pendingShow.label,
              }
            : null,
        );

        if (next.privateReveal) {
          const revealPlayers = next.privateReveal.playerIds
            .map((playerId) => next.players.find((player) => player.id === playerId))
            .filter(Boolean)
            .map((player) => ({ playerId: player!.id, hand: player!.hand }));
          const revealRows = next.privateReveal.viewerIds.flatMap((viewerId) =>
            revealPlayers.map((player) => ({
              userId: viewerId.replace(/^p-/, ""),
              playerId: player.playerId,
              hand: player.hand,
            })),
          );
          await createPrivateReveals(room.code, next.privateReveal.requestId, revealRows).catch(() => undefined);
        }

        setTable(next);
        await markGameActionProcessed(action.id, { ok: true, revision: next.revision }).catch(() => undefined);
      }
    };

    void processActions();
    const interval = window.setInterval(() => void processActions(), 350);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [currentPlayerId, onlineUserId, room?.code, room?.hostId, showOverlay, table]);

  useEffect(() => {
    if (!room?.code) {
      return;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== roomKey(room.code) || !event.newValue) {
        return;
      }

      const nextRoom = parseRoom(event.newValue);

      if (nextRoom) {
        setRoom(nextRoom);
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [room?.code]);

  useEffect(() => {
    if (!room?.code || !isSupabaseConfigured()) {
      return;
    }

    const unsubscribe = subscribeToMultiplayerRoom(room.code, (snapshot) => {
      const sharedTable = normalizeSharedTable(snapshot.table);

      if (snapshot.table && !sharedTable) {
        showOverlay("Waiting for a complete table update", "warn");
        return;
      }

      if (
        sharedTable &&
        room.hostId === currentPlayerId &&
        sharedTable.revision <= canonicalRevisionRef.current
      ) {
        return;
      }

      applyingRemoteSnapshotRef.current = true;
      setRoom(snapshot.room as unknown as RoomState);
      if (sharedTable) {
        canonicalRevisionRef.current = Math.max(
          canonicalRevisionRef.current,
          sharedTable.revision,
        );
        setPendingShow(
          sharedTable.pendingShow
            ? {
                requestId: sharedTable.pendingShow.requestId,
                requesterId: sharedTable.pendingShow.requesterId,
                defenderId: sharedTable.pendingShow.defenderId,
                label: sharedTable.pendingShow.label,
              }
            : null,
        );
        setTable((currentTable) => ({
          ...sharedTable,
          userId: currentPlayerId,
          players: sharedTable.players.map((player) => {
            const currentPlayer = currentTable?.players.find(
              (candidate) => candidate.id === player.id,
            );
            const canKeepPrivateHand =
              currentTable?.handNumber === sharedTable.handNumber &&
              currentPlayer?.hand.length === 3 &&
              (player.id === currentPlayerId ||
                Boolean(currentTable.privateReveal?.playerIds.includes(player.id)));

            return {
              ...player,
              hand: canKeepPrivateHand ? currentPlayer.hand : [],
            };
          }),
        }));
        setScreen("table");

        const loadProtectedCards = async () => {
          let protectedState: [
            unknown[],
            Awaited<ReturnType<typeof loadPrivateReveals>>,
          ] = [[], []];

          for (let attempt = 0; attempt < 5; attempt += 1) {
            protectedState = await Promise.all([
              loadPrivateHand(room.code, onlineUserId ?? ""),
              loadPrivateReveals(room.code, onlineUserId ?? ""),
            ]);

            if (protectedState[0].length === 3) {
              break;
            }

            await new Promise((resolve) => window.setTimeout(resolve, 300));
          }

          return protectedState;
        };

        void loadProtectedCards()
          .then(([hand, reveals]) => {
            setTable((currentTable) => {
              if (!currentTable || currentTable.revision !== sharedTable.revision) {
                return currentTable;
              }

              const revealMap = new Map(reveals.map((reveal) => [reveal.playerId, reveal.hand]));
              return {
                ...currentTable,
                privateReveal: reveals[0]
                  ? {
                      requestId: reveals[0].requestId,
                      playerIds: reveals.map((reveal) => reveal.playerId),
                      viewerIds: [currentPlayerId],
                      expiresAt: Math.max(...reveals.map((reveal) => reveal.expiresAt)),
                    }
                  : undefined,
                players: currentTable.players.map((player) => ({
                  ...player,
                  hand:
                    player.id === currentPlayerId
                      ? (hand as typeof player.hand)
                      : (revealMap.get(player.id) as typeof player.hand | undefined) ?? [],
                })),
              };
            });
          })
          .catch(() => showOverlay("Protected cards are still loading", "warn"));
      } else {
        setTable(null);
      }
      window.setTimeout(() => {
        applyingRemoteSnapshotRef.current = false;
      }, 0);
    });

    return unsubscribe;
  }, [currentPlayerId, onlineUserId, room?.code, room?.hostId, showOverlay]);

  useEffect(() => {
    if (!room?.code || !onlineUserId || testRoomScenario) {
      return;
    }

    const heartbeat = window.setInterval(() => {
      void touchMultiplayerMembership(room.code, onlineUserId).catch(() => undefined);
    }, 10000);

    return () => window.clearInterval(heartbeat);
  }, [onlineUserId, room?.code, testRoomScenario]);

  useEffect(() => {
    const startAt = table?.startAt;

    if (!startAt) {
      return;
    }

    const interval = window.setInterval(() => setCountdownNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [table?.startAt]);

  useEffect(() => {
    if (!table?.privateReveal) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setTable((currentTable) => {
        if (!currentTable?.privateReveal) {
          return currentTable;
        }

        return {
          ...currentTable,
          privateReveal: undefined,
          players: currentTable.players.map((player) =>
            player.id === currentPlayerId || currentTable.revealedPlayerIds.includes(player.id)
              ? player
              : { ...player, hand: [] },
          ),
        };
      });
    }, Math.max(0, table.privateReveal.expiresAt - Date.now()));

    return () => window.clearTimeout(timeout);
  }, [currentPlayerId, table?.privateReveal]);

  const countdownRemaining = table?.startAt
    ? Math.max(0, table.startAt - countdownNow) > 0
      ? Math.ceil((table.startAt - countdownNow) / 1000)
      : null
    : null;

  useEffect(() => {
    if (
      !room?.code ||
      !onlineUserId ||
      !table ||
      room.hostId !== currentPlayerId ||
      applyingRemoteSnapshotRef.current
    ) {
      return;
    }

    canonicalRevisionRef.current = Math.max(table.revision, canonicalRevisionRef.current);
    const canonicalTable = table;
    const timeout = window.setTimeout(() => {
      void Promise.all([
        saveMultiplayerSnapshot(
          room.code,
          stripPrivateHands({
            room: room as unknown as Record<string, unknown>,
            table: canonicalTable as unknown as Record<string, unknown>,
          }),
        ),
        savePrivateHands(room.code, canonicalTable.players),
      ]).catch(() => showOverlay("Online sync paused", "warn"));
    }, 180);

    return () => window.clearTimeout(timeout);
  }, [currentPlayerId, onlineUserId, room, showOverlay, table]);

  useEffect(() => {
    if (!table) {
      previousPotRef.current = null;
      return;
    }

    const previousPot = previousPotRef.current;
    previousPotRef.current = table.pot;

    if (previousPot === null || previousPot === table.pot) {
      return;
    }

    const direction = table.pot > previousPot ? "to-pot" : "to-stack";
    const amount = Math.abs(table.pot - previousPot);
    chipMotionSeqRef.current += 1;
    setChipMotion({ direction, amount, key: chipMotionSeqRef.current });

    const timeout = window.setTimeout(() => setChipMotion(null), 1050);
    return () => window.clearTimeout(timeout);
  }, [table]);

  useEffect(() => {
    if (!turnIsPlaying || actionPending || pendingShow || pendingFold || sessionEnded) {
      return;
    }

    const duration = AFLATOON_RULES.turnTimerSeconds * 1000;
    const deadline = Date.now() + duration;
    const initialFrame = window.requestAnimationFrame(() => setTurnRemainingMs(duration));

    const interval = window.setInterval(() => {
      setTurnRemainingMs(Math.max(0, deadline - Date.now()));
    }, 100);

    const timeout = window.setTimeout(() => {
      const currentTable = tableRef.current;

      if (!currentTable || !canUserAct(currentTable)) {
        return;
      }

      if (room?.code && onlineUserId && isSupabaseConfigured()) {
        if (dispatchGameAction("chaal")) {
          showOverlay("Auto chaal sent", "warn");
        }
        return;
      }

      setTable(playChaal(currentTable, currentTable.userId));
      showOverlay("Auto chaal played", "warn");
    }, duration);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(initialFrame);
    };
  }, [
    actionPending,
    dispatchGameAction,
    onlineUserId,
    pendingFold,
    pendingShow,
    room?.code,
    sessionEnded,
    showOverlay,
    turnKey,
    turnIsPlaying,
  ]);

  useEffect(() => {
    if (!table || !testRoomScenario || testRequestStartedRef.current) {
      return;
    }

    testRequestStartedRef.current = true;
    const bot = table.players.find((player) => player.isBot);

    if (!bot) {
      return;
    }

    const timeout = window.setTimeout(() => {
      if (testRoomScenario === "bot-owner") {
        setIncomingChipRequest({ fromId: bot.id, fromName: bot.name, amount: 4 });
        showOverlay(`${bot.name} requested 4 chips from you`, "neutral");
      } else {
        const request: BuyInRequest = {
          id: `test-buy-in-${chipRequestSeqRef.current}`,
          playerId: bot.id,
          playerName: bot.name,
          chips: 10,
        };
        chipRequestSeqRef.current += 1;
        setChipRequests([request]);
        setMenuOpen(true);
        showOverlay(`${bot.name} requested a 10-chip buy-in`, "neutral");
      }
    }, 1100);

    return () => window.clearTimeout(timeout);
  }, [showOverlay, table, testRoomScenario]);

  useEffect(() => {
    const currentPlayer = table ? getCurrentPlayer(table) : null;

    if (
      !table ||
      table.phase !== "playing" ||
      !currentPlayer?.isBot ||
      pendingShow ||
      incomingChipRequest ||
      sessionEnded ||
      (isSupabaseConfigured() && room?.hostId !== currentPlayerId)
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setTable((currentTable) => {
        if (!currentTable) {
          return currentTable;
        }

        const bot = getCurrentPlayer(currentTable);
        const active = getActivePlayers(currentTable);

        if (bot?.isBot && active.length === 2 && currentTable.actionCount >= 4) {
          const defender = active.find((player) => player.id !== bot.id);

          if (defender) {
            setPendingShow({
              requestId: `bot-show-${currentTable.actionCount}`,
              requesterId: bot.id,
              defenderId: defender.id,
              label: "Show",
            });
            showOverlay(`${bot.name} asks for show`, "neutral");
            return currentTable;
          }
        }

        const nextTable = runBotTurn(currentTable);
        const latest = nextTable.log[0]?.text ?? "Bot moved";
        showOverlay(shortActionText(latest), logToOverlayTone(nextTable.log[0]?.tone));
        return nextTable;
      });
    }, 3200);

    return () => window.clearTimeout(timeout);
  }, [currentPlayerId, incomingChipRequest, pendingShow, room?.hostId, sessionEnded, showOverlay, table?.actionCount, table?.phase, table?.turnIndex, table]);

  useEffect(() => {
    if (!table || table.phase !== "collecting-boots" || !testRoomScenario) {
      return;
    }

    const bot = table.players.find(
      (player) => player.isBot && table.pendingBootPlayerIds?.includes(player.id),
    );

    if (!bot) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setTable((currentTable) =>
        currentTable ? payBoot(currentTable, bot.id, Date.now() + 3300) : currentTable,
      );
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [table, testRoomScenario]);

  useEffect(() => {
    if (!table || table.phase !== "playing" || testRoomScenario) {
      return;
    }

    const bot = table.players.find((player) => player.isBot);
    const chaalCount = table.log.filter((entry) => /played \d+ chip/i.test(entry.text)).length;

    if (!bot || normalBotRequestStageRef.current === "done") {
      return;
    }

    if (normalBotRequestStageRef.current === "idle" && chaalCount >= 2) {
      normalBotRequestStageRef.current = "personal-pending";
      setIncomingChipRequest({ fromId: bot.id, fromName: bot.name, amount: 3 });
      showOverlay(`${bot.name} requested 3 personal chips`, "neutral");
      return;
    }

    if (
      normalBotRequestStageRef.current === "personal-approved" &&
      normalBotBuyInTriggerRef.current !== null &&
      chaalCount >= normalBotBuyInTriggerRef.current
    ) {
      const request: BuyInRequest = {
        id: `bot-buy-in-${chipRequestSeqRef.current}`,
        playerId: bot.id,
        playerName: bot.name,
        chips: 10,
      };
      chipRequestSeqRef.current += 1;
      normalBotRequestStageRef.current = "buy-in-pending";
      setChipRequests((requests) => [...requests, request]);
      setMenuOpen(true);
      showOverlay(`${bot.name} requested a 10-chip buy-in`, "neutral");
    }
  }, [showOverlay, table, testRoomScenario]);

  function showCodeScreen(mode: RoomMode) {
    const name = readPlayerName();

    setPlayerName(name);
    setFormError("");
    setRoomMode(mode);
    setRoomCode(mode === "create" ? nextRoomCode() : "");
    setScreen("room-code");
  }

  async function showBuyIn() {
    const typedCode = codeInputRef.current?.value.replace(/\D/g, "").slice(0, 3) ?? "";
    const code = typedCode || roomCode;
    const name = readPlayerName();

    if (code.length !== 3) {
      setFormError("Enter a valid 3-digit room code.");
      return;
    }

    if (roomMode === "join") {
      const existingRoom = readRoom(code);

      if (!existingRoom && !isSupabaseConfigured()) {
        setFormError(`Room ${code} was not found on this device.`);
        return;
      }

      if (existingRoom && existingRoom.players.length >= AFLATOON_RULES.maxPlayers) {
        setFormError("This room is full.");
        return;
      }

      setJoinPending(true);

      try {
        const userId = await ensureAnonymousSession();

        if (!userId) {
          throw new Error("Online room service is unavailable. Please try again.");
        }

        const playerId = `p-${userId}`;
        await cleanupOwnStaleMemberships(userId);
        const joined = await joinMultiplayerRoom(code, {
          id: playerId,
          name,
          chips: AFLATOON_RULES.startingChips,
        });

        if (!joined?.snapshot.room) {
          throw new Error(`Room ${code} was not found online.`);
        }

        setOnlineUserId(userId);
        setPendingOnlineRoom(joined.snapshot.room as unknown as RoomState);
        setRoomCode(code);
        setFormError("");
        setScreen("buy-in");
      } catch (error) {
        setFormError(
          error instanceof Error
            ? error.message
            : `Room ${code} could not be joined. Check the code and try again.`,
        );
      } finally {
        setJoinPending(false);
      }

      return;
    }

    setFormError("");
    setRoomCode(code);
    setPlayerName(name);
    setScreen("buy-in");
  }

  async function enterLobby() {
    if (lobbyPending) {
      return;
    }

    setLobbyPending(true);
    setFormError("");

    try {
      let authenticatedUserId = onlineUserId;

      if (isSupabaseConfigured()) {
        authenticatedUserId = await withMultiplayerTimeout(
          ensureAnonymousSession(),
          "Supabase sign-in timed out. Please try again.",
        );
        setOnlineUserId(authenticatedUserId);
      }

      const playerId = authenticatedUserId ? `p-${authenticatedUserId}` : localPlayerId;
      const player: LobbyPlayer = {
        id: playerId,
        name: readPlayerName(),
        chips: buyIn,
        isHost: roomMode === "create",
      };
      const existingRoom = readRoom(roomCode);
      let nextRoom: RoomState;

      if (roomMode === "create") {
        nextRoom = {
          code: roomCode,
          hostId: player.id,
          players: [player],
        };

        if (authenticatedUserId && isSupabaseConfigured()) {
          await withMultiplayerTimeout(
            createMultiplayerRoom(roomCode, player.id, {
              room: nextRoom as unknown as Record<string, unknown>,
              table: null,
            }),
            "Room creation timed out. Please try again.",
          );
        }
      } else {
        const onlineRoom = pendingOnlineRoom?.code === roomCode ? pendingOnlineRoom : null;
        const baseRoom = isSupabaseConfigured() ? onlineRoom : existingRoom;

        if (!baseRoom) {
          throw new Error(`Room ${roomCode} was not found online. Go back and check the code.`);
        }

        nextRoom = upsertPlayer(baseRoom, { ...player, isHost: baseRoom.hostId === player.id });
      }

      saveRoom(nextRoom);
      saveActiveRoomSession({ code: nextRoom.code, name: player.name, chips: player.chips });
      setPendingOnlineRoom(null);
      setRoom(nextRoom);
      setTable(null);
      setSessionEnded(false);
      setChipRequests([]);
      setTestRoomScenario(null);
      setIncomingChipRequest(null);
      normalBotRequestStageRef.current = "idle";
      normalBotBuyInTriggerRef.current = null;
      setScreen("lobby");
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Could not enter the lobby. Please try again.",
      );
    } finally {
      setLobbyPending(false);
    }
  }

  function enterTestRoom(scenario: Exclude<TestRoomScenario, null>) {
    const name = readPlayerName();
    const botIsHost = scenario === "bot-owner";
    const bot: LobbyPlayer = {
      id: botIsHost ? "test-room-bot-owner" : "test-room-bot-player",
      name: botIsHost ? "Bot Room Owner" : "Bot Buyer",
      chips: AFLATOON_RULES.startingChips,
      isBot: true,
      isHost: botIsHost,
    };
    const user: LobbyPlayer = { id: localPlayerId, name, chips: buyIn, isHost: !botIsHost };
    const roomCode = botIsHost ? "901" : "902";
    const nextRoom: RoomState = {
      code: roomCode,
      hostId: botIsHost ? bot.id : user.id,
      players: botIsHost ? [bot, user] : [user, bot],
    };

    setTestModeOpen(false);
    setTestRoomScenario(scenario);
    setOnlineUserId(null);
    testRequestStartedRef.current = false;
    normalBotRequestStageRef.current = "done";
    normalBotBuyInTriggerRef.current = null;
    setRoom(nextRoom);
    setRoomCode(roomCode);
    setChipRequests([]);
    setIncomingChipRequest(null);
    setSessionEnded(false);
    setTable(
      createTableFromPlayers({
        roomCode,
        userId: localPlayerId,
        players: nextRoom.players,
        seed: botIsHost ? 901 : 902,
      }),
    );
    setScreen("table");
  }

  function startHand() {
    if (!room || room.players.length < AFLATOON_RULES.minPlayers) {
      showOverlay("Waiting for one more player", "warn");
      return;
    }

    normalBotRequestStageRef.current = "idle";
    normalBotBuyInTriggerRef.current = null;
    setIncomingChipRequest(null);
    setChipRequests([]);
    const nextTable = createTableFromPlayers({
        roomCode: room.code,
        userId: currentPlayerId,
        players: room.players,
        startAt: Date.now() + 3300,
      });
    nextTable.revision = 1;
    canonicalRevisionRef.current = nextTable.revision;
    setTable(nextTable);
    setScreen("table");
  }

  function payUserBoot() {
    if (!table || table.phase !== "collecting-boots" || actionPending) {
      return;
    }

    if (dispatchGameAction("pay_boot")) {
      showOverlay("Boot sent to the pot", "good");
      return;
    }

    setActionPending(true);
    setTable((currentTable) =>
      currentTable ? payBoot(currentTable, currentTable.userId, Date.now() + 3300) : currentTable,
    );
    window.setTimeout(() => setActionPending(false), 250);
  }

  function requestChips(chips: 10 | 20) {
    if (!table || actionPending) {
      return;
    }

    const player = table.players.find((currentPlayer) => currentPlayer.id === table.userId);

    if (!player) {
      return;
    }

    if (room?.code && onlineUserId && isSupabaseConfigured()) {
      const isHostRequest = room.hostId === table.userId;
      const requestId = `buy-in-${crypto.randomUUID()}`;
      if (
        dispatchGameAction(isHostRequest ? "buy_in_self" : "buy_in_request", {
          chips,
          requestId,
        })
      ) {
        showOverlay(
          isHostRequest ? `${chips} chips requested` : `${chips}-chip request sent to owner`,
          "neutral",
        );
        setMenuOpen(false);
      }
      return;
    }

    if (room?.hostId === table.userId) {
      setTable((currentTable) =>
        currentTable ? buyInChips(currentTable, currentTable.userId, chips) : currentTable,
      );
      showOverlay(`${chips} chips added`, "good");
      setMenuOpen(false);
      return;
    }

    const existingRequest = chipRequests.find(
      (request) => request.playerId === player.id && request.chips === chips,
    );

    if (existingRequest) {
      showOverlay("Chip request already pending", "warn");
      setMenuOpen(false);
      return;
    }

    const request: BuyInRequest = {
      id: `chip-request-${chipRequestSeqRef.current}`,
      playerId: player.id,
      playerName: player.name,
      chips,
    };
    chipRequestSeqRef.current += 1;
    setChipRequests((requests) => [...requests, request]);
    showOverlay(`${player.name} requested ${chips} chips`, "neutral");
    setMenuOpen(false);
  }

  function approveChipRequest(requestId: string) {
    const sharedRequest = sharedChipRequests.find(
      (currentRequest) => currentRequest.id === requestId,
    );
    const request = sharedRequest ?? chipRequests.find(
      (currentRequest) => currentRequest.id === requestId,
    );

    if (!request) {
      return;
    }

    if (sharedRequest && dispatchGameAction("buy_in_response", { requestId, response: "accept" })) {
      showOverlay(`${request.chips}-chip approval sent`, "good");
      return;
    }

    setTable((currentTable) =>
      currentTable ? buyInChips(currentTable, request.playerId, request.chips) : currentTable,
    );
    setChipRequests((requests) => requests.filter((currentRequest) => currentRequest.id !== requestId));
    showOverlay(`${request.chips} chips approved`, "good");
  }

  function rejectChipRequest(requestId: string) {
    const sharedRequest = sharedChipRequests.find(
      (currentRequest) => currentRequest.id === requestId,
    );
    const request = sharedRequest ?? chipRequests.find(
      (currentRequest) => currentRequest.id === requestId,
    );

    if (sharedRequest && dispatchGameAction("buy_in_response", { requestId, response: "decline" })) {
      showOverlay(`${request?.playerName ?? "Player"}'s request declined`, "warn");
      return;
    }

    setChipRequests((requests) => requests.filter((currentRequest) => currentRequest.id !== requestId));
    if (normalBotRequestStageRef.current === "buy-in-pending") {
      normalBotRequestStageRef.current = "done";
    }
    showOverlay(request ? `${request.playerName}'s chip request rejected` : "Request rejected", "warn");
  }

  function respondToIncomingChipRequest(approved: boolean) {
    if (!incomingChipRequest || !table) {
      return;
    }

    const request = incomingChipRequest;
    setIncomingChipRequest(null);

    if (!approved) {
      if (!testRoomScenario && normalBotRequestStageRef.current === "personal-pending") {
        normalBotRequestStageRef.current = "done";
      }
      showOverlay(`${request.fromName}'s request rejected`, "warn");
      return;
    }

    setTable((currentTable) =>
      currentTable
        ? transferPlayerChips(
            currentTable,
            currentTable.userId,
            request.fromId,
            request.amount,
            Math.min(request.amount, currentTable.players.find((player) => player.id === currentTable.userId)?.chips ?? 0),
          )
        : currentTable,
    );
    if (!testRoomScenario && normalBotRequestStageRef.current === "personal-pending") {
      const chaalCount = table.log.filter((entry) => /played \d+ chip/i.test(entry.text)).length;
      normalBotRequestStageRef.current = "personal-approved";
      normalBotBuyInTriggerRef.current = chaalCount + 2;
    }
    showOverlay(`${request.amount} chips sent to ${request.fromName}`, "good");
  }

  function handleBackShow() {
    if (!table || !canUserAct(table)) {
      return;
    }

    const requester = getCurrentPlayer(table);
    const active = getActivePlayers(table);
    const defender =
      active.length === 2
        ? active.find((player) => player.id !== requester.id)
        : table.players[
            [...table.players]
              .map((player, index) => ({ player, index }))
              .reverse()
              .find(({ index, player }) => index < table.turnIndex && player.status === "active")
              ?.index ?? active.findIndex((player) => player.id !== requester.id)
          ];

    const revealIds = [requester?.id, defender?.id].filter(Boolean) as string[];
    const label = active.length === 2 ? "Show" : "Back show";

    if (dispatchGameAction("show_request", { label, requestId: `show-${Date.now()}` })) {
      showOverlay(`${label} requested`, "neutral");
      return;
    }

    showOverlay(`${label} requested`, "neutral");

    window.setTimeout(() => {
      setTable((currentTable) => {
        if (!currentTable) {
          return currentTable;
        }

        const nextTable = requestBackShow(currentTable, currentTable.userId);
        const latest = nextTable.log[0]?.text ?? "";

        if (latest.toLowerCase().includes("declined")) {
          showOverlay(`${label} declined`, "warn");
          return nextTable;
        }

        setTemporaryRevealIds(revealIds);
        showOverlay("Cards open. Comparing hands...", "good");
        window.setTimeout(() => {
          setTable((latestTable) =>
            latestTable?.actionCount === currentTable.actionCount ? nextTable : latestTable,
          );
          setTemporaryRevealIds([]);
          showOverlay(shortActionText(nextTable.log[0]?.text ?? "Show result"), "good");
        }, 1800);
        return currentTable;
      });
    }, 900);
  }

  function endSession() {
    if (room?.code && onlineUserId) {
      void leaveMultiplayerRoom(room.code, onlineUserId, room.hostId === currentPlayerId).catch(
        () => undefined,
      );
    }
    clearActiveRoomSession();
    setSessionEnded(true);
    setSessionTallyOpen(true);
    setMenuOpen(false);
  }

  function leaveTable() {
    if (room?.code && onlineUserId) {
      void leaveMultiplayerRoom(room.code, onlineUserId, room.hostId === currentPlayerId).catch(
        () => undefined,
      );
    }
    clearActiveRoomSession();
    setTable(null);
    setRoom(null);
    setTestRoomScenario(null);
    setOnlineUserId(null);
    setIncomingChipRequest(null);
    normalBotRequestStageRef.current = "idle";
    normalBotBuyInTriggerRef.current = null;
    setMenuOpen(false);
    setScreen("landing");
  }

  function playUserChaal() {
    if (actionPending) {
      return;
    }

    if (dispatchGameAction("chaal")) {
      showOverlay("Chaal sent", "good");
      return;
    }

    setActionPending(true);
    showOverlay("Chaal", "good");
    window.setTimeout(() => {
      setTable((currentTable) =>
        currentTable ? playChaal(currentTable, currentTable.userId) : currentTable,
      );
      setActionPending(false);
    }, 850);
  }

  function requestFoldConfirmation() {
    if (!table || !canUserAct(table) || actionPending || pendingShow) {
      return;
    }

    setPendingFold(true);
    showOverlay("Confirm fold?", "warn");
  }

  function cancelFold() {
    setPendingFold(false);
    showOverlay("Fold cancelled", "neutral");
  }

  function confirmFold() {
    if (!table || !pendingFold || actionPending) {
      return;
    }

    setPendingFold(false);

    if (dispatchGameAction("fold")) {
      showOverlay("Fold sent", "warn");
      return;
    }

    setActionPending(true);
    showOverlay("Fold confirmed", "warn");
    window.setTimeout(() => {
      setTable((currentTable) =>
        currentTable ? foldPlayer(currentTable, currentTable.userId) : currentTable,
      );
      setActionPending(false);
    }, 850);
  }

  function answerPendingShow(response: "accept" | "decline") {
    if (!pendingShow || actionPending) {
      return;
    }

    const request = pendingShow;

    if (dispatchGameAction("show_response", { response })) {
      setPendingShow(null);
      showOverlay(response === "accept" ? "Show accepted" : "Show declined", response === "accept" ? "good" : "warn");
      return;
    }

    setActionPending(true);

    if (response === "decline") {
      showOverlay("Show declined", "warn");
      window.setTimeout(() => {
        setTable((currentTable) =>
          currentTable
            ? respondToShowRequest(currentTable, request.requesterId, "decline")
            : currentTable,
        );
        setPendingShow(null);
        setActionPending(false);
      }, 700);
      return;
    }

    setTemporaryRevealIds([request.requesterId, request.defenderId]);
    setPendingShow(null);
    showOverlay("Cards open. Comparing hands...", "good");
    window.setTimeout(() => {
      setTable((currentTable) =>
        currentTable
          ? respondToShowRequest(currentTable, request.requesterId, "accept")
          : currentTable,
      );
      setTemporaryRevealIds([]);
      setActionPending(false);
    }, 1800);
  }

  function openTransferRequest() {
    if (!table) {
      return;
    }

    const target = table.players.find(
      (player) => player.id !== table.userId && player.status !== "standing",
    );

    if (!target) {
      showOverlay("No player available", "warn");
      return;
    }

    setTransferDraft({ amount: 1, targetId: target.id });
    setMenuOpen(false);
  }

  function submitTransferRequest() {
    if (!table || !transferDraft) {
      return;
    }

    const target = table.players.find((player) => player.id === transferDraft.targetId);
    const amount = Math.max(1, Math.floor(transferDraft.amount));

    if (!target || target.id === table.userId || target.status === "standing") {
      showOverlay("Choose another active player", "warn");
      return;
    }

    if (room?.code && onlineUserId && isSupabaseConfigured()) {
      const requestId = `transfer-${crypto.randomUUID()}`;
      if (
        dispatchGameAction("transfer_request", {
          requestId,
          targetId: target.id,
          amount,
        })
      ) {
        setTransferDraft(null);
        showOverlay(`${amount} chips requested from ${target.name}`, "neutral");
      }
      return;
    }

    const approved = Math.min(amount, target?.chips ?? 0);
    setTransferDraft(null);
    showOverlay(`${amount} chips requested from ${target?.name ?? "player"}`, "neutral");

    window.setTimeout(() => {
      setTable((currentTable) =>
        currentTable
          ? transferPlayerChips(
              currentTable,
              transferDraft.targetId,
              currentTable.userId,
              amount,
              approved,
            )
          : currentTable,
      );
      showOverlay(
        approved > 0
          ? `${target?.name ?? "Player"} sent ${approved} chips`
          : `${target?.name ?? "Player"} declined`,
        approved > 0 ? "good" : "warn",
      );
    }, 1100);
  }

  function respondToTransferRequest(approved: boolean) {
    if (!incomingTransferRequest || actionPending) {
      return;
    }

    if (
      dispatchGameAction("transfer_response", {
        requestId: incomingTransferRequest.id,
        response: approved ? "accept" : "decline",
      })
    ) {
      showOverlay(
        approved
          ? `${incomingTransferRequest.amount} chips approved`
          : `${incomingTransferRequest.requesterName}'s request declined`,
        approved ? "good" : "warn",
      );
    }
  }

  function readPlayerName() {
    return nameInputRef.current?.value.trim() || playerName.trim() || "Player";
  }

  function nextRoomCode() {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const randomSeed =
        typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
          ? crypto.getRandomValues(new Uint32Array(1))[0]
          : Math.floor(Math.random() * 4294967296);
      const code = makeRoomCode(randomSeed);

      if (!readRoom(code)) {
        return code;
      }
    }

    return makeRoomCode(Date.now() + Math.floor(Math.random() * 900));
  }

  if (screen === "landing") {
    return (
      <main className="app-shell relative overflow-hidden">
        <PokerBackdrop featured />
        <section className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-6xl items-end px-5 py-7 sm:items-center sm:px-8 sm:py-10 lg:px-12">
          <div className="relative w-full max-w-md">
            <div className="homepage-copy mb-7 sm:mb-8">
              <p className="text-xs font-bold uppercase text-[#f0ca6b]">North Tash</p>
              <h1 className="mt-2 text-5xl font-black leading-none text-white sm:text-6xl">
                Aflatoon
              </h1>
              <p className="mt-3 max-w-sm text-base font-medium text-white/78">
                Your private table for a proper night of tash.
              </p>
            </div>

            <EntryPanel
              nameInputRef={nameInputRef}
              playerName={playerName}
              setPlayerName={setPlayerName}
              onCreate={() => showCodeScreen("create")}
              onJoin={() => showCodeScreen("join")}
              onTestMode={() => setTestModeOpen(true)}
            />
            {testModeOpen ? (
              <TestModePanel
                name={playerName}
                onBack={() => setTestModeOpen(false)}
                onSelect={enterTestRoom}
              />
            ) : null}
          </div>
        </section>
      </main>
    );
  }

  if (screen === "room-code") {
    return (
      <main className="app-shell relative overflow-hidden">
        <PokerBackdrop />
        <section className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-7">
          <BackButton onClick={() => setScreen("landing")} />
          <section className="surface-panel p-5">
            <p className="text-sm font-semibold uppercase text-[#e2b653]">
              {roomMode === "create" ? "Room Created" : "Join Room"}
            </p>
            <h1 className="mt-1 text-3xl font-black text-white">North Tash</h1>

            <NameField
              nameInputRef={nameInputRef}
              playerName={playerName}
              setPlayerName={setPlayerName}
            />

            <label className="mt-4 block text-sm font-semibold text-white/75">
              Room code
              {roomMode === "create" ? (
                <div className="subtle-panel mt-2 grid h-16 place-items-center border-[#d2a84b]/50 bg-[#d2a84b]/12 font-mono text-3xl font-black text-[#f5d77d]">
                  {roomCode}
                </div>
              ) : (
                <input
                  autoFocus
                  className="control-field mt-2 h-14 w-full px-3 text-center font-mono text-2xl font-black text-white outline-none"
                  inputMode="numeric"
                  maxLength={3}
                  placeholder="123"
                  ref={codeInputRef}
                  value={roomCode}
                  onChange={(event) =>
                    setRoomCode(event.target.value.replace(/\D/g, "").slice(0, 3))
                  }
                  onInput={(event) =>
                    setRoomCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 3))
                  }
                />
              )}
            </label>

            {formError ? (
              <p className="mt-3 rounded-md border border-[#b95f5f]/45 bg-[#451c1f] px-3 py-2 text-sm text-[#ffd7d7]">
                {formError}
              </p>
            ) : null}

            <PrimaryButton onClick={showBuyIn} disabled={joinPending}>
              <Play size={18} />
              {joinPending
                ? "Checking Room..."
                : roomMode === "create"
                  ? "Continue"
                  : "Join The Room"}
            </PrimaryButton>
          </section>
        </section>
      </main>
    );
  }

  if (screen === "buy-in") {
    return (
      <main className="app-shell relative overflow-hidden">
        <PokerBackdrop />
        <section className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-7">
          <BackButton onClick={() => setScreen("room-code")} />
          <section className="surface-panel p-5">
            <p className="text-sm font-semibold uppercase text-[#e2b653]">Buy-in</p>
            <h1 className="mt-1 text-3xl font-black text-white">Start stack</h1>
            <p className="mt-2 text-sm text-white/60">
              Choose your starting stack before entering room {roomCode}.
            </p>

            <div className="subtle-panel mt-5 p-4">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs uppercase text-white/50">Chips</p>
                  <p className="text-3xl font-black text-white">{buyIn}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase text-white/50">Rupees</p>
                  <p className="text-2xl font-black text-[#e2b653]">Rs {rupeesForChips(buyIn)}</p>
                </div>
              </div>
              <input
                className="mt-4 w-full accent-[#d2a84b]"
                max={20}
                min={6}
                step={1}
                type="range"
                value={buyIn}
                onChange={(event) => setBuyIn(Number(event.target.value))}
              />
              <div className="mt-1 flex justify-between text-xs text-white/45">
                <span>6 chips</span>
                <span>20 chips max</span>
              </div>
            </div>

            <PrimaryButton onClick={enterLobby} disabled={lobbyPending}>
              <Coins size={18} />
              {lobbyPending ? "Joining..." : "Enter Lobby"}
            </PrimaryButton>
          </section>
        </section>
      </main>
    );
  }

  if (screen === "lobby") {
    const lobbyIsHost = room?.hostId === currentPlayerId;

    return (
      <main className="app-shell relative overflow-hidden">
        <PokerBackdrop />
        <section className="relative mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-5">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase text-[#e2b653]">Lobby</p>
              <h1 className="text-3xl font-black text-white">Room {room?.code}</h1>
            </div>
            <button
              aria-label="Open table menu"
              className="icon-action grid h-11 w-11 place-items-center text-white"
              type="button"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={21} />
            </button>
          </header>

          <section className="surface-panel mt-5 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase text-white/60">Players</h2>
              <span className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs font-semibold">
                <Users size={14} />
                {room?.players.length ?? 0}/7
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {room?.players.map((player) => (
                <LobbyPlayerRow key={player.id} player={player} />
              ))}
            </div>
            <div className="mt-4 rounded-md border border-[#d2a84b]/25 bg-[#d2a84b]/10 px-3 py-2">
              <p className="text-xs uppercase text-white/45">Room code</p>
              <p className="font-mono text-2xl font-black text-[#f5d77d]">{room?.code}</p>
            </div>
          </section>

          <div className="mt-auto grid gap-3 pt-5">
            {lobbyIsHost ? (
              <>
                <PrimaryButton onClick={startHand}>
                  <Play size={18} />
                  {room && room.players.length >= 2 ? "Start Hand" : "Waiting For Players"}
                </PrimaryButton>
                <button
                  className="secondary-action h-12 text-sm font-semibold"
                  type="button"
                  onClick={endSession}
                >
                  End Session / Tally
                </button>
              </>
            ) : (
              <p className="rounded-md border border-white/10 bg-black/25 px-3 py-3 text-center text-sm text-white/60">
                Waiting for the host to start the hand
              </p>
            )}
          </div>
        </section>
        {room ? (
          <SessionTallyModal
            open={sessionTallyOpen}
            players={room.players}
            potChips={0}
            onClose={() => setSessionTallyOpen(false)}
          />
        ) : null}
        <TableMenu
          open={menuOpen}
          isHost={room?.hostId === currentPlayerId}
          onClose={() => setMenuOpen(false)}
          onEndSession={endSession}
          sessionEnded={sessionEnded}
          onLeave={leaveTable}
        />
      </main>
    );
  }

  if (!table) {
    return (
      <main className="app-shell grid place-items-center px-5 text-center text-white">
        <div>
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-[#d2a84b]" />
          <p className="mt-4 text-sm font-semibold">Joining the table...</p>
          <p className="mt-1 text-xs text-white/55">Waiting for the shared game state.</p>
        </div>
      </main>
    );
  }

  const center =
    table.phase === "collecting-boots" ? null : describeCenterCard(getActiveCenter(table));
  const currentPlayer = getCurrentPlayer(table);
  const userPlayer = table.players.find((player) => player.id === table.userId);
  const activePlayers = getActivePlayers(table);
  const userCanAct = canUserAct(table);
  const showLabel = activePlayers.length === 2 ? "Show" : "Back Show";
  const isHost = room?.hostId === currentPlayerId;

  return (
    <main className="app-shell text-[#f7f3e8]">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col">
        <header className="app-header sticky top-0 z-30 flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase text-[#d2a84b]">North Tash</p>
            <h1 className="text-xl font-black text-white">Aflatoon</h1>
          </div>

          <div className="flex items-center gap-2">
            <div className="subtle-panel px-3 py-2 text-right">
              <p className="text-xs text-white/50">Room</p>
              <p className="font-mono text-base font-bold">{table.roomCode}</p>
            </div>
            <button
              aria-label="Open table menu"
              className="icon-action grid h-11 w-11 place-items-center text-white"
              type="button"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={21} />
            </button>
          </div>
        </header>

        <div className="grid flex-1 gap-2 px-2 py-2 sm:gap-4 sm:px-3 sm:py-4 lg:grid-cols-[1fr_310px] lg:px-5">
          <section className="game-surface flex min-h-0 flex-col overflow-hidden bg-[#123823] lg:min-h-[720px]">
            <div className="grid grid-cols-3 items-center gap-2 border-b border-white/10 bg-black/25 px-3 py-3">
              <PotMetric chips={table.pot} />
              <Metric
                label={table.phase === "collecting-boots" ? "Round" : "Turn"}
                value={table.phase === "collecting-boots" ? "Boots" : currentPlayer?.name ?? ""}
                sub={table.phase === "collecting-boots" ? "Collecting" : userCanAct ? "Your move" : "Wait"}
              />
              {center ? <ModeBadge mode={center.mode} /> : <Metric label="Status" value="Ready" sub="Pay boot" />}
            </div>

            <div className="relative flex flex-1 flex-col justify-between overflow-hidden bg-[radial-gradient(circle_at_center,#1b5636_0%,#113824_48%,#0b2418_100%)] p-2 sm:p-4">
              {countdownRemaining !== null ? (
                <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-black/45 backdrop-blur-[2px]">
                  <div className="text-center">
                    <p className="text-xs font-bold uppercase tracking-[0.28em] text-[#f5d77d]">
                      Cards dealing
                    </p>
                    <p className="mt-2 text-8xl font-black leading-none text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.55)]">
                      {countdownRemaining}
                    </p>
                  </div>
                </div>
              ) : null}
              <div className="surface-panel-soft center-chip-ledger relative z-10 mb-2 px-2 py-2">
                <ChipLedger potChips={table.pot} userPlayer={userPlayer} />
              </div>
              {chipMotion ? <ChipMotionOverlay motion={chipMotion} /> : null}
              <OvalTable
                center={center}
                localPlayerId={table.userId}
                table={table}
                temporaryRevealIds={temporaryRevealIds}
                turnRemainingMs={turnRemainingMs}
              />

              {table.phase === "collecting-boots" ? (
                <BootCollectionPanel
                  actionPending={actionPending}
                  onPayBoot={payUserBoot}
                  table={table}
                />
              ) : null}

              {overlay ? <ActionOverlay overlay={overlay} /> : null}
              {pendingFold ? (
                <FoldConfirmOverlay onCancel={cancelFold} onConfirm={confirmFold} />
              ) : null}
              {table.phase === "hand-complete" && table.lastShow ? (
                <ShowdownResultPanel table={table} />
              ) : null}
              {pendingShow ? (
                pendingShow.defenderId === table.userId ? (
                  <ShowResponseModal
                    label={pendingShow.label}
                    requester={table.players.find((player) => player.id === pendingShow.requesterId)}
                    defender={table.players.find((player) => player.id === pendingShow.defenderId)}
                    onAccept={() => answerPendingShow("accept")}
                    onDecline={() => answerPendingShow("decline")}
                  />
                ) : null
              ) : null}

              {userPlayer && center && table.phase === "playing" ? (
                <UserPanel
                  player={userPlayer}
                  center={center}
                  isCurrent={
                    userPlayer.hand.length === 3 &&
                    userCanAct &&
                    !actionPending &&
                    !pendingShow &&
                    !pendingFold &&
                    !sessionEnded
                  }
                  onBackShow={handleBackShow}
                  onChaal={playUserChaal}
                  onFold={requestFoldConfirmation}
                  handNumber={table.handNumber}
                  showLabel={showLabel}
                  tablePhase={table.phase}
                />
              ) : null}
            </div>
          </section>

          <aside className="surface-panel hidden min-h-[720px] flex-col p-3 lg:flex">
            <TableSidebar table={table} currentPlayerId={currentPlayer?.id} />
          </aside>
        </div>
      </section>

      <TableMenu
        open={menuOpen}
        isHost={isHost}
        table={table}
        chipRequests={displayedChipRequests}
        currentPlayerId={table.userId}
        onApproveChipRequest={approveChipRequest}
        onRejectChipRequest={rejectChipRequest}
        onRequestChips={requestChips}
        onRequestTransfer={openTransferRequest}
        onClose={() => setMenuOpen(false)}
        onEndSession={endSession}
        sessionEnded={sessionEnded}
        onLeave={leaveTable}
        onNextHand={isHost ? () =>
          setTable((currentTable) => (currentTable ? startNextHand(currentTable) : currentTable))
        : undefined}
        onStand={() =>
          setTable((currentTable) =>
            currentTable ? standPlayer(currentTable, currentTable.userId) : currentTable,
          )
        }
      />
      {incomingTransferRequest ? (
        <IncomingChipRequestModal
          amount={incomingTransferRequest.amount}
          fromName={incomingTransferRequest.requesterName}
          onReject={() => respondToTransferRequest(false)}
          onApprove={() => respondToTransferRequest(true)}
        />
      ) : incomingChipRequest ? (
        <IncomingChipRequestModal
          amount={incomingChipRequest.amount}
          fromName={incomingChipRequest.fromName}
          onReject={() => respondToIncomingChipRequest(false)}
          onApprove={() => respondToIncomingChipRequest(true)}
        />
      ) : null}
      <SessionTallyModal
        open={sessionTallyOpen}
        players={table.players}
        potChips={table.pot}
        transferLedger={table.transferLedger}
        onClose={() => setSessionTallyOpen(false)}
      />
      <TransferRequestModal
        draft={transferDraft}
        players={table.players}
        requesterId={table.userId}
        onCancel={() => setTransferDraft(null)}
        onChange={setTransferDraft}
        onSubmit={submitTransferRequest}
      />
    </main>
  );
}

function EntryPanel({
  nameInputRef,
  onCreate,
  onJoin,
  onTestMode,
  playerName,
  setPlayerName,
}: {
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  onCreate: () => void;
  onJoin: () => void;
  onTestMode: () => void;
  playerName: string;
  setPlayerName: (name: string) => void;
}) {
  return (
    <section className="surface-panel p-5 sm:p-6">
      <NameField
        nameInputRef={nameInputRef}
        playerName={playerName}
        setPlayerName={setPlayerName}
      />
      <div className="mt-5 grid gap-3">
        <PrimaryButton onClick={onCreate}>
          <Plus size={18} />
          Create Room
        </PrimaryButton>
        <button
          className="secondary-action flex h-12 items-center justify-center gap-2 px-4 text-sm font-semibold"
          type="button"
          onClick={onJoin}
        >
          <LogIn size={18} />
          Join Room
        </button>
      </div>
      <button
        className="mt-5 w-full border-t border-white/10 pt-4 text-xs font-semibold uppercase text-white/42 hover:text-[#e2b653]"
        type="button"
        onClick={onTestMode}
      >
        Test mode
      </button>
    </section>
  );
}

function TestModePanel({
  name,
  onBack,
  onSelect,
}: {
  name: string;
  onBack: () => void;
  onSelect: (scenario: Exclude<TestRoomScenario, null>) => void;
}) {
  return (
    <section className="modal-surface absolute inset-x-0 bottom-0 z-20 p-5 sm:bottom-1/2 sm:translate-y-1/2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#e2b653]">Separate tools</p>
          <h2 className="mt-1 text-xl font-black text-white">Test mode</h2>
          <p className="mt-1 text-sm text-white/55">For chip-request and bot-owner checks only.</p>
        </div>
        <button className="icon-action grid h-9 w-9 place-items-center" aria-label="Close test mode" type="button" onClick={onBack}>
          <X size={17} />
        </button>
      </div>
      <p className="subtle-panel mt-4 px-3 py-2 text-sm text-white/65">
        Player: {name || "Player"}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button className="primary-action h-11 text-sm font-bold" type="button" onClick={() => onSelect("bot-owner")}>
          Bot owner test
        </button>
        <button className="secondary-action h-11 text-sm font-bold" type="button" onClick={() => onSelect("player-owner")}>
          Player owner test
        </button>
      </div>
    </section>
  );
}

function NameField({
  nameInputRef,
  playerName,
  setPlayerName,
}: {
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  playerName: string;
  setPlayerName: (name: string) => void;
}) {
  return (
    <label className="mt-5 block text-xs font-bold uppercase text-white/62 first:mt-0">
      Name
      <input
        className="control-field mt-2 h-12 w-full px-3 text-base font-medium normal-case text-white outline-none"
        maxLength={18}
        placeholder="Enter your name"
        ref={nameInputRef}
        value={playerName}
        onChange={(event) => setPlayerName(event.target.value)}
        onInput={(event) => setPlayerName(event.currentTarget.value)}
      />
    </label>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="secondary-action mb-5 flex h-10 w-fit items-center gap-2 px-3 text-sm font-semibold"
      type="button"
      onClick={onClick}
    >
      <ArrowLeft size={17} />
      Back
    </button>
  );
}

function PrimaryButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="primary-action mt-4 flex h-12 w-full items-center justify-center gap-2 px-4 text-sm font-bold disabled:cursor-wait disabled:opacity-60 first:mt-0"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PokerBackdrop({ featured = false }: { featured?: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
      <Image
        alt=""
        className={`object-cover ${featured ? "object-[52%_50%] sm:object-[center_48%]" : "object-[52%_50%] opacity-25"}`}
        fill
        priority={featured}
        sizes="100vw"
        src="/north-tash-home.jpg"
      />
      <div
        className={`absolute inset-0 ${featured ? "bg-[#07100c]/62" : "bg-[#07100c]/78"}`}
      />
    </div>
  );
}

function LobbyPlayerRow({ player }: { player: LobbyPlayer }) {
  return (
    <div className="subtle-panel flex items-center gap-3 p-3">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-[#f7f3e8] font-black text-[#101410]">
        {initials(player.name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold text-white">{player.name}</p>
        <p className="text-xs text-white/50">{player.isHost ? "Host" : "Player"}</p>
      </div>
      <ChipPill chips={player.chips} />
    </div>
  );
}

function UserPanel({
  handNumber,
  player,
  center,
  isCurrent,
  onBackShow,
  onChaal,
  onFold,
  showLabel,
  tablePhase,
}: {
  handNumber: number;
  player: TablePlayer;
  center: ReturnType<typeof describeCenterCard>;
  isCurrent: boolean;
  onBackShow: () => void;
  onChaal: () => void;
  onFold: () => void;
  showLabel: string;
  tablePhase: TableState["phase"];
}) {
  const handReady = player.hand.length === 3;
  const evaluation = useMemo(
    () =>
      handReady
        ? evaluateHand(player.hand, {
            mode: center.mode,
            jokerRanks: center.jokerRanks,
          })
        : null,
    [center.jokerRanks, center.mode, handReady, player.hand],
  );

  return (
    <div className="surface-panel-soft p-3 shadow-xl shadow-black/25">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase text-white/50">Your hand</p>
          <p className="truncate text-sm font-semibold text-white">
            {evaluation
              ? `${evaluation.label} by ${evaluation.bestCards.map(formatCard).join(" ")}`
              : "Loading protected cards..."}
          </p>
        </div>
        <ChipCount player={player} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        {handReady
          ? player.hand.map((card) => (
              <PlayingCard
                card={card}
                dealIndex={player.hand.indexOf(card)}
                dealt
                flipped
                key={`${handNumber}-${card.rank}-${card.suit}`}
              />
            ))
          : [0, 1, 2].map((cardIndex) => (
              <div
                aria-hidden="true"
                className="h-[86px] w-[58px] animate-pulse rounded-md border border-white/15 bg-white/8"
                key={cardIndex}
              />
            ))}
      </div>

      {tablePhase === "hand-complete" ? (
        <div className="subtle-panel mt-4 px-3 py-3 text-center text-sm text-white/60">
          Waiting for the host to start the new round
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <button
            className="primary-action h-12 text-sm font-black disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!isCurrent}
            type="button"
            onClick={onChaal}
          >
            Chaal
          </button>
          <button
            className="secondary-action h-12 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!isCurrent}
            type="button"
            onClick={onBackShow}
          >
            {showLabel}
          </button>
          <button
            className="danger-action h-12 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!isCurrent}
            type="button"
            onClick={onFold}
          >
            Fold
          </button>
        </div>
      )}
    </div>
  );
}

function OvalTable({
  center,
  localPlayerId,
  table,
  temporaryRevealIds,
  turnRemainingMs,
}: {
  center: ReturnType<typeof describeCenterCard> | null;
  localPlayerId?: string;
  table: TableState;
  temporaryRevealIds: string[];
  turnRemainingMs: number;
}) {
  const tableRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const root = tableRef.current;

    if (!root) {
      return;
    }

    const context = gsap.context(() => {
      const cards = gsap.utils.toArray<HTMLElement>("[data-gsap-deal]", root);

      cards.forEach((card) => {
        const styles = getComputedStyle(card);
        const originX = Number.parseFloat(styles.getPropertyValue("--deal-x")) || 0;
        const originY = Number.parseFloat(styles.getPropertyValue("--deal-y")) || -150;

        gsap.set(card, {
          opacity: 0,
          rotation: -12,
          scale: 0.78,
          x: originX,
          y: originY,
        });
      });

      gsap.to(cards, {
        duration: 0.72,
        ease: "power3.out",
        opacity: 1,
        rotation: 0,
        scale: 1,
        stagger: 0.14,
        x: 0,
        y: 0,
      });
    }, root);

    return () => context.revert();
  }, [table.handNumber]);

  useLayoutEffect(() => {
    const root = tableRef.current;
    const centerCard = root?.querySelector<HTMLElement>("[data-gsap-center-card]");

    if (!root || !centerCard) {
      return;
    }

    const context = gsap.context(() => {
      gsap.fromTo(
        centerCard,
        { opacity: 0, rotation: -9, scale: 0.9, x: -28, y: 10 },
        {
          duration: 0.86,
          ease: "power2.out",
          opacity: 1,
          rotation: 0,
          scale: 1,
          x: 0,
          y: 0,
        },
      );
    }, root);

    return () => context.revert();
  }, [table.actionCount]);

  return (
    <section className="relative mx-auto mb-2 h-[350px] w-full max-w-4xl sm:mb-4 sm:h-[470px]" ref={tableRef}>
      <div className="absolute inset-x-0 top-12 bottom-12 rounded-[50%] border-[10px] border-[#5c3b20] bg-[radial-gradient(ellipse_at_center,#2f8b58_0%,#1d6740_48%,#11402a_100%)] shadow-[inset_0_0_0_3px_rgba(255,255,255,0.08),inset_0_28px_70px_rgba(255,255,255,0.07),0_28px_70px_rgba(0,0,0,0.42)] sm:inset-x-3 sm:top-6 sm:bottom-6" />
      <div className="absolute inset-x-6 top-[100px] bottom-[100px] rounded-[50%] border border-[#d2a84b]/25 bg-black/10 sm:inset-x-14 sm:top-24 sm:bottom-24" />
      {center ? (
        <div className="absolute left-1/2 top-[54%] w-[172px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-white/15 bg-black/28 p-1.5 text-center shadow-xl shadow-black/25 backdrop-blur sm:top-[48%] sm:w-[288px] sm:p-3">
          <CenterDeck
            actionCount={table.actionCount}
            card={getActiveCenter(table)}
            center={center}
            count={table.centerHistory.length}
          />
        </div>
      ) : null}

      {table.players.map((player, index) => (
        (() => {
          const privateRevealVisible = Boolean(
            table.privateReveal &&
              table.privateReveal.expiresAt > Date.now() &&
              table.privateReveal.viewerIds.includes(localPlayerId ?? "") &&
              table.privateReveal.playerIds.includes(player.id),
          );

          return (
        <Seat
          localPlayerId={localPlayerId}
          dealer={table.players[table.dealerIndex]?.id === player.id}
          handNumber={table.handNumber}
          isUser={player.id === table.userId}
          key={player.id}
          player={player}
          positionClass={seatPositionClass(index, table.players.length)}
          dealOrigin={dealOriginForSeat(index, table.players.length)}
          revealed={
            player.id === table.userId ||
            table.revealedPlayerIds.includes(player.id) ||
            temporaryRevealIds.includes(player.id) ||
            privateRevealVisible
          }
          timerActive={
            table.players[table.turnIndex]?.id === player.id && table.phase === "playing"
          }
          timerKey={`${table.handNumber}-${table.actionCount}-${table.turnIndex}`}
          turnRemainingMs={turnRemainingMs}
          showCards={table.phase !== "collecting-boots"}
        />
          );
        })()
      ))}
    </section>
  );
}

function BootCollectionPanel({
  actionPending,
  onPayBoot,
  table,
}: {
  actionPending: boolean;
  onPayBoot: () => void;
  table: TableState;
}) {
  const pendingIds = new Set(table.pendingBootPlayerIds ?? []);
  const userNeedsToPay = pendingIds.has(table.userId);

  return (
    <div className="absolute inset-0 z-20 grid place-items-center px-4">
      <div className="surface-panel w-full max-w-xs p-4 text-center">
        <p className="text-xs font-bold uppercase text-[#f5d77d]">Round {table.handNumber}</p>
        <h2 className="mt-1 text-xl font-black text-white">Put in your boot</h2>
        <p className="mt-1 text-sm text-white/60">
          Every player puts in {AFLATOON_RULES.bootChips} chips. The player after the dealer opens with {AFLATOON_RULES.openingChaalChips} chips total.
        </p>
        <div className="mt-4 space-y-2 text-left">
          {table.players
            .filter((player) => player.status === "active")
            .map((player) => {
              const paid = !pendingIds.has(player.id);

              return (
                <div
                  className="flex items-center justify-between rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
                  key={player.id}
                >
                  <span className="truncate font-semibold text-white">{player.name}</span>
                  <span className={paid ? "font-bold text-[#f5d77d]" : "text-white/45"}>
                    {paid ? "Paid" : "Waiting"}
                  </span>
                </div>
              );
            })}
        </div>
        {userNeedsToPay ? (
          <button
            className="primary-action mt-4 flex h-12 w-full items-center justify-center px-4 text-sm font-black disabled:cursor-wait disabled:opacity-60"
            disabled={actionPending}
            type="button"
            onClick={onPayBoot}
          >
            Put {AFLATOON_RULES.bootChips} Chips In Pot
          </button>
        ) : (
          <p className="mt-4 text-sm font-semibold text-[#f5d77d]">Your boot is in. Waiting for the table.</p>
        )}
      </div>
    </div>
  );
}

function CenterDeck({
  actionCount,
  card,
  center,
  count,
}: {
  actionCount: number;
  card: Card;
  center: ReturnType<typeof describeCenterCard>;
  count: number;
}) {
  return (
    <div className="center-deck-content origin-center scale-[0.74] sm:scale-100">
        <div className="mt-2 flex items-center justify-center gap-3 sm:mt-3 sm:gap-4">
        <div className="deck-stack relative h-28 w-20 origin-left scale-[0.84] sm:scale-100">
          <div className="deck-real-card deck-real-card-one">
            <PlayingCard card={card} size="large" />
          </div>
          <div className="deck-real-card deck-real-card-two">
            <PlayingCard card={card} size="large" />
          </div>
          <div className="deck-real-card deck-real-card-three">
            <PlayingCard card={card} size="large" />
          </div>
          <div
            className="center-card-motion gsap-controlled absolute left-3 top-2"
            data-gsap-center-card
            key={`${card.rank}-${card.suit}-${actionCount}`}
          >
            <PlayingCard card={card} flipped size="large" />
          </div>
        </div>
        <div className="ml-1 translate-x-6 text-left sm:ml-0 sm:translate-x-0">
          <p className="text-xs uppercase text-white/50">Jokers</p>
          <div className="mt-1 flex gap-1 sm:mt-2">
            {center.jokerRanks.map((rank) => (
              <span
                className="grid h-8 w-8 place-items-center rounded-md bg-[#f7f3e8] text-sm font-black text-[#161812] sm:h-10 sm:w-10 sm:text-base"
                key={rank}
              >
                {rank}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-white/55">Centre #{count}</p>
        </div>
      </div>
    </div>
  );
}

function ChipLedger({ potChips, userPlayer }: { potChips: number; userPlayer?: TablePlayer }) {
  const userChips = userPlayer?.chips ?? 0;

  return (
    <div className="grid grid-cols-2 gap-2 border-b border-white/10 pb-2 text-left">
      <div className="chip-ledger-cell">
        <div className="flex items-center gap-2">
          <PokerChipStack chips={potChips} compact />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-white/50">Total pot</p>
            <p className="text-sm font-black text-white">{potChips} chips</p>
          </div>
        </div>
        <p className="mt-1 text-[10px] text-[#e2b653]">Rs {rupeesForChips(potChips)}</p>
      </div>
      <div className="chip-ledger-cell">
        <div className="flex items-center gap-2">
          <PokerChipStack chips={userChips} compact />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-white/50">Your stack</p>
            <p className="text-sm font-black text-white">{userChips} chips</p>
          </div>
        </div>
        <p className="mt-1 text-[10px] text-[#e2b653]">Rs {rupeesForChips(userChips)}</p>
      </div>
    </div>
  );
}

function ChipMotionOverlay({ motion }: { motion: ChipMotion }) {
  const displayedChips = Math.max(1, Math.min(motion.amount, 20));
  const motionRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = motionRef.current;

    if (!node) {
      return;
    }

    const context = gsap.context(() => {
      const toPot = motion.direction === "to-pot";
      const timeline = gsap.timeline();

      timeline.fromTo(
        node,
        { opacity: 0, xPercent: -50, y: toPot ? 150 : 0, scale: 0.62, rotation: toPot ? -12 : 0 },
        { duration: 0.42, ease: "power2.out", opacity: 1, scale: 1.08, y: toPot ? 42 : 44 },
      );
      timeline.to(node, {
        duration: 0.7,
        ease: "power2.inOut",
        opacity: 0,
        scale: 0.82,
        y: toPot ? 0 : 150,
        rotation: toPot ? 0 : 8,
      });
    }, node);

    return () => context.revert();
  }, [motion.direction, motion.key]);

  return (
    <div
      aria-hidden="true"
      className="chip-motion-overlay gsap-controlled pointer-events-none absolute left-1/2 top-[42%] z-35"
      key={motion.key}
      ref={motionRef}
    >
      <PokerChipStack chips={displayedChips} compact />
      <span>{motion.direction === "to-pot" ? `+${motion.amount}` : `-${motion.amount}`}</span>
    </div>
  );
}

function Seat({
  localPlayerId,
  dealOrigin,
  dealer,
  handNumber,
  isUser,
  player,
  positionClass,
  revealed,
  showCards,
  timerActive,
  timerKey,
  turnRemainingMs,
}: {
  localPlayerId?: string;
  dealOrigin: { x: number; y: number };
  dealer: boolean;
  handNumber: number;
  isUser: boolean;
  player: TablePlayer;
  positionClass: string;
  revealed: boolean;
  showCards: boolean;
  timerActive: boolean;
  timerKey: string;
  turnRemainingMs: number;
}) {
  const current = localPlayerId === player.id;
  const displayedHand = player.hand.length === 3 ? player.hand : HIDDEN_HAND_PLACEHOLDERS;

  return (
    <div
      className={`absolute w-[102px] rounded-md border px-1.5 py-1.5 text-center shadow-xl shadow-black/30 backdrop-blur sm:w-[138px] sm:px-2 sm:py-2 ${positionClass} ${
        timerActive
          ? "border-[#f5d77d] bg-[#4f3a16]/92 shadow-[0_0_24px_rgba(245,215,125,0.38)]"
          : current
            ? "border-white/35 bg-[#173323]/92"
            : "border-white/12 bg-[#0b1810]/88"
      }`}
    >
      <div className="relative mx-auto h-10 w-10 sm:h-12 sm:w-12">
        {timerActive ? <TimerRing remainingMs={turnRemainingMs} /> : null}
        <div className="absolute inset-1 grid place-items-center rounded-full bg-[#f7f3e8] text-xs font-black text-[#162217] sm:text-sm">
          {initials(player.name)}
        </div>
      </div>
      <div className="mt-1 flex items-center justify-center gap-1">
        <p className="truncate text-xs font-semibold sm:text-sm">{player.name}</p>
        {dealer ? <DealerBadge /> : null}
      </div>
      <p className="mt-1 text-xs text-white/50">
        {player.status === "active" ? `${player.chips} chips` : player.status}
      </p>
      {timerActive ? (
        <SeatTimerBar key={timerKey} remainingMs={turnRemainingMs} />
      ) : null}
      {!isUser && showCards ? (
        <div className={`mt-1 flex justify-center ${revealed && player.hand.length === 3 ? "-space-x-3" : "-space-x-2"}`}>
          {displayedHand.map((card, cardIndex) => (
            <PlayingCard
              card={card}
              dealIndex={displayedHand.length * tableSeatOrder(player.seat) + cardIndex}
              dealOrigin={dealOrigin}
              dealt
              flipped={revealed && player.hand.length === 3}
              gsapDeal
              key={`${handNumber}-${player.id}-${card.rank}-${card.suit}-${cardIndex}`}
              size={revealed && player.hand.length === 3 ? "seat" : "tiny"}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SeatTimerBar({ remainingMs }: { remainingMs: number }) {
  const progress = Math.max(
    0,
    Math.min(1, remainingMs / (AFLATOON_RULES.turnTimerSeconds * 1000)),
  );

  return (
    <div className="seat-timer-bar mt-1">
      <div className="seat-timer-fill" style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}

function TableSidebar({
  currentPlayerId,
  table,
}: {
  currentPlayerId?: string;
  table: TableState;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase text-white/60">Players</h2>
        <span className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs font-semibold">
          <Users size={14} />
          {getActivePlayers(table).length}/{table.players.length}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {table.players.map((player) => (
          <PlayerRow
            current={currentPlayerId === player.id}
            dealer={table.players[table.dealerIndex]?.id === player.id}
            key={player.id}
            player={player}
          />
        ))}
      </div>

      <div className="mt-4 border-t border-white/10 pt-3">
        <h2 className="text-sm font-bold uppercase text-white/60">Action</h2>
        <div className="mt-3 space-y-2">
          {table.log.map((entry) => (
            <p
              className={`rounded-md border px-3 py-2 text-sm ${logToneClass(entry.tone)}`}
              key={entry.id}
            >
              {entry.text}
            </p>
          ))}
        </div>
      </div>
    </>
  );
}

function ActionOverlay({ overlay }: { overlay: Overlay }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-[43%] z-20 -translate-x-1/2 -translate-y-1/2">
      <div
        className={`rounded-md border px-4 py-3 text-center text-sm font-black uppercase shadow-2xl shadow-black/45 ${
          overlay.tone === "good"
            ? "border-[#d2a84b]/40 bg-[#d2a84b] text-[#161812]"
            : overlay.tone === "warn"
              ? "border-[#e2b653]/50 bg-[#4d3510] text-[#ffe7ad]"
              : "border-white/20 bg-black/70 text-white"
        }`}
      >
        {overlay.text}
      </div>
    </div>
  );
}

function IncomingChipRequestModal({
  amount,
  fromName,
  onApprove,
  onReject,
}: {
  amount: number;
  fromName: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="modal-backdrop fixed inset-0 z-[65] grid place-items-center px-4">
      <section className="modal-surface w-full max-w-sm p-5 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#e2b653]">Chip request</p>
        <h2 className="mt-1 text-2xl font-black text-white">{fromName} needs chips</h2>
        <p className="mt-2 text-sm text-white/60">Send {amount} chips from your stack?</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            className="secondary-action h-12 text-sm font-semibold"
            type="button"
            onClick={onReject}
          >
            Reject
          </button>
          <button
            className="primary-action h-12 text-sm font-black"
            type="button"
            onClick={onApprove}
          >
            Approve
          </button>
        </div>
      </section>
    </div>
  );
}

function FoldConfirmOverlay({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-surface absolute left-1/2 top-[46%] z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 border-[#b95f5f]/60 p-5 text-center">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#ffb4b4]">Confirm action</p>
      <h2 className="mt-1 text-2xl font-black text-white">Fold this hand?</h2>
      <p className="mt-1 text-sm text-white/60">You will leave the current hand and cannot undo this.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          className="secondary-action h-12 text-sm font-semibold"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="danger-action h-12 text-sm font-black"
          type="button"
          onClick={onConfirm}
        >
          Confirm Fold
        </button>
      </div>
    </div>
  );
}

function ShowdownResultPanel({ table }: { table: TableState }) {
  const resolution = table.lastShow;

  if (!resolution) {
    return null;
  }

  const requesterPlayer = table.players.find((player) => player.id === table.players[table.turnIndex]?.id);
  const requesterName = requesterPlayer?.name ?? "Requester";
  const defenderPlayer = table.players.find((player) => player.id !== requesterPlayer?.id);
  const winnerName = resolution.winnerId
    ? table.players.find((player) => player.id === resolution.winnerId)?.name ?? "Winner"
    : "Split hand";

  return (
    <div className="modal-surface showdown-panel absolute left-0 right-0 top-[45%] z-40 mx-auto w-[calc(100%-1.25rem)] max-w-md border-[#d2a84b]/55 p-4 text-center">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#e2b653]">Showdown</p>
      <h2 className="mt-1 text-2xl font-black text-white">
        {resolution.outcome === "split" ? "Split hand" : `${winnerName} wins`}
      </h2>
      <p className="mt-1 text-xs text-white/60">{showdownReason(resolution.reason)}</p>

      <div className="mt-3 grid gap-2">
        <ShowdownHandRow
          label={requesterName}
          hand={resolution.requester.bestCards}
          category={resolution.requester.label}
          winner={resolution.winnerId === requesterPlayer?.id}
        />
        <div className="showdown-versus">VS</div>
        <ShowdownHandRow
          label={defenderPlayer?.name ?? "Defender"}
          hand={resolution.defender.bestCards}
          category={resolution.defender.label}
          winner={resolution.winnerId === defenderPlayer?.id}
        />
      </div>

      <p className="mt-3 rounded-md border border-white/10 bg-white/6 px-3 py-2 text-xs text-white/70">
        {resolution.requester.label} ({resolution.requester.tieBreakers.join("-")}) vs {resolution.defender.label} ({resolution.defender.tieBreakers.join("-")})
      </p>
    </div>
  );
}

function ShowdownHandRow({
  category,
  hand,
  label,
  winner,
}: {
  category: string;
  hand: Card[];
  label: string;
  winner: boolean;
}) {
  return (
    <div className={`showdown-hand-row ${winner ? "is-winner" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-black text-white">{label}</p>
        <p className="text-xs text-[#e2b653]">{category}{winner ? " · Winner" : ""}</p>
      </div>
      <div className="mt-1 flex justify-center gap-1">
        {hand.map((card, index) => (
          <PlayingCard
            card={card}
            key={`${label}-${card.rank}-${card.suit}-${index}`}
            showdown
            flipped
            size="showdown"
          />
        ))}
      </div>
    </div>
  );
}

function showdownReason(reason: NonNullable<TableState["lastShow"]>["reason"]) {
  switch (reason) {
    case "better-hand":
      return "The stronger evaluated hand wins this show.";
    case "exact-tie-requester-loses":
      return "Exact tie: the requester loses under the Aflatoon rule.";
    case "ace-trail-split":
      return "Ace trails are split under the current MVP setting.";
    case "mufflis-245-split":
      return "Valid Mufflis 2-4-5 hands are split under the current MVP setting.";
  }
}

function ShowResponseModal({
  defender,
  label,
  onAccept,
  onDecline,
  requester,
}: {
  defender?: TablePlayer;
  label: PendingShow["label"];
  onAccept: () => void;
  onDecline: () => void;
  requester?: TablePlayer;
}) {
  const declineAvailable =
    (defender?.declinesUsed ?? AFLATOON_RULES.declinesPerHand) <
    AFLATOON_RULES.declinesPerHand;

  return (
    <div className="modal-surface absolute inset-x-4 top-[56%] z-30 mx-auto max-w-sm -translate-y-1/2 border-[#d2a84b]/45 p-5 text-center">
      <p className="text-xs uppercase text-[#e2b653]">{label} request</p>
      <h3 className="mt-1 text-xl font-black text-white">
        {requester?.name ?? "Player"} vs {defender?.name ?? "You"}
      </h3>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          className="primary-action h-12 text-sm font-black"
          type="button"
          onClick={onAccept}
        >
          Accept
        </button>
        <button
          className="secondary-action h-12 border-[#e2b653]/45 text-sm font-bold text-[#ffe7ad] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!declineAvailable}
          type="button"
          onClick={onDecline}
        >
          {declineAvailable ? `Decline (${2 - (defender?.declinesUsed ?? 0)} left)` : "Must Accept"}
        </button>
      </div>
    </div>
  );
}

function TimerRing({ remainingMs }: { remainingMs: number }) {
  const progress = Math.max(
    0,
    Math.min(1, remainingMs / (AFLATOON_RULES.turnTimerSeconds * 1000)),
  );
  const degrees = Math.round(progress * 360);
  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <div
      className="timer-ring absolute inset-0 rounded-full"
      style={{
        background: `conic-gradient(#d2a84b ${degrees}deg, rgba(255,255,255,.16) ${degrees}deg)`,
      }}
    >
      <span className="absolute -top-2 left-1/2 grid h-5 min-w-8 -translate-x-1/2 place-items-center rounded-md bg-[#101410] px-1 text-[10px] font-black text-[#e2b653]">
        {seconds}s
      </span>
    </div>
  );
}

function TableMenu({
  chipRequests = [],
  currentPlayerId,
  isHost = false,
  onApproveChipRequest,
  onClose,
  onEndSession,
  onLeave,
  onNextHand,
  onRejectChipRequest,
  onRequestChips,
  onRequestTransfer,
  onStand,
  open,
  sessionEnded = false,
  table,
}: {
  chipRequests?: BuyInRequest[];
  currentPlayerId?: string;
  isHost?: boolean;
  onApproveChipRequest?: (requestId: string) => void;
  onClose: () => void;
  onEndSession: () => void;
  onLeave: () => void;
  onNextHand?: () => void;
  onRejectChipRequest?: (requestId: string) => void;
  onRequestChips?: (chips: 10 | 20) => void;
  onRequestTransfer?: () => void;
  onStand?: () => void;
  open: boolean;
  sessionEnded?: boolean;
  table?: TableState;
}) {
  if (!open) {
    return null;
  }

  const userIsHost = Boolean(isHost && table?.userId === currentPlayerId);
  const chipActionPrefix = userIsHost ? "Add" : "Request";

  return (
    <div className="modal-backdrop fixed inset-0 z-50">
      <aside className="drawer-surface ml-auto flex h-full w-full max-w-sm flex-col p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase text-white/50">Menu</p>
            <p className="text-xl font-black text-white">North Tash</p>
          </div>
          <button
            aria-label="Close menu"
            className="icon-action grid h-10 w-10 place-items-center"
            type="button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className="mt-5 grid gap-2">
          {table && onRequestChips ? (
            <>
              <MenuButton
                icon={<Coins size={18} />}
                label={`${chipActionPrefix} 10 Chips`}
                onClick={() => onRequestChips(10)}
              />
              <MenuButton
                icon={<Coins size={18} />}
                label={`${chipActionPrefix} 20 Chips`}
                onClick={() => onRequestChips(20)}
              />
            </>
          ) : null}
          {table && onRequestTransfer ? (
            <MenuButton
              icon={<ArrowRightLeft size={18} />}
              label="Request Chips From Player"
              onClick={onRequestTransfer}
            />
          ) : null}
          {table && onStand ? <MenuButton icon={<Users size={18} />} label="Stand" onClick={onStand} /> : null}
          {table && onNextHand ? (
            <MenuButton
              disabled={table.phase !== "hand-complete"}
              icon={<RotateCcw size={18} />}
              label="Start New Round"
              onClick={onNextHand}
            />
          ) : null}
          {isHost && !sessionEnded ? (
            <MenuButton icon={<Trophy size={18} />} label="End Session" onClick={onEndSession} />
          ) : null}
          {isHost && sessionEnded ? (
            <MenuButton icon={<Trophy size={18} />} label="Tally Card" onClick={onEndSession} />
          ) : null}
          <MenuButton danger icon={<LogOut size={18} />} label="Leave" onClick={onLeave} />
        </div>

        {isHost && chipRequests.length > 0 && onApproveChipRequest && onRejectChipRequest ? (
          <section className="subtle-panel mt-5 border-[#d2a84b]/25 bg-[#d2a84b]/10 p-3">
            <h2 className="text-sm font-black uppercase text-[#f5d77d]">Chip Requests</h2>
            <div className="mt-3 grid gap-2">
              {chipRequests.map((request) => (
                <div className="subtle-panel p-2" key={request.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-white">{request.playerName}</p>
                      <p className="text-xs text-white/55">{request.chips} chips</p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        className="primary-action h-9 px-2 text-xs font-black"
                        type="button"
                        onClick={() => onApproveChipRequest(request.id)}
                      >
                        Approve
                      </button>
                      <button
                        className="secondary-action h-9 border-[#e2b653]/35 px-2 text-xs font-bold text-[#ffe7ad]"
                        type="button"
                        onClick={() => onRejectChipRequest(request.id)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {table ? (
          <div className="mt-5 flex-1 overflow-auto border-t border-white/10 pt-4 lg:hidden">
            <TableSidebar currentPlayerId={getCurrentPlayer(table)?.id} table={table} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function MenuButton({
  danger = false,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-12 items-center gap-3 px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45 ${danger ? "danger-action" : "secondary-action"}`}
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function PlayerRow({
  current,
  dealer,
  player,
}: {
  current: boolean;
  dealer: boolean;
  player: TablePlayer;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-md border p-2.5 ${
        current ? "border-[#d2a84b]/70 bg-[#d2a84b]/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" : "border-white/10 bg-black/20"
      }`}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[#244b36] text-sm font-bold">
        {initials(player.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">{player.name}</p>
          {dealer ? <DealerBadge /> : null}
        </div>
        <p className="text-xs capitalize text-white/50">{player.status}</p>
      </div>
      <ChipCount player={player} compact />
    </div>
  );
}

function PlayingCard({
  card,
  dealIndex = 0,
  dealOrigin = { x: 0, y: -150 },
  dealt = false,
  flipped = false,
  gsapDeal = false,
  showdown = false,
  size = "normal",
}: {
  card: Card;
  dealIndex?: number;
  dealOrigin?: { x: number; y: number };
  dealt?: boolean;
  flipped?: boolean;
  gsapDeal?: boolean;
  showdown?: boolean;
  size?: "tiny" | "seat" | "normal" | "large" | "showdown";
}) {
  const dimensions =
    size === "showdown"
      ? "h-[112px] w-[80px]"
      : size === "large"
        ? "h-[98px] w-[70px]"
        : size === "seat"
          ? "h-[60px] w-[43px] sm:h-[70px] sm:w-[50px]"
          : size === "tiny"
            ? "h-[40px] w-[28px] sm:h-[52px] sm:w-[37px]"
            : "h-[88px] w-[63px]";
  const cardDeck = PlayingCards as Record<string, CardSvgComponent>;
  const CardAsset = cardDeck[cardAssetName(card)];
  const BackAsset = cardDeck.B1;
  const style = {
    "--deal-delay": `${dealIndex * 105}ms`,
    "--deal-x": `${dealOrigin.x}px`,
    "--deal-y": `${dealOrigin.y}px`,
  } as CSSProperties;

  return (
    <div
      className={`${dimensions} card-flip shrink-0 ${dealt ? "is-dealt" : ""} ${gsapDeal ? "gsap-controlled" : ""} ${flipped ? "is-flipped" : ""} ${showdown ? "is-showdown" : ""}`}
      data-gsap-deal={gsapDeal ? "true" : undefined}
      style={style}
    >
      <div className="card-flip-inner">
        <div className="card-face card-back-svg">
          <BackAsset height="100%" width="100%" />
        </div>
        <div className="card-face card-real-face">
          <CardAsset height="100%" width="100%" />
        </div>
      </div>
    </div>
  );
}

function TransferRequestModal({
  draft,
  onCancel,
  onChange,
  onSubmit,
  players,
  requesterId,
}: {
  draft: TransferDraft | null;
  onCancel: () => void;
  onChange: (draft: TransferDraft) => void;
  onSubmit: () => void;
  players: TablePlayer[];
  requesterId: string;
}) {
  if (!draft) {
    return null;
  }

  const availablePlayers = players.filter(
    (player) => player.id !== requesterId && player.status !== "standing",
  );

  return (
    <div className="modal-backdrop fixed inset-0 z-[60] grid place-items-center px-4">
      <section className="modal-surface w-full max-w-sm p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase text-[#e2b653]">Player transfer</p>
            <h2 className="text-xl font-black text-white">Request chips</h2>
          </div>
          <button
            aria-label="Close transfer request"
            className="icon-action grid h-10 w-10 place-items-center"
            type="button"
            onClick={onCancel}
          >
            <X size={20} />
          </button>
        </div>

        <label className="mt-4 block text-sm font-semibold text-white/70">
          Ask player
          <select
            className="control-field mt-2 h-12 w-full px-3 text-white"
            value={draft.targetId}
            onChange={(event) => onChange({ ...draft, targetId: event.target.value })}
          >
            {availablePlayers.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name} ({player.chips} chips)
              </option>
            ))}
          </select>
        </label>

        <label className="mt-4 block text-sm font-semibold text-white/70">
          Whole chips
          <input
            className="control-field mt-2 h-12 w-full px-3 text-white"
            inputMode="numeric"
            min={1}
            type="number"
            value={draft.amount}
            onChange={(event) =>
              onChange({ ...draft, amount: Math.max(1, Number(event.target.value) || 1) })
            }
          />
        </label>

        <button
          className="primary-action mt-4 flex h-12 w-full items-center justify-center gap-2 text-sm font-black"
          type="button"
          onClick={onSubmit}
        >
          <ArrowRightLeft size={18} />
          Send Request
        </button>
      </section>
    </div>
  );
}

function SessionTallyModal({
  onClose,
  open,
  players,
  potChips,
  transferLedger = [],
}: {
  onClose: () => void;
  open: boolean;
  players: Array<LobbyPlayer | TablePlayer>;
  potChips: number;
  transferLedger?: TransferLedgerEntry[];
}) {
  if (!open) {
    return null;
  }

  const rows = players.map((player) => {
    const chips = "chips" in player ? player.chips : 0;
    const shortChips = "shortChips" in player ? player.shortChips : 0;
    const totalBuyInChips =
      "totalBuyInChips" in player ? player.totalBuyInChips : player.chips;
    const transferBalanceChips =
      "transferBalanceChips" in player ? player.transferBalanceChips : 0;
    const netChips = chips - totalBuyInChips - transferBalanceChips - shortChips;

    return {
      id: player.id,
      name: player.name,
      chips,
      shortChips,
      totalBuyInChips,
      transferBalanceChips,
      netChips,
      buyInRupees: rupeesForChips(totalBuyInChips),
      closingRupees: rupeesForChips(chips),
      netRupees: rupeesForChips(netChips),
    };
  });
  const totalBuyInChips = rows.reduce((total, row) => total + row.totalBuyInChips, 0);
  const totalClosingChips = rows.reduce((total, row) => total + row.chips, 0);
  const totalShortChips = rows.reduce((total, row) => total + row.shortChips, 0);
  const tablePlayers = players.filter((player): player is TablePlayer => "hand" in player);
  const playerNames = new Map(players.map((player) => [player.id, player.name]));
  const gameSettlements = calculatePlayerSettlements(tablePlayers);
  const transferObligations = calculateTransferObligations(transferLedger);
  const settlementLines = netPlayerSettlements([
    ...gameSettlements,
    ...transferObligations,
  ]).map((settlement) => settlementSentence(settlement, playerNames));
  const transferLines = transferObligations.map((settlement) =>
    settlementSentence(settlement, playerNames),
  );

  function downloadTally() {
    const playerRows = rows
      .map(
        (row) => `<tr>
          <td><strong>${escapeHtml(row.name)}</strong></td>
          <td>Rs ${formatRupees(row.buyInRupees)}<br><small>${row.totalBuyInChips} chips</small></td>
          <td>Rs ${formatRupees(row.closingRupees)}<br><small>${row.chips} chips</small></td>
          <td class="${row.netChips >= 0 ? "positive" : "negative"}">${row.netChips >= 0 ? "+" : "-"}Rs ${formatRupees(Math.abs(row.netRupees))}<br><small>${row.netChips >= 0 ? "+" : ""}${row.netChips} chips</small></td>
        </tr>`,
      )
      .join("");
    const settlementItems = settlementLines.length
      ? settlementLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")
      : potChips > 0
        ? "<li>Finish the hand to calculate the final game settlement.</li>"
        : "<li>Everyone is settled.</li>";
    const transferItems = transferLines.length
      ? transferLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")
      : "<li>No personal chip requests remain to settle.</li>";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>North Tash Session Tally</title><style>
      body{font-family:Arial,sans-serif;background:#f4f1e8;color:#172117;padding:32px;line-height:1.4}main{max-width:820px;margin:auto;background:#fff;padding:28px;border:1px solid #d9cda9}h1{margin:0 0 4px;color:#244b36}h2{margin-top:28px;color:#244b36}p{color:#596158}table{border-collapse:collapse;width:100%;margin-top:16px}th{background:#244b36;color:white;text-align:left}th,td{border:1px solid #d9ded7;padding:10px;vertical-align:top}tr:nth-child(even){background:#f6f8f4}small{color:#69736a}.positive{color:#13733b;font-weight:bold}.negative{color:#a42e35;font-weight:bold}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.summary div,li{border:1px solid #d9ded7;padding:12px;background:#f6f8f4}.summary strong{display:block;font-size:20px}ul{list-style:none;padding:0;display:grid;gap:8px}@media(max-width:700px){body{padding:12px}.summary{grid-template-columns:1fr}table{font-size:12px}th,td{padding:6px}}
    </style></head><body><main><h1>North Tash - Session Tally</h1><p>Final player balances and clear payment instructions.</p><div class="summary"><div>Total buy-in<strong>${totalBuyInChips} chips</strong><small>Rs ${formatRupees(rupeesForChips(totalBuyInChips))}</small></div><div>Closing stacks<strong>${totalClosingChips} chips</strong><small>Rs ${formatRupees(rupeesForChips(totalClosingChips))}</small></div><div>Table pot<strong>${potChips} chips</strong><small>Rs ${formatRupees(rupeesForChips(potChips))}</small></div></div><h2>Who pays whom</h2><ul>${settlementItems}</ul><h2>Personal chip requests</h2><ul>${transferItems}</ul><h2>Player balances</h2><table><thead><tr><th>Player</th><th>Buy-in</th><th>Closing stack</th><th>Game balance</th></tr></thead><tbody>${playerRows}</tbody></table>${potChips > 0 ? `<p><strong>Rs ${formatRupees(rupeesForChips(potChips))} remains in the table pot.</strong> Finish the hand for an exact player settlement.</p>` : ""}</main></body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "north-tash-session-tally.html";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-[60] grid place-items-center px-4">
      <section className="modal-surface max-h-[90vh] w-full max-w-lg overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase text-[#e2b653]">Session End</p>
            <h2 className="text-2xl font-black text-white">Tally Card</h2>
          </div>
          <button
            aria-label="Close tally"
            className="icon-action grid h-10 w-10 place-items-center"
            type="button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className="mt-4 rounded-md border border-[#d2a84b]/35 bg-[#d2a84b]/8 p-3">
          <p className="text-xs font-bold uppercase text-[#e2b653]">Who pays whom</p>
          <div className="mt-2 space-y-2">
            {settlementLines.length ? settlementLines.map((line) => (
              <p className="rounded-md bg-black/25 px-3 py-2 text-sm font-bold text-white" key={line}>
                {line}
              </p>
            )) : (
              <p className="text-sm text-white/65">
                {potChips > 0 ? "Finish the hand to calculate the final game settlement." : "Everyone is settled."}
              </p>
            )}
          </div>
        </div>

        {transferLines.length ? (
          <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3">
            <p className="text-xs font-bold uppercase text-white/50">Personal chip requests</p>
            <div className="mt-2 space-y-1">
              {transferLines.map((line) => (
                <p className="text-sm font-semibold text-[#f5d77d]" key={line}>{line}</p>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <div
              className="grid grid-cols-[1fr_auto] gap-3 rounded-md border border-white/10 bg-black/24 p-3"
              key={row.id}
            >
              <div>
                <p className="font-bold text-white">{row.name}</p>
                <p className="text-xs text-white/50">
                  Buy-in Rs {formatRupees(row.buyInRupees)} · Closing Rs {formatRupees(row.closingRupees)}
                </p>
              </div>
              <div className="text-right">
                <p className={`font-black ${row.netChips >= 0 ? "text-[#8ce0a6]" : "text-[#ffaaaa]"}`}>
                  {row.netChips >= 0 ? "+" : "-"}Rs {formatRupees(Math.abs(row.netRupees))}
                </p>
                <p className="text-xs text-white/50">Game balance</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-white/10 bg-black/24 p-3 text-sm">
          <div>
            <p className="text-xs uppercase text-white/45">Total buy-in</p>
            <p className="font-black text-white">{totalBuyInChips} chips</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase text-white/45">Closing stacks</p>
            <p className="font-black text-white">{totalClosingChips} chips</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase text-white/45">Table pot</p>
            <p className="font-black text-[#e2b653]">{potChips} chips</p>
          </div>
        </div>
        {potChips > 0 ? (
          <p className="mt-2 rounded-md border border-[#d2a84b]/25 bg-[#d2a84b]/8 px-3 py-2 text-center text-xs text-[#f5d77d]">
            Rs {formatRupees(rupeesForChips(potChips))} remains in the table pot. Finish the hand for exact settlement.
          </p>
        ) : totalShortChips > 0 ? (
          <p className="mt-2 text-center text-xs text-white/45">
            Unpaid table charges are included in the game balance.
          </p>
        ) : null}

        <button
          className="primary-action mt-4 flex h-12 w-full items-center justify-center gap-2 text-sm font-black"
          type="button"
          onClick={downloadTally}
        >
          <Download size={18} />
          Download Readable Tally
        </button>
      </section>
    </div>
  );
}

function ModeBadge({ mode }: { mode: GameMode }) {
  const isNormal = mode === "normal";

  return (
    <div
      className={`rounded-md px-3 py-2 text-right ${
        isNormal ? "bg-[#5a1f24] text-[#ffd9d9]" : "bg-[#ece7dd] text-[#151515]"
      }`}
    >
      <p className="text-xs uppercase opacity-70">Mode</p>
      <p className="font-semibold">{isNormal ? "Normal" : "Mufflis"}</p>
    </div>
  );
}

function Metric({ label, sub, value }: { label: string; sub: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase text-white/50">{label}</p>
      <p className="text-lg font-black text-white">{value}</p>
      <p className="text-xs text-white/50">{sub}</p>
    </div>
  );
}

function PotMetric({ chips }: { chips: number }) {
  return (
    <div>
      <p className="text-xs uppercase text-white/50">Pot</p>
      <div className="mt-1 flex items-center gap-2">
        <span className="pot-chip-motion">
          <PokerChipStack chips={chips} />
        </span>
        <p className="text-lg font-black text-white">{chips}</p>
      </div>
      <p className="text-xs text-white/50">Rs {rupeesForChips(chips)}</p>
    </div>
  );
}

function ChipPill({ chips }: { chips: number }) {
  return (
    <span className="flex items-center gap-2 rounded-md bg-[#d2a84b]/12 px-2 py-1 text-sm font-black text-[#e2b653]">
      <PokerChipStack chips={chips} compact />
      <span>{chips}</span>
    </span>
  );
}

function ChipCount({ compact = false, player }: { compact?: boolean; player: TablePlayer }) {
  return (
    <div className={`flex items-center gap-2 ${compact ? "text-right" : ""}`}>
      <PokerChipStack chips={player.chips} />
      {!compact ? (
        <span className="text-sm text-white/55">
          Rs {rupeesForChips(player.chips)}
          {player.shortChips > 0 ? ` / short ${player.shortChips}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function PokerChipStack({ chips, compact = false }: { chips: number; compact?: boolean }) {
  const colors = ["red", "blue", "green", "black", "white"] as const;
  const visibleChips = Math.min(compact ? 3 : 5, Math.max(1, Math.ceil(chips / 5)));

  return (
    <span className={`chip-stack ${compact ? "is-compact" : ""}`} aria-label={`${chips} chips`}>
      {Array.from({ length: visibleChips }).map((_, index) => (
        <span
          className={`poker-chip poker-chip-${colors[index % colors.length]}`}
          key={`${chips}-${index}`}
          style={{ "--chip-offset": `${index * -5}px` } as CSSProperties}
        />
      ))}
      {!compact ? <span className="chip-stack-count">{chips}</span> : null}
    </span>
  );
}

function DealerBadge() {
  return (
    <span className="rounded-md bg-[#d2a84b] px-1.5 py-0.5 text-[10px] font-black text-[#161812]">
      D
    </span>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function logToneClass(tone: LogTone) {
  switch (tone) {
    case "good":
      return "border-[#d2a84b]/25 bg-[#d2a84b]/10 text-[#ffe59a]";
    case "warn":
      return "border-[#e2b653]/20 bg-[#7a5b1d]/20 text-[#ffe7ad]";
    case "danger":
      return "border-[#b95f5f]/30 bg-[#451c1f]/70 text-[#ffd7d7]";
    case "neutral":
      return "border-white/10 bg-black/20 text-white/70";
  }
}

function cardAssetName(card: Card) {
  const suitPrefix: Record<Card["suit"], string> = {
    clubs: "C",
    diamonds: "D",
    hearts: "H",
    spades: "S",
  };
  const rankSuffix = card.rank.length === 1 ? card.rank.toLowerCase() : card.rank;

  return `${suitPrefix[card.suit]}${rankSuffix}`;
}

function logToOverlayTone(tone?: LogTone): Overlay["tone"] {
  if (tone === "good") {
    return "good";
  }

  if (tone === "warn" || tone === "danger") {
    return "warn";
  }

  return "neutral";
}

function shortActionText(text: string) {
  const lowerText = text.toLowerCase();

  if (lowerText.includes("declined")) {
    return "Show declined";
  }

  if (lowerText.includes("folded")) {
    return "Fold";
  }

  if (lowerText.includes("played")) {
    return "Chaal";
  }

  if (lowerText.includes("won")) {
    return "Show result";
  }

  return text;
}

function seatPositionClass(index: number, playerCount: number) {
  const seatMap: Record<number, string[]> = {
    2: [
      "left-1/2 bottom-0 -translate-x-1/2",
      "left-1/2 -top-2 -translate-x-1/2",
    ],
    3: [
      "left-1/2 bottom-0 -translate-x-1/2",
      "right-3 top-[20%] sm:right-10",
      "left-3 top-[20%] sm:left-10",
    ],
    4: [
      "left-1/2 bottom-0 -translate-x-1/2",
      "right-4 top-1/2 -translate-y-1/2 sm:right-10",
      "left-1/2 -top-2 -translate-x-1/2",
      "left-4 top-1/2 -translate-y-1/2 sm:left-10",
    ],
    5: [
      "left-1/2 bottom-0 -translate-x-1/2",
      "right-2 bottom-[26%] sm:right-8",
      "right-[26%] -top-2 translate-x-1/2",
      "left-[26%] -top-2 -translate-x-1/2",
      "left-2 bottom-[26%] sm:left-8",
    ],
    6: [
      "left-1/2 bottom-0 -translate-x-1/2",
      "right-2 bottom-[24%] sm:right-8",
      "right-4 top-[22%] sm:right-12",
      "left-1/2 -top-2 -translate-x-1/2",
      "left-4 top-[22%] sm:left-12",
      "left-2 bottom-[24%] sm:left-8",
    ],
    7: [
      "left-1/2 bottom-0 -translate-x-1/2",
      "right-2 bottom-[22%] sm:right-6",
      "right-4 top-[25%] sm:right-12",
      "right-[35%] -top-2 translate-x-1/2",
      "left-[35%] -top-2 -translate-x-1/2",
      "left-4 top-[25%] sm:left-12",
      "left-2 bottom-[22%] sm:left-6",
    ],
  };

  return seatMap[playerCount]?.[index] ?? seatMap[4][index % 4];
}

function dealOriginForSeat(index: number, playerCount: number) {
  const angle = Math.PI / 2 + (index * Math.PI * 2) / playerCount;

  return {
    x: Math.round(Math.cos(angle) * 150),
    y: Math.round(-Math.sin(angle) * 190),
  };
}

function tableSeatOrder(seat: string) {
  const order = ["South", "West", "North", "East", "Far West", "Far East", "Top"];
  return Math.max(0, order.indexOf(seat));
}

function settlementSentence(
  settlement: { fromPlayerId: string; toPlayerId: string; chips: number },
  playerNames: Map<string, string>,
) {
  const fromName = playerNames.get(settlement.fromPlayerId) ?? "Player";
  const toName = playerNames.get(settlement.toPlayerId) ?? "Player";
  return `${fromName} owes Rs ${formatRupees(rupeesForChips(settlement.chips))} to ${toName}`;
}

function formatRupees(value: number) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

function roomKey(code: string) {
  return `${ROOM_PREFIX}${code}`;
}

function readRoom(code: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const rawRoom = window.localStorage.getItem(roomKey(code));
  return rawRoom ? parseRoom(rawRoom) : null;
}

function saveRoom(room: RoomState) {
  window.localStorage.setItem(roomKey(room.code), JSON.stringify(room));
}

function readActiveRoomSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const rawSession = window.localStorage.getItem(ACTIVE_ROOM_KEY);

  if (!rawSession) {
    return null;
  }

  try {
    const session = JSON.parse(rawSession) as {
      code?: unknown;
      name?: unknown;
      chips?: unknown;
    };

    if (
      typeof session.code !== "string" ||
      !/^\d{3}$/.test(session.code) ||
      typeof session.name !== "string" ||
      typeof session.chips !== "number"
    ) {
      return null;
    }

    return { code: session.code, name: session.name, chips: session.chips };
  } catch {
    return null;
  }
}

function saveActiveRoomSession(session: { code: string; name: string; chips: number }) {
  window.localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify(session));
}

function clearActiveRoomSession() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(ACTIVE_ROOM_KEY);
  }
}

function parseRoom(rawRoom: string): RoomState | null {
  try {
    return JSON.parse(rawRoom) as RoomState;
  } catch {
    return null;
  }
}

function upsertPlayer(room: RoomState, player: LobbyPlayer): RoomState {
  const players = room.players.filter((currentPlayer) => currentPlayer.id !== player.id);

  return {
    ...room,
    players: [...players, player].slice(0, AFLATOON_RULES.maxPlayers),
  };
}
