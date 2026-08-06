import {
  AFLATOON_RULES,
  RANKS,
  SUITS,
  describeCenterCard,
  getOpeningCenterAdvance,
  resolveShowComparison,
} from "./aflatoon.ts";
import type { Card, ShowResolution } from "./aflatoon.ts";

export type TablePhase = "playing" | "hand-complete";
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

export interface TableState {
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

  return dealNewHand({
    roomCode: input.roomCode,
    userId: input.userId,
    players,
    dealerIndex: Math.abs(input.seed ?? 0) % players.length,
    handNumber: 1,
    carryOverPot: 0,
    seed: input.seed,
    startAt: input.startAt,
    openingLog: `Room ${input.roomCode} started with ${players.length} players.`,
  });
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

  for (const player of players) {
    if (player.status === "active") {
      pot += chargePlayer(player, AFLATOON_RULES.bootChips);
    }
  }

  pot += chargePlayer(players[openerIndex], AFLATOON_RULES.openingChaalChips);

  const firstTurnIndex = nextActiveIndex(players, openerIndex);
  const activeCenter = centerHistory[centerHistory.length - 1];
  const center = describeCenterCard(activeCenter);

  return {
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
    revealedPlayerIds: [input.userId],
    actionCount: 0,
    log: [
      makeLog(input.openingLog ?? `Hand ${input.handNumber} dealt.`, "good"),
      makeLog(
        `Opening centre advanced ${centerAdvance} cards. ${activeCenter.rank} opened: ${center.mode}, jokers ${center.jokerRanks.join(", ")}.`,
        "neutral",
      ),
      makeLog(
        `${players[openerIndex].name} paid the compulsory ${AFLATOON_RULES.openingChaalChips}-chip opening chaal.`,
        "neutral",
      ),
    ],
    startAt: input.startAt,
  };
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
  const defenderIndex =
    livePlayers.length === 2
      ? state.players.findIndex(
          (player) => player.status === "active" && player.id !== requester.id,
        )
      : previousActiveIndex(state.players, state.turnIndex);

  if (defenderIndex < 0) {
    return appendLog(state, "No defender found for show.", "warn");
  }

  if (response === "decline") {
    return declineBackShow(state, defenderIndex);
  }

  return acceptBackShow(state, defenderIndex);
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

  return appendLog(
    nextState,
    `${giver.name} transferred ${approved} of ${requestedChips} requested chips to ${receiver.name}.`,
    "good",
  );
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
  const nextDealer = nextSeatIndex(state.players, state.dealerIndex);

  return dealNewHand({
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
    seed,
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
  nextState.revealedPlayerIds = reveal(
    nextState.revealedPlayerIds,
    requester.id,
    defender.id,
  );
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
      winner.shortChips = 0;
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
