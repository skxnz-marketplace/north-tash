import {
  AFLATOON_RULES,
  RANKS,
  SUITS,
  describeCenterCard,
  getOpeningCenterAdvance,
  resolveShowComparison,
} from "./aflatoon.ts";
import type { Card, ShowResolution } from "./aflatoon.ts";
import type { FlippingState } from "./flipping.ts";
import type { TableGameMode } from "./game-rules.ts";
import type { TexasHoldemState } from "./poker.ts";

export type TablePhase = "collecting-boots" | "playing" | "hand-complete";
export type PlayerStatus = "active" | "folded" | "eliminated" | "standing";
export type LogTone = "neutral" | "good" | "warn" | "danger";

export interface TablePlayer {
  id: string;
  name: string;
  seat: string;
  chips: number;
  totalBuyInChips: number;
  transferBalanceChips: number;
  shortChips: number;
  declinesUsed: number;
  status: PlayerStatus;
  isBot: boolean;
  hand: Card[];
}

export interface ActionLogEntry {
  id: string;
  text: string;
  tone: LogTone;
}

export interface BuyInRequest {
  id: string;
  playerId: string;
  playerName: string;
  chips: 10 | 20;
}

export interface TransferRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  targetId: string;
  amount: number;
}

export interface TransferLedgerEntry {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  chips: number;
}

export interface PlayerSettlement {
  fromPlayerId: string;
  toPlayerId: string;
  chips: number;
}

export interface TableState {
  gameMode?: TableGameMode;
  roomCode: string;
  userId: string;
  phase: TablePhase;
  handNumber: number;
  dealerIndex: number;
  turnIndex: number;
  pot: number;
  carryOverPot: number;
  deck: Card[];
  centerHistory: Card[];
  players: TablePlayer[];
  revealedPlayerIds: string[];
  actionCount: number;
  lastShow?: ShowResolution;
  log: ActionLogEntry[];
  startAt?: number;
  revision: number;
  pendingShow?: {
    requestId: string;
    requesterId: string;
    defenderId: string;
    label: "Show" | "Back show";
  };
  privateReveal?: {
    requestId: string;
    playerIds: string[];
    viewerIds: string[];
    expiresAt: number;
  };
  pendingBootPlayerIds?: string[];
  pendingBuyInRequests?: BuyInRequest[];
  pendingTransferRequests?: TransferRequest[];
  transferLedger?: TransferLedgerEntry[];
  poker?: TexasHoldemState;
  flipping?: FlippingState;
}

const SEATS = ["South", "West", "North", "East", "Far West", "Far East", "Top"];

export function makeRoomCode(seed = Date.now()) {
  return String(100 + (Math.abs(seed) % 900));
}

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shuffleDeck(deck: Card[], seed = Date.now()) {
  const shuffled = [...deck];
  const random = seededRandom(seed);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

export function createLocalTable(input: {
  roomCode: string;
  userName: string;
  startingChips?: number;
  seed?: number;
  botNames?: string[];
}) {
  const names = [input.userName.trim() || "You", ...(input.botNames ?? [])];
  const players = names.slice(0, AFLATOON_RULES.maxPlayers).map<TablePlayer>((name, index) => ({
    id: index === 0 ? "you" : `bot-${index}`,
    name,
    seat: SEATS[index],
      chips: index === 0 ? input.startingChips ?? AFLATOON_RULES.startingChips : AFLATOON_RULES.startingChips,
      totalBuyInChips:
        index === 0 ? input.startingChips ?? AFLATOON_RULES.startingChips : AFLATOON_RULES.startingChips,
      transferBalanceChips: 0,
    shortChips: 0,
    declinesUsed: 0,
    status: "active",
    isBot: index !== 0,
    hand: [],
  }));

  return dealNewHand({
    roomCode: input.roomCode,
    userId: "you",
    players,
    dealerIndex: Math.abs(input.seed ?? Date.now()) % players.length,
    handNumber: 1,
    carryOverPot: 0,
    seed: input.seed,
    openingLog: `Room ${input.roomCode} started with ${players.length} players.`,
  });
}

export function createTableFromPlayers(input: {
  roomCode: string;
  userId: string;
  players: Array<{
    id: string;
    name: string;
    chips: number;
    isBot?: boolean;
    isHost?: boolean;
  }>;
  seed?: number;
  startAt?: number;
}) {
  const players = input.players
    .slice(0, AFLATOON_RULES.maxPlayers)
    .map<TablePlayer>((player, index) => ({
      id: player.id,
      name: player.name,
      seat: SEATS[index],
      chips: player.chips,
      totalBuyInChips: player.chips,
      transferBalanceChips: 0,
      shortChips: 0,
      declinesUsed: 0,
      status: "active",
      isBot: player.isBot ?? false,
      hand: [],
    }));

  return prepareNewHand({
    roomCode: input.roomCode,
    userId: input.userId,
    players,
    dealerIndex: Math.abs(input.seed ?? 0) % players.length,
    handNumber: 1,
    carryOverPot: 0,
    openingLog: `Room ${input.roomCode} started with ${players.length} players.`,
  });
}

function prepareNewHand(input: {
  roomCode: string;
  userId: string;
  players: TablePlayer[];
  dealerIndex: number;
  handNumber: number;
  carryOverPot: number;
  openingLog?: string;
  transferLedger?: TransferLedgerEntry[];
}): TableState {
  const seatedPlayers = input.players.filter((player) => player.status !== "standing");

  if (
    seatedPlayers.length < AFLATOON_RULES.minPlayers ||
    seatedPlayers.length > AFLATOON_RULES.maxPlayers
  ) {
    throw new RangeError("Aflatoon needs 2 to 7 seated players.");
  }

  const players = input.players.map<TablePlayer>((player) => ({
    ...player,
    hand: [],
    declinesUsed: 0,
    status: player.status === "standing" ? "standing" : "active",
  }));
  const dealerIndex = clampSeatIndex(input.dealerIndex, players);

  return {
    gameMode: "AFLATOON",
    roomCode: input.roomCode,
    userId: input.userId,
    phase: "collecting-boots",
    handNumber: input.handNumber,
    dealerIndex,
    turnIndex: nextActiveIndex(players, dealerIndex),
    pot: input.carryOverPot,
    carryOverPot: 0,
    deck: [],
    centerHistory: [],
    players,
    revealedPlayerIds: [],
    actionCount: 0,
    log: [
      makeLog(input.openingLog ?? `Round ${input.handNumber} is ready.`, "good"),
      makeLog(`Waiting for every player to put in the ${AFLATOON_RULES.bootChips}-chip boot.`, "neutral"),
    ],
    pendingBootPlayerIds: players
      .filter((player) => player.status === "active")
      .map((player) => player.id),
    revision: 0,
    transferLedger: input.transferLedger?.map((entry) => ({ ...entry })) ?? [],
  };
}

export function dealNewHand(input: {
  roomCode: string;
  userId: string;
  players: TablePlayer[];
  dealerIndex: number;
  handNumber: number;
  carryOverPot: number;
  seed?: number;
  openingLog?: string;
  startAt?: number;
  transferLedger?: TransferLedgerEntry[];
  bootsAlreadyCollected?: boolean;
}): TableState {
  const seatedPlayers = input.players.filter((player) => player.status !== "standing");

  if (
    seatedPlayers.length < AFLATOON_RULES.minPlayers ||
    seatedPlayers.length > AFLATOON_RULES.maxPlayers
  ) {
    throw new RangeError("Aflatoon needs 2 to 7 seated players.");
  }

  let deck = shuffleDeck(createDeck(), input.seed ?? Date.now() + input.handNumber);
  const players = input.players.map<TablePlayer>((player, index) => {
    const hand = player.status === "standing" ? [] : deck.slice(index * 3, index * 3 + 3);

    return {
      ...player,
      hand,
      declinesUsed: 0,
      status: player.status === "standing" ? "standing" : "active",
    };
  });

  deck = deck.slice(players.length * 3);

  const centerAdvance = getOpeningCenterAdvance(seatedPlayers.length);
  const centerHistory = deck.slice(0, centerAdvance);
  deck = deck.slice(centerAdvance);

  const dealerIndex = clampSeatIndex(input.dealerIndex, players);
  const openerIndex = nextActiveIndex(players, dealerIndex);
  let pot = input.carryOverPot;

  if (!input.bootsAlreadyCollected) {
    for (const player of players) {
      if (player.status === "active") {
        pot += chargePlayer(player, AFLATOON_RULES.bootChips);
      }
    }
  }

  // The opener's compulsory chaal is their total opening contribution, not an
  // extra 3 chips on top of the 2-chip boot.
  pot += chargePlayer(
    players[openerIndex],
    AFLATOON_RULES.openingChaalChips - AFLATOON_RULES.bootChips,
  );

  const firstTurnIndex = nextActiveIndex(players, openerIndex);
  const activeCenter = centerHistory[centerHistory.length - 1];
  const center = describeCenterCard(activeCenter);

  return {
    gameMode: "AFLATOON",
    roomCode: input.roomCode,
    userId: input.userId,
    phase: "playing",
    handNumber: input.handNumber,
    dealerIndex,
    turnIndex: firstTurnIndex,
    pot,
    carryOverPot: 0,
    deck,
    centerHistory,
    players,
    revealedPlayerIds: [],
    actionCount: 0,
    pendingBootPlayerIds: [],
    log: [
      makeLog(input.openingLog ?? `Hand ${input.handNumber} dealt.`, "good"),
      makeLog(
        `Opening centre advanced ${centerAdvance} cards. ${activeCenter.rank} opened: ${center.mode}, jokers ${center.jokerRanks.join(", ")}.`,
        "neutral",
      ),
      makeLog(
        `${players[openerIndex].name} opened with ${AFLATOON_RULES.openingChaalChips} chips total.`,
        "neutral",
      ),
    ],
    startAt: input.startAt,
    revision: 0,
    transferLedger: input.transferLedger?.map((entry) => ({ ...entry })) ?? [],
  };
}

export function payBoot(state: TableState, playerId: string, startAt?: number): TableState {
  if (state.phase !== "collecting-boots" || !state.pendingBootPlayerIds?.includes(playerId)) {
    return state;
  }

  const nextState = cloneState(state);
  const player = nextState.players.find((candidate) => candidate.id === playerId);

  if (!player || player.status !== "active") {
    return state;
  }

  nextState.pot += chargePlayer(player, AFLATOON_RULES.bootChips);
  nextState.pendingBootPlayerIds = nextState.pendingBootPlayerIds?.filter((id) => id !== playerId);
  const withLog = appendLog(nextState, `${player.name} put in the ${AFLATOON_RULES.bootChips}-chip boot.`, "neutral");

  if (withLog.pendingBootPlayerIds?.length) {
    return withLog;
  }

  return dealNewHand({
    roomCode: withLog.roomCode,
    userId: withLog.userId,
    players: withLog.players,
    dealerIndex: withLog.dealerIndex,
    handNumber: withLog.handNumber,
    carryOverPot: withLog.pot,
    seed: Date.now(),
    startAt,
    openingLog: `All boots are in. Hand ${withLog.handNumber} dealt.`,
    transferLedger: withLog.transferLedger,
    bootsAlreadyCollected: true,
  });
}

export function getActiveCenter(state: TableState) {
  return state.centerHistory[state.centerHistory.length - 1];
}

export function getActivePlayers(state: TableState) {
  return state.players.filter((player) => player.status === "active");
}

export function getCurrentPlayer(state: TableState) {
  return state.players[state.turnIndex];
}

export function canUserAct(state: TableState) {
  const currentPlayer = getCurrentPlayer(state);

  return state.phase === "playing" && currentPlayer?.id === state.userId;
}

export function playChaal(state: TableState, playerId: string): TableState {
  if (!isPlayersTurn(state, playerId)) {
    return appendLog(state, "It is not this player's turn.", "warn");
  }

  const nextState = cloneState(state);
  const player = nextState.players[nextState.turnIndex];
  nextState.pot += chargePlayer(player, AFLATOON_RULES.fixedChaalChips);
  nextState.actionCount += 1;

  flipNextCenter(nextState);
  nextState.turnIndex = nextActiveIndex(nextState.players, nextState.turnIndex);

  return appendLog(
    nextState,
    `${player.name} played ${AFLATOON_RULES.fixedChaalChips} chip. Centre moved automatically.`,
    player.id === state.userId ? "good" : "neutral",
  );
}

export function foldPlayer(state: TableState, playerId: string): TableState {
  if (state.phase !== "playing") {
    return state;
  }

  const nextState = cloneState(state);
  const playerIndex = nextState.players.findIndex((player) => player.id === playerId);

  if (playerIndex < 0 || nextState.players[playerIndex].status !== "active") {
    return state;
  }

  nextState.players[playerIndex].status = "folded";
  nextState.revealedPlayerIds = reveal(nextState.revealedPlayerIds, playerId);
  nextState.actionCount += 1;

  const livePlayers = getActivePlayers(nextState);
  const withLog = appendLog(nextState, `${nextState.players[playerIndex].name} folded.`, "warn");

  if (livePlayers.length === 1) {
    return awardPot(withLog, [livePlayers[0].id], "Last active player wins the pot.");
  }

  if (nextState.turnIndex === playerIndex) {
    nextState.turnIndex = nextActiveIndex(nextState.players, playerIndex);
  }

  return withLog;
}

export function requestBackShow(state: TableState, requesterId: string): TableState {
  if (!isPlayersTurn(state, requesterId)) {
    return appendLog(state, "Back show can only be requested on your turn.", "warn");
  }

  const defenderIndex = previousActiveIndex(state.players, state.turnIndex);
  const defender = state.players[defenderIndex];
  const currentCenter = describeCenterCard(getActiveCenter(state));
  const preview = resolveShowComparison({
    requesterId,
    defenderId: defender.id,
    requesterCards: state.players[state.turnIndex].hand,
    defenderCards: defender.hand,
    mode: currentCenter.mode,
    jokerRanks: currentCenter.jokerRanks,
  });

  const defenderWouldLose = preview.loserId === defender.id;
  const defenderCanDecline = defender.declinesUsed < AFLATOON_RULES.declinesPerHand;

  if (defenderCanDecline && defenderWouldLose) {
    return declineBackShow(state, defenderIndex);
  }

  return acceptBackShow(state, defenderIndex);
}

export function respondToShowRequest(
  state: TableState,
  requesterId: string,
  response: "accept" | "decline",
): TableState {
  if (!isPlayersTurn(state, requesterId)) {
    return appendLog(state, "Show response is no longer active.", "warn");
  }

  const requester = state.players[state.turnIndex];
  const livePlayers = getActivePlayers(state);
  const defenderIndex = state.pendingShow
    ? state.players.findIndex((player) => player.id === state.pendingShow?.defenderId)
    :
    livePlayers.length === 2
      ? state.players.findIndex(
          (player) => player.status === "active" && player.id !== requester.id,
        )
      : previousActiveIndex(state.players, state.turnIndex);

  if (defenderIndex < 0) {
    return appendLog(state, "No defender found for show.", "warn");
  }

  if (response === "decline") {
    const declined = declineBackShow(state, defenderIndex);
    declined.pendingShow = undefined;
    return declined;
  }

  const accepted = acceptBackShow(state, defenderIndex);
  accepted.pendingShow = undefined;
  accepted.privateReveal = {
    requestId: state.pendingShow?.requestId ?? `show-${state.actionCount + 1}`,
    playerIds: [requester.id, state.players[defenderIndex].id],
    viewerIds: [requester.id, state.players[defenderIndex].id],
    expiresAt: Date.now() + 2200,
  };
  return accepted;
}

export function createShowRequest(
  state: TableState,
  requesterId: string,
  requestId: string,
  label: "Show" | "Back show",
) {
  if (!isPlayersTurn(state, requesterId) || state.pendingShow) {
    return state;
  }

  const livePlayers = getActivePlayers(state);
  const defender =
    livePlayers.length === 2
      ? livePlayers.find((player) => player.id !== requesterId)
      : state.players[previousActiveIndex(state.players, state.turnIndex)];

  if (!defender) {
    return state;
  }

  return {
    ...state,
    pendingShow: {
      requestId,
      requesterId,
      defenderId: defender.id,
      label,
    },
  };
}

export function requestFinalShow(state: TableState, requesterId: string): TableState {
  if (!isPlayersTurn(state, requesterId)) {
    return appendLog(state, "Show can only be requested on your turn.", "warn");
  }

  const livePlayers = getActivePlayers(state);

  if (livePlayers.length !== 2) {
    return appendLog(state, "Final show is available only when two players remain.", "warn");
  }

  const requester = state.players[state.turnIndex];
  const defender = livePlayers.find((player) => player.id !== requester.id);

  if (!defender) {
    return state;
  }

  const center = describeCenterCard(getActiveCenter(state));
  const resolution = resolveShowComparison({
    requesterId: requester.id,
    defenderId: defender.id,
    requesterCards: requester.hand,
    defenderCards: defender.hand,
    mode: center.mode,
    jokerRanks: center.jokerRanks,
  });
  const nextState = cloneState(state);
  nextState.lastShow = resolution;
  nextState.revealedPlayerIds = reveal(
    nextState.revealedPlayerIds,
    requester.id,
    defender.id,
  );
  nextState.actionCount += 1;

  if (resolution.outcome === "split") {
    return awardPot(
      appendLog(nextState, `Final show split: ${resolution.reason}.`, "good"),
      [requester.id, defender.id],
      "Pot split.",
    );
  }

  return awardPot(
    appendLog(
      nextState,
      `${nextState.players.find((player) => player.id === resolution.winnerId)?.name} won the final show.`,
      "good",
    ),
    [resolution.winnerId ?? defender.id],
    "Final show complete.",
  );
}

export function buyInChips(
  state: TableState,
  playerId: string,
  chips: 10 | 20,
): TableState {
  const nextState = cloneState(state);
  const player = nextState.players.find((currentPlayer) => currentPlayer.id === playerId);

  if (!player) {
    return state;
  }

  player.chips += chips;
  player.totalBuyInChips += chips;
  return appendLog(nextState, `${player.name} took a ${chips}-chip buy-in.`, "good");
}

export function transferPlayerChips(
  state: TableState,
  fromPlayerId: string,
  toPlayerId: string,
  requestedChips: number,
  approvedChips: number,
  transferId?: string,
): TableState {
  if (!Number.isInteger(requestedChips) || requestedChips < 1) {
    return appendLog(state, "Transfer request must be a whole number.", "warn");
  }

  const nextState = cloneState(state);
  const giver = nextState.players.find((player) => player.id === fromPlayerId);
  const receiver = nextState.players.find((player) => player.id === toPlayerId);

  if (!giver || !receiver || giver.id === receiver.id) {
    return appendLog(state, "Transfer players are no longer available.", "warn");
  }

  const approved = Math.max(0, Math.min(Math.floor(approvedChips), requestedChips, giver.chips));

  if (approved === 0) {
    return appendLog(nextState, `${giver.name} declined ${receiver.name}'s chip request.`, "warn");
  }

  giver.chips -= approved;
  receiver.chips += approved;
  giver.transferBalanceChips -= approved;
  receiver.transferBalanceChips += approved;
  nextState.transferLedger = [
    ...(nextState.transferLedger ?? []),
    {
      id: transferId ?? `transfer-${Date.now()}-${nextState.transferLedger?.length ?? 0}`,
      fromPlayerId: giver.id,
      toPlayerId: receiver.id,
      chips: approved,
    },
  ];

  return appendLog(
    nextState,
    `${giver.name} transferred ${approved} of ${requestedChips} requested chips to ${receiver.name}.`,
    "good",
  );
}

export function queueBuyInRequest(
  state: TableState,
  request: BuyInRequest,
): TableState {
  const player = state.players.find((candidate) => candidate.id === request.playerId);
  const pendingRequests = state.pendingBuyInRequests ?? [];

  if (
    !player ||
    (request.chips !== 10 && request.chips !== 20) ||
    pendingRequests.some((pending) => pending.playerId === request.playerId)
  ) {
    return state;
  }

  return {
    ...state,
    pendingBuyInRequests: [
      ...pendingRequests,
      { ...request, playerName: player.name },
    ],
  };
}

export function resolveBuyInRequest(
  state: TableState,
  requestId: string,
  response: "accept" | "decline",
): TableState {
  const request = state.pendingBuyInRequests?.find((candidate) => candidate.id === requestId);

  if (!request) {
    return state;
  }

  const withoutRequest = {
    ...state,
    pendingBuyInRequests: state.pendingBuyInRequests?.filter(
      (candidate) => candidate.id !== requestId,
    ),
  };

  return response === "accept"
    ? buyInChips(withoutRequest, request.playerId, request.chips)
    : appendLog(withoutRequest, `${request.playerName}'s buy-in request was declined.`, "warn");
}

export function queueTransferRequest(
  state: TableState,
  request: TransferRequest,
): TableState {
  const requester = state.players.find((player) => player.id === request.requesterId);
  const target = state.players.find((player) => player.id === request.targetId);
  const pendingRequests = state.pendingTransferRequests ?? [];

  if (
    !requester ||
    !target ||
    requester.id === target.id ||
    requester.status === "standing" ||
    target.status === "standing" ||
    !Number.isInteger(request.amount) ||
    request.amount < 1 ||
    pendingRequests.some((pending) => pending.requesterId === request.requesterId)
  ) {
    return state;
  }

  return {
    ...state,
    pendingTransferRequests: [
      ...pendingRequests,
      { ...request, requesterName: requester.name },
    ],
  };
}

export function resolveTransferRequest(
  state: TableState,
  requestId: string,
  responderId: string,
  response: "accept" | "decline",
): TableState {
  const request = state.pendingTransferRequests?.find(
    (candidate) => candidate.id === requestId,
  );

  if (!request || request.targetId !== responderId) {
    return state;
  }

  const withoutRequest = {
    ...state,
    pendingTransferRequests: state.pendingTransferRequests?.filter(
      (candidate) => candidate.id !== requestId,
    ),
  };

  return transferPlayerChips(
    withoutRequest,
    responderId,
    request.requesterId,
    request.amount,
    response === "accept" ? request.amount : 0,
    request.id,
  );
}

export function calculatePlayerSettlements(players: TablePlayer[]): PlayerSettlement[] {
  const debtors = players
    .map((player) => ({
      id: player.id,
      chips: Math.max(
        0,
        -(player.chips - player.totalBuyInChips - player.transferBalanceChips - player.shortChips),
      ),
    }))
    .filter((balance) => balance.chips > 0);
  const creditors = players
    .map((player) => ({
      id: player.id,
      chips: Math.max(
        0,
        player.chips - player.totalBuyInChips - player.transferBalanceChips - player.shortChips,
      ),
    }))
    .filter((balance) => balance.chips > 0);
  const settlements: PlayerSettlement[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const chips = Math.min(debtor.chips, creditor.chips);

    settlements.push({ fromPlayerId: debtor.id, toPlayerId: creditor.id, chips });
    debtor.chips -= chips;
    creditor.chips -= chips;

    if (debtor.chips === 0) debtorIndex += 1;
    if (creditor.chips === 0) creditorIndex += 1;
  }

  return settlements;
}

export function calculateTransferObligations(
  ledger: TransferLedgerEntry[],
): PlayerSettlement[] {
  const pairBalances = new Map<string, { firstId: string; secondId: string; chips: number }>();

  for (const entry of ledger) {
    if (entry.chips <= 0 || entry.fromPlayerId === entry.toPlayerId) continue;

    const [firstId, secondId] = [entry.fromPlayerId, entry.toPlayerId].sort();
    const key = `${firstId}:${secondId}`;
    const current = pairBalances.get(key) ?? { firstId, secondId, chips: 0 };
    current.chips += entry.toPlayerId === firstId ? entry.chips : -entry.chips;
    pairBalances.set(key, current);
  }

  return [...pairBalances.values()]
    .filter((balance) => balance.chips !== 0)
    .map((balance) => ({
      fromPlayerId: balance.chips > 0 ? balance.firstId : balance.secondId,
      toPlayerId: balance.chips > 0 ? balance.secondId : balance.firstId,
      chips: Math.abs(balance.chips),
    }));
}

export function netPlayerSettlements(settlements: PlayerSettlement[]): PlayerSettlement[] {
  const balances = new Map<string, number>();

  for (const settlement of settlements) {
    if (settlement.chips <= 0 || settlement.fromPlayerId === settlement.toPlayerId) continue;

    balances.set(
      settlement.fromPlayerId,
      (balances.get(settlement.fromPlayerId) ?? 0) - settlement.chips,
    );
    balances.set(
      settlement.toPlayerId,
      (balances.get(settlement.toPlayerId) ?? 0) + settlement.chips,
    );
  }

  const debtors = [...balances]
    .filter(([, chips]) => chips < 0)
    .map(([id, chips]) => ({ id, chips: -chips }));
  const creditors = [...balances]
    .filter(([, chips]) => chips > 0)
    .map(([id, chips]) => ({ id, chips }));
  const netSettlements: PlayerSettlement[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const chips = Math.min(debtor.chips, creditor.chips);

    netSettlements.push({ fromPlayerId: debtor.id, toPlayerId: creditor.id, chips });
    debtor.chips -= chips;
    creditor.chips -= chips;

    if (debtor.chips === 0) debtorIndex += 1;
    if (creditor.chips === 0) creditorIndex += 1;
  }

  return netSettlements;
}

export function standPlayer(state: TableState, playerId: string): TableState {
  const folded = foldPlayer(state, playerId);
  const nextState = cloneState(folded);
  const player = nextState.players.find((currentPlayer) => currentPlayer.id === playerId);

  if (!player) {
    return folded;
  }

  player.status = "standing";
  return appendLog(nextState, `${player.name} stood up from the table.`, "warn");
}

export function startNextHand(state: TableState, seed = Date.now()) {
  void seed;
  const nextDealer = nextSeatIndex(state.players, state.dealerIndex);

  return prepareNewHand({
    roomCode: state.roomCode,
    userId: state.userId,
    players: state.players.map((player) => ({
      ...player,
      hand: [],
      declinesUsed: 0,
      status: player.status === "standing" ? "standing" : "active",
    })),
    dealerIndex: nextDealer,
    handNumber: state.handNumber + 1,
    carryOverPot: state.carryOverPot,
    transferLedger: state.transferLedger,
  });
}

export function runBotTurn(state: TableState): TableState {
  if (state.phase !== "playing") {
    return state;
  }

  const bot = getCurrentPlayer(state);

  if (!bot?.isBot || bot.status !== "active") {
    return state;
  }

  const livePlayers = getActivePlayers(state);

  if (livePlayers.length === 2 && state.actionCount >= 5 && state.actionCount % 3 === 0) {
    return requestBackShow(state, bot.id);
  }

  if (livePlayers.length > 2 && state.actionCount >= 3 && state.actionCount % 5 === 2) {
    return requestBackShow(state, bot.id);
  }

  return playChaal(state, bot.id);
}

function declineBackShow(state: TableState, defenderIndex: number) {
  const nextState = cloneState(state);
  const defender = nextState.players[defenderIndex];
  const liveCount = getActivePlayers(nextState).length;
  const costList =
    liveCount === 2 ? AFLATOON_RULES.headsUpDeclineCosts : AFLATOON_RULES.normalDeclineCosts;
  const cost = costList[Math.min(defender.declinesUsed, costList.length - 1)];

  if (defender.declinesUsed >= AFLATOON_RULES.declinesPerHand) {
    return acceptBackShow(state, defenderIndex);
  }

  defender.declinesUsed += 1;
  nextState.pot += chargePlayer(defender, cost);
  nextState.actionCount += 1;

  if (liveCount === 2) {
    flipNextCenter(nextState);
    // In heads-up play, a declined show costs the defender but keeps the
    // requester on turn for the newly revealed centre card.
  } else {
    nextState.turnIndex = nextActiveIndex(nextState.players, nextState.turnIndex);
  }

  return appendLog(
    nextState,
    `${defender.name} declined back show for ${cost} chips.`,
    "warn",
  );
}

function acceptBackShow(state: TableState, defenderIndex: number) {
  const requester = state.players[state.turnIndex];
  const defender = state.players[defenderIndex];
  const center = describeCenterCard(getActiveCenter(state));
  const resolution = resolveShowComparison({
    requesterId: requester.id,
    defenderId: defender.id,
    requesterCards: requester.hand,
    defenderCards: defender.hand,
    mode: center.mode,
    jokerRanks: center.jokerRanks,
  });
  const nextState = cloneState(state);
  nextState.lastShow = resolution;
  nextState.actionCount += 1;

  if (resolution.outcome === "split") {
    nextState.turnIndex = nextActiveIndex(nextState.players, nextState.turnIndex);
    return appendLog(nextState, `Back show split: ${resolution.reason}.`, "good");
  }

  const loserId = resolution.loserId;
  const loserIndex = nextState.players.findIndex((player) => player.id === loserId);

  if (loserIndex >= 0) {
    nextState.players[loserIndex].status = "eliminated";
  }

  const livePlayers = getActivePlayers(nextState);
  const withLog = appendLog(
    nextState,
    `${nextState.players.find((player) => player.id === resolution.winnerId)?.name} won the back show.`,
    "good",
  );

  if (livePlayers.length === 1) {
    return awardPot(withLog, [livePlayers[0].id], "Back show ended the hand.");
  }

  withLog.turnIndex = nextActiveIndex(withLog.players, state.turnIndex);
  return withLog;
}

function awardPot(state: TableState, winnerIds: string[], reason: string): TableState {
  const nextState = cloneState(state);
  const share = Math.floor(nextState.pot / winnerIds.length);
  const carryOverPot = nextState.pot % winnerIds.length;

  for (const winnerId of winnerIds) {
    const winner = nextState.players.find((player) => player.id === winnerId);

    if (winner) {
      winner.chips += share;
      winner.status = "active";
    }
  }

  nextState.phase = "hand-complete";
  nextState.carryOverPot = carryOverPot;
  nextState.pot = 0;
  nextState.revealedPlayerIds = nextState.players.map((player) => player.id);

  const names = winnerIds
    .map((winnerId) => nextState.players.find((player) => player.id === winnerId)?.name)
    .filter(Boolean)
    .join(" and ");

  return appendLog(
    nextState,
    `${names} won ${share} chips each. ${reason}`,
    carryOverPot > 0 ? "warn" : "good",
  );
}

function flipNextCenter(state: TableState) {
  if (state.deck.length === 0) {
    state.deck = shuffleDeck(createDeck(), Date.now() + state.actionCount);
  }

  const nextCard = state.deck[0];
  state.centerHistory = [...state.centerHistory, nextCard];
  state.deck = state.deck.slice(1);
}

function isPlayersTurn(state: TableState, playerId: string) {
  const currentPlayer = getCurrentPlayer(state);

  return (
    state.phase === "playing" &&
    currentPlayer?.id === playerId &&
    currentPlayer.status === "active"
  );
}

function chargePlayer(player: TablePlayer, chips: number) {
  const paid = Math.min(player.chips, chips);
  const short = chips - paid;
  player.chips -= paid;
  player.shortChips += short;
  return chips;
}

function cloneState(state: TableState): TableState {
  return {
    ...state,
    deck: [...state.deck],
    centerHistory: [...state.centerHistory],
    players: state.players.map((player) => ({
      ...player,
      hand: [...player.hand],
    })),
    revealedPlayerIds: [...state.revealedPlayerIds],
    log: [...state.log],
    lastShow: state.lastShow ? { ...state.lastShow } : undefined,
    pendingShow: state.pendingShow ? { ...state.pendingShow } : undefined,
    privateReveal: state.privateReveal
      ? { ...state.privateReveal, playerIds: [...state.privateReveal.playerIds], viewerIds: [...state.privateReveal.viewerIds] }
      : undefined,
    pendingBootPlayerIds: [...(state.pendingBootPlayerIds ?? [])],
    pendingBuyInRequests: state.pendingBuyInRequests?.map((request) => ({ ...request })),
    pendingTransferRequests: state.pendingTransferRequests?.map((request) => ({ ...request })),
    transferLedger: state.transferLedger?.map((entry) => ({ ...entry })),
    poker: state.poker
      ? {
          ...state.poker,
          communityCards: state.poker.communityCards.map((card) => ({ ...card })),
          burnCards: state.poker.burnCards.map((card) => ({ ...card })),
          deck: state.poker.deck.map((card) => ({ ...card })),
          players: state.poker.players.map((player) => ({
            ...player,
            holeCards: player.holeCards.map((card) => ({ ...card })),
          })),
          pots: state.poker.pots.map((pot) => ({
            ...pot,
            contributorPlayerIds: [...pot.contributorPlayerIds],
            eligiblePlayerIds: [...pot.eligiblePlayerIds],
          })),
          events: [...state.poker.events],
          winners: state.poker.winners?.map((winner) => ({
            ...winner,
            bestCards: winner.bestCards?.map((card) => ({ ...card })),
          })),
        }
      : undefined,
    flipping: state.flipping
      ? {
          ...state.flipping,
          activeJokerCards: state.flipping.activeJokerCards.map((card) => ({ ...card })),
          activeJokerRanks: [...state.flipping.activeJokerRanks],
          inactiveJokerSets: state.flipping.inactiveJokerSets.map((set) => ({
            source: { ...set.source },
            cards: set.cards.map((card) => ({ ...card })),
          })),
          players: state.flipping.players.map((player) => ({
            ...player,
            cards: player.cards.map((card) => ({ ...card })),
            publicCards: player.publicCards.map((card) => ({ ...card })),
          })),
          actionLog: [...state.flipping.actionLog],
        }
      : undefined,
  };
}

function appendLog(state: TableState, text: string, tone: LogTone): TableState {
  return {
    ...state,
    log: [makeLog(text, tone), ...state.log].slice(0, 10),
  };
}

function makeLog(text: string, tone: LogTone): ActionLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    tone,
  };
}

function reveal(existing: string[], ...playerIds: string[]) {
  return [...new Set([...existing, ...playerIds])];
}

function nextActiveIndex(players: TablePlayer[], fromIndex: number) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const index = (fromIndex + offset) % players.length;

    if (players[index].status === "active") {
      return index;
    }
  }

  return fromIndex;
}

function previousActiveIndex(players: TablePlayer[], fromIndex: number) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const index = (fromIndex - offset + players.length) % players.length;

    if (players[index].status === "active") {
      return index;
    }
  }

  return fromIndex;
}

function nextSeatIndex(players: TablePlayer[], fromIndex: number) {
  return (fromIndex + 1) % players.length;
}

function clampSeatIndex(index: number, players: TablePlayer[]) {
  return ((index % players.length) + players.length) % players.length;
}

function seededRandom(seed: number) {
  let value = Math.abs(Math.floor(seed)) % 2147483647;

  if (value === 0) {
    value = 1;
  }

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}
