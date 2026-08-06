import {
  RANKS,
  SUITS,
  evaluateHand,
  formatCard,
  rupeesForChips,
} from "./aflatoon.ts";
import type { Card, EvaluatedHand, HandCategory, Rank } from "./aflatoon.ts";
import type {
  CreateGameInput,
  GameRulesEngine,
  LegalActionSet,
  StateTransition,
  ValidationResult,
  SettlementResult,
} from "./game-rules.ts";

export const FLIPPING_RULES = {
  minPlayers: 3,
  maxPlayers: 7,
  startingBlindEquivalent: 1,
  minBlindEquivalent: 1,
  maxBlindEquivalent: 5,
  chipValueRupees: 50,
} as const;

export type FlippingMode = "CLASSIC_FLIPPING" | "FLIPPING_MOFLESS";
export type FlippingVisibility = "BLIND" | "SEEN";
export type FlippingPlayerStatus = "ACTIVE" | "PACKED" | "DISCONNECTED" | "WINNER";
export type FlippingPhase = "BETTING" | "SHOW_RESOLUTION" | "SETTLEMENT" | "COMPLETE";

export type FlippingAction =
  | { type: "SEE_CARDS" }
  | { type: "PLACE_CHAAL"; amount: number }
  | { type: "PACK" }
  | { type: "REQUEST_SHOW"; targetPlayerId?: string }
  | { type: "REQUEST_PACK_SHOW"; targetPlayerId?: string };

export type FlippingPlayerState = {
  playerId: string;
  name: string;
  seatIndex: number;
  cards: Card[];
  publicCards: Card[];
  visibility: FlippingVisibility;
  status: FlippingPlayerStatus;
  stack: number;
  currentRoundContribution: number;
  totalHandContribution: number;
  lastAction: string | null;
};

export type FlippingJokerSource =
  | { type: "INITIAL_DEAL" }
  | { type: "PACKED_PLAYER"; playerId: string };

export type FlippingShowResult = {
  type: "SHOW" | "PACK_SHOW";
  mode: FlippingMode;
  requesterId: string;
  defenderId: string;
  winnerIds: string[];
  loserId?: string;
  requester: FlippingEvaluation;
  defender: FlippingEvaluation;
  explanation: string;
};

export type FlippingState = {
  mode: FlippingMode;
  handId: string;
  players: FlippingPlayerState[];
  currentActorPlayerId: string;
  currentBlindEquivalent: number;
  activeJokerCards: Card[];
  activeJokerRanks: Rank[];
  inactiveJokerSets: Array<{ cards: Card[]; source: FlippingJokerSource }>;
  jokerSource: FlippingJokerSource;
  jokerReplacementNumber: number;
  jokersLocked: boolean;
  phase: FlippingPhase;
  pot: number;
  stateVersion: number;
  actionLog: string[];
  lastShow?: FlippingShowResult;
};

export type MoflessCategory =
  | "high-card-low"
  | "pair-low"
  | "colour-low"
  | "sequence-low"
  | "pure-sequence-low"
  | "trail-low";

export type FlippingEvaluation = {
  category: HandCategory | MoflessCategory;
  displayName: string;
  effectiveCards: Card[];
  jokerCount: number;
  comparisonTuple: number[];
};

const HIGH_CATEGORY_LABELS: Record<HandCategory, string> = {
  "high-card": "High card",
  pair: "Pair",
  colour: "Colour",
  sequence: "Sequence",
  "pure-sequence": "Pure sequence",
  trail: "Trail",
};

const MOFLESS_LABELS: Record<MoflessCategory, string> = {
  "high-card-low": "Low high-card",
  "pair-low": "Low pair",
  "colour-low": "Low colour",
  "sequence-low": "Low sequence",
  "pure-sequence-low": "Low pure sequence",
  "trail-low": "Low trail",
};

const MOFLESS_CATEGORY_STRENGTH: Record<MoflessCategory, number> = {
  "high-card-low": 1,
  "pair-low": 2,
  "colour-low": 3,
  "sequence-low": 4,
  "pure-sequence-low": 5,
  "trail-low": 6,
};

const MOFLESS_RANK_VALUE: Record<Rank, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
};

const LOW_SEQUENCE_STRENGTH = new Map<string, number>([
  ["A-2-3", 1],
  ["2-3-4", 2],
  ["3-4-5", 3],
  ["4-5-6", 4],
  ["5-6-7", 5],
  ["6-7-8", 6],
  ["7-8-9", 7],
  ["8-9-10", 8],
  ["9-10-J", 9],
  ["10-J-Q", 10],
  ["J-Q-K", 11],
  ["Q-K-A", 12],
]);

export function createFlippingDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shuffleFlippingDeck(deck: Card[], seed = Date.now()) {
  const random = seededRandom(seed);
  const shuffled = [...deck];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

export function evaluateClassicFlippingHand(cards: Card[], jokerRanks: Rank[]): FlippingEvaluation {
  const high = evaluateHand(cards, { mode: "normal", jokerRanks });
  return fromHighEvaluation(high);
}

export function evaluateMoflessHand(cards: Card[], jokerRanks: Rank[]): FlippingEvaluation {
  const fixedCards = cards.filter((card) => !jokerRanks.includes(card.rank));
  const jokerCount = cards.length - fixedCards.length;
  let best: FlippingEvaluation | undefined;

  for (const replacements of generateReplacementHands(jokerCount)) {
    const candidate = [...fixedCards, ...replacements];
    const evaluation = evaluateMoflessConcrete(candidate, jokerCount);

    if (!best || compareMoflessEvaluations(evaluation, best) < 0) {
      best = evaluation;
    }
  }

  if (!best) {
    throw new Error("Could not evaluate Mofless hand.");
  }

  return best;
}

export function compareFlippingEvaluations(
  mode: FlippingMode,
  left: FlippingEvaluation,
  right: FlippingEvaluation,
) {
  if (mode === "FLIPPING_MOFLESS") {
    return -compareMoflessEvaluations(left, right);
  }

  return compareTuple(left.comparisonTuple, right.comparisonTuple);
}

export class ClassicFlippingRulesEngine
  implements GameRulesEngine<FlippingState, FlippingAction>
{
  createInitialState(input: CreateGameInput): FlippingState {
    return createInitialFlippingState("CLASSIC_FLIPPING", input);
  }

  getLegalActions(state: FlippingState, playerId: string): LegalActionSet {
    return getFlippingLegalActions(state, playerId);
  }

  validateAction(state: FlippingState, playerId: string, action: FlippingAction): ValidationResult {
    return validateFlippingAction(state, playerId, action);
  }

  applyAction(state: FlippingState, playerId: string, action: FlippingAction): StateTransition<FlippingState> {
    return applyFlippingAction(state, playerId, action);
  }

  isRoundComplete(state: FlippingState): boolean {
    return activeFlippingPlayers(state).length <= 1;
  }

  isHandComplete(state: FlippingState): boolean {
    return state.phase === "COMPLETE";
  }

  settleHand(state: FlippingState): SettlementResult {
    const winners = activeFlippingPlayers(state);
    return {
      winners: winners.map((player) => ({
        playerId: player.playerId,
        chips: Math.floor(state.pot / Math.max(1, winners.length)),
        reason: "Active Flipping winner",
      })),
      events: [],
    };
  }
}

export class FlippingMoflessRulesEngine extends ClassicFlippingRulesEngine {
  createInitialState(input: CreateGameInput): FlippingState {
    return createInitialFlippingState("FLIPPING_MOFLESS", input);
  }
}

export const classicFlippingRulesEngine = new ClassicFlippingRulesEngine();
export const flippingMoflessRulesEngine = new FlippingMoflessRulesEngine();

export function sanitizeFlippingForPublic(state: FlippingState): FlippingState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      cards: [],
      publicCards: player.status === "PACKED" || player.status === "WINNER" ? player.publicCards : [],
    })),
  };
}

export function flippingPrivateView(state: FlippingState, playerId: string) {
  const player = state.players.find((candidate) => candidate.playerId === playerId);
  return {
    cards: player?.cards ?? [],
    evaluation:
      player?.cards.length === 3
        ? evaluateFlippingHand(state.mode, player.cards, state.activeJokerRanks)
        : null,
  };
}

function createInitialFlippingState(mode: FlippingMode, input: CreateGameInput): FlippingState {
  if (
    input.players.length < FLIPPING_RULES.minPlayers ||
    input.players.length > FLIPPING_RULES.maxPlayers
  ) {
    throw new RangeError("Flipping requires 3 to 7 players.");
  }

  let deck = shuffleFlippingDeck(createFlippingDeck(), input.seed ?? Date.now());
  const players = input.players.map<FlippingPlayerState>((player, index) => {
    const cards = deck.slice(index * 3, index * 3 + 3);

    return {
      playerId: player.id,
      name: player.name,
      seatIndex: index,
      cards,
      publicCards: [],
      visibility: "BLIND",
      status: "ACTIVE",
      stack: player.chips,
      currentRoundContribution: 0,
      totalHandContribution: 0,
      lastAction: null,
    };
  });

  deck = deck.slice(players.length * 3);
  const activeJokerCards = deck.slice(0, 3);
  const activeJokerRanks = uniqueRanks(activeJokerCards);
  const dealerIndex = input.dealerIndex ?? 0;
  const opener = players[nextActiveIndex(players, dealerIndex)];

  return {
    mode,
    handId: `flip-${input.seed ?? Date.now()}`,
    players,
    currentActorPlayerId: opener.playerId,
    currentBlindEquivalent: FLIPPING_RULES.startingBlindEquivalent,
    activeJokerCards,
    activeJokerRanks,
    inactiveJokerSets: [],
    jokerSource: { type: "INITIAL_DEAL" },
    jokerReplacementNumber: 0,
    jokersLocked: false,
    phase: "BETTING",
    pot: 0,
    stateVersion: 0,
    actionLog: [
      `${mode === "CLASSIC_FLIPPING" ? "Classic Flipping" : "Flipping Mofless"} started.`,
      `Active jokers: ${activeJokerCards.map(formatCard).join(" ")}`,
    ],
  };
}

function getFlippingLegalActions(state: FlippingState, playerId: string): LegalActionSet {
  const player = state.players.find((candidate) => candidate.playerId === playerId);

  if (!player || player.status !== "ACTIVE" || state.phase !== "BETTING") {
    return { canAct: false, actions: [] };
  }

  const actions = [];

  if (player.visibility === "BLIND" && player.cards.length === 3) {
    actions.push({ type: "SEE_CARDS" });
  }

  if (state.currentActorPlayerId !== playerId) {
    return { canAct: false, actions };
  }

  const minEquivalent = state.currentBlindEquivalent;
  const maxEquivalent = Math.min(FLIPPING_RULES.maxBlindEquivalent, Math.max(0, player.stack));
  const minAmount = amountForVisibility(player.visibility, minEquivalent);
  const maxAmount = amountForVisibility(player.visibility, maxEquivalent);

  actions.push({
    type: "PLACE_CHAAL",
    minimumAmount: minAmount,
    maximumAmount: maxAmount,
  });
  actions.push({ type: "PACK" });

  const activeCount = activeFlippingPlayers(state).length;

  if (activeCount === 2) {
    actions.push({ type: "REQUEST_SHOW" });
  } else if (activeCount > 2) {
    actions.push({ type: "REQUEST_PACK_SHOW" });
  }

  return { canAct: true, actions };
}

function validateFlippingAction(
  state: FlippingState,
  playerId: string,
  action: FlippingAction,
): ValidationResult {
  const player = state.players.find((candidate) => candidate.playerId === playerId);

  if (!player || player.status !== "ACTIVE") {
    return { ok: false, code: "PLAYER_NOT_SEATED", message: "Player is not active." };
  }

  if (action.type === "SEE_CARDS") {
    return player.visibility === "BLIND"
      ? { ok: true }
      : { ok: false, code: "ILLEGAL_ACTION", message: "Cards are already seen." };
  }

  if (state.phase !== "BETTING") {
    return { ok: false, code: "GAME_NOT_READY", message: "Hand is not betting." };
  }

  if (state.currentActorPlayerId !== playerId) {
    return { ok: false, code: "NOT_YOUR_TURN", message: "Not your turn." };
  }

  if (action.type === "PLACE_CHAAL") {
    const equivalent = equivalentForAmount(player.visibility, action.amount);
    const legal =
      Number.isInteger(action.amount) &&
      equivalent >= state.currentBlindEquivalent &&
      equivalent <= FLIPPING_RULES.maxBlindEquivalent &&
      action.amount <= player.stack;

    return legal
      ? { ok: true }
      : { ok: false, code: "INVALID_BET_AMOUNT", message: "Invalid Flipping chaal amount." };
  }

  if (action.type === "REQUEST_SHOW" && activeFlippingPlayers(state).length !== 2) {
    return { ok: false, code: "ILLEGAL_ACTION", message: "Show is only legal with two active players." };
  }

  if (action.type === "REQUEST_PACK_SHOW" && activeFlippingPlayers(state).length <= 2) {
    return { ok: false, code: "ILLEGAL_ACTION", message: "Pack Show requires more than two active players." };
  }

  return { ok: true };
}

function applyFlippingAction(
  state: FlippingState,
  playerId: string,
  action: FlippingAction,
): StateTransition<FlippingState> {
  const validation = validateFlippingAction(state, playerId, action);

  if (!validation.ok) {
    throw new Error(validation.message);
  }

  let next = cloneFlippingState(state);
  const player = findFlippingPlayer(next, playerId);

  if (action.type === "SEE_CARDS") {
    player.visibility = "SEEN";
    player.lastAction = "Saw cards";
    next.actionLog.unshift(`${player.name} saw their cards.`);
    return completeTransition(next);
  }

  if (action.type === "PLACE_CHAAL") {
    const equivalent = equivalentForAmount(player.visibility, action.amount);
    player.stack -= action.amount;
    player.currentRoundContribution += action.amount;
    player.totalHandContribution += action.amount;
    player.lastAction = player.visibility === "BLIND" ? "Blind chaal" : "Seen chaal";
    next.pot += action.amount;
    next.currentBlindEquivalent = equivalent;
    next.actionLog.unshift(`${player.name} played ${action.amount} chips.`);
    next.currentActorPlayerId = nextActorAfter(next, playerId);
    return completeTransition(next);
  }

  if (action.type === "PACK") {
    next = packFlippingPlayer(next, playerId);
    return completeTransition(next);
  }

  if (action.type === "REQUEST_SHOW") {
    const defender = activeFlippingPlayers(next).find((candidate) => candidate.playerId !== playerId);

    if (!defender) {
      throw new Error("No defender for Show.");
    }

    next = resolveFlippingShow(next, playerId, defender.playerId, "SHOW");
    return completeTransition(next);
  }

  const defenderId = action.targetPlayerId ?? previousActivePlayerId(next, playerId);
  next = resolveFlippingShow(next, playerId, defenderId, "PACK_SHOW");
  return completeTransition(next);
}

function completeTransition(state: FlippingState): StateTransition<FlippingState> {
  const next = {
    ...state,
    stateVersion: state.stateVersion + 1,
  };

  return {
    state: next,
    events: [],
  };
}

function resolveFlippingShow(
  state: FlippingState,
  requesterId: string,
  defenderId: string,
  type: "SHOW" | "PACK_SHOW",
) {
  const next = cloneFlippingState(state);
  const requester = findFlippingPlayer(next, requesterId);
  const defender = findFlippingPlayer(next, defenderId);
  const requesterEval = evaluateFlippingHand(next.mode, requester.cards, next.activeJokerRanks);
  const defenderEval = evaluateFlippingHand(next.mode, defender.cards, next.activeJokerRanks);
  const comparison = compareFlippingEvaluations(next.mode, requesterEval, defenderEval);
  const requesterWins = comparison > 0;
  const isTie = comparison === 0;
  const winnerIds = isTie ? [requesterId, defenderId] : [requesterWins ? requesterId : defenderId];
  const loserId = isTie ? requesterId : requesterWins ? defenderId : requesterId;

  next.lastShow = {
    type,
    mode: next.mode,
    requesterId,
    defenderId,
    winnerIds,
    loserId: type === "PACK_SHOW" ? loserId : isTie ? undefined : loserId,
    requester: requesterEval,
    defender: defenderEval,
    explanation: makeShowExplanation(next.mode, requester, defender, requesterEval, defenderEval, winnerIds),
  };

  if (type === "PACK_SHOW") {
    return packFlippingPlayer(next, loserId, "Pack Show");
  }

  requester.publicCards = [...requester.cards];
  defender.publicCards = [...defender.cards];
  return awardFlippingPot(next, winnerIds, "Show resolved.");
}

function packFlippingPlayer(state: FlippingState, playerId: string, reason = "Packed") {
  const next = cloneFlippingState(state);
  const player = findFlippingPlayer(next, playerId);
  const activeBefore = activeFlippingPlayers(next).length;

  player.status = "PACKED";
  player.publicCards = [...player.cards];
  player.lastAction = reason;
  next.actionLog.unshift(`${player.name} packed.`);

  const activeAfter = activeFlippingPlayers(next);

  if (!next.jokersLocked && activeBefore > 2) {
    next.inactiveJokerSets.unshift({ cards: next.activeJokerCards, source: next.jokerSource });
    next.activeJokerCards = [...player.cards];
    next.activeJokerRanks = uniqueRanks(player.cards);
    next.jokerSource = { type: "PACKED_PLAYER", playerId };
    next.jokerReplacementNumber += 1;
    next.actionLog.unshift(`${player.name}'s cards became the active Jokers.`);

    if (activeAfter.length === 2) {
      next.jokersLocked = true;
      next.actionLog.unshift("Jokers locked for the final two players.");
    }
  }

  if (activeAfter.length <= 1) {
    return awardFlippingPot(next, activeAfter.map((candidate) => candidate.playerId), "Last active player wins.");
  }

  next.currentActorPlayerId = nextActorAfter(next, playerId);
  return next;
}

function awardFlippingPot(state: FlippingState, winnerIds: string[], reason: string) {
  const next = cloneFlippingState(state);
  const winners = winnerIds.length ? winnerIds : activeFlippingPlayers(next).map((player) => player.playerId);
  const share = Math.floor(next.pot / winners.length);
  let remainder = next.pot % winners.length;

  for (const winnerId of winners) {
    const winner = findFlippingPlayer(next, winnerId);
    winner.stack += share + (remainder > 0 ? 1 : 0);
    winner.status = "WINNER";
    remainder -= remainder > 0 ? 1 : 0;
  }

  next.pot = 0;
  next.phase = "COMPLETE";
  next.currentActorPlayerId = "";
  next.actionLog.unshift(reason);
  return next;
}

function evaluateFlippingHand(mode: FlippingMode, cards: Card[], jokerRanks: Rank[]) {
  return mode === "FLIPPING_MOFLESS"
    ? evaluateMoflessHand(cards, jokerRanks)
    : evaluateClassicFlippingHand(cards, jokerRanks);
}

function fromHighEvaluation(evaluation: EvaluatedHand): FlippingEvaluation {
  return {
    category: evaluation.category,
    displayName: evaluation.label || HIGH_CATEGORY_LABELS[evaluation.category],
    effectiveCards: evaluation.bestCards,
    jokerCount: evaluation.jokerCount,
    comparisonTuple: [categoryStrength(evaluation.category), ...evaluation.tieBreakers],
  };
}

function evaluateMoflessConcrete(cards: Card[], jokerCount: number): FlippingEvaluation {
  const high = evaluateConcreteMoflessCategory(cards);
  return {
    ...high,
    jokerCount,
  };
}

function evaluateConcreteMoflessCategory(cards: Card[]): FlippingEvaluation {
  const ranks = cards.map((card) => card.rank);
  const rankCounts = countRanks(ranks);
  const counts = [...rankCounts.values()].sort((left, right) => right - left);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const sequenceStrength = lowSequenceStrength(ranks);
  let category: MoflessCategory;
  let tuple: number[];

  if (counts[0] === 3) {
    category = "trail-low";
    tuple = [MOFLESS_CATEGORY_STRENGTH[category], MOFLESS_RANK_VALUE[ranks[0]]];
  } else if (sequenceStrength && flush) {
    category = "pure-sequence-low";
    tuple = [MOFLESS_CATEGORY_STRENGTH[category], sequenceStrength];
  } else if (sequenceStrength) {
    category = "sequence-low";
    tuple = [MOFLESS_CATEGORY_STRENGTH[category], sequenceStrength];
  } else if (flush) {
    category = "colour-low";
    tuple = [MOFLESS_CATEGORY_STRENGTH[category], ...lowToHighRanks(ranks)];
  } else if (counts[0] === 2) {
    category = "pair-low";
    const pairRank = findRankByCount(rankCounts, 2);
    const kicker = findRankByCount(rankCounts, 1);
    tuple = [
      MOFLESS_CATEGORY_STRENGTH[category],
      MOFLESS_RANK_VALUE[pairRank],
      MOFLESS_RANK_VALUE[kicker],
    ];
  } else {
    category = "high-card-low";
    tuple = [MOFLESS_CATEGORY_STRENGTH[category], ...lowToHighRanks(ranks)];
  }

  return {
    category,
    displayName: MOFLESS_LABELS[category],
    effectiveCards: sortLowCards(cards),
    jokerCount: 0,
    comparisonTuple: tuple,
  };
}

function makeShowExplanation(
  mode: FlippingMode,
  requester: FlippingPlayerState,
  defender: FlippingPlayerState,
  requesterEval: FlippingEvaluation,
  defenderEval: FlippingEvaluation,
  winnerIds: string[],
) {
  if (winnerIds.length > 1) {
    return `Exact tie: ${requesterEval.displayName} versus ${defenderEval.displayName}.`;
  }

  const winnerName = winnerIds[0] === requester.playerId ? requester.name : defender.name;
  const modeText = mode === "FLIPPING_MOFLESS" ? "Lowest hand wins" : "Highest hand wins";
  return `${winnerName} wins. ${modeText}: ${requester.name} had ${requesterEval.displayName} (${requesterEval.effectiveCards.map(formatCard).join(" ")}), ${defender.name} had ${defenderEval.displayName} (${defenderEval.effectiveCards.map(formatCard).join(" ")}).`;
}

function compareMoflessEvaluations(left: FlippingEvaluation, right: FlippingEvaluation) {
  return compareTuple(left.comparisonTuple, right.comparisonTuple);
}

function compareTuple(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);

    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }

  return 0;
}

function categoryStrength(category: HandCategory) {
  switch (category) {
    case "trail":
      return 6;
    case "pure-sequence":
      return 5;
    case "sequence":
      return 4;
    case "colour":
      return 3;
    case "pair":
      return 2;
    case "high-card":
      return 1;
  }
}

function activeFlippingPlayers(state: FlippingState) {
  return state.players.filter((player) => player.status === "ACTIVE");
}

function amountForVisibility(visibility: FlippingVisibility, blindEquivalent: number) {
  return visibility === "SEEN" ? blindEquivalent * 2 : blindEquivalent;
}

function equivalentForAmount(visibility: FlippingVisibility, amount: number) {
  return visibility === "SEEN" ? amount / 2 : amount;
}

function uniqueRanks(cards: Card[]) {
  return [...new Set(cards.map((card) => card.rank))];
}

function nextActorAfter(state: FlippingState, playerId: string) {
  const index = state.players.findIndex((player) => player.playerId === playerId);
  return state.players[nextActiveIndex(state.players, index)].playerId;
}

function previousActivePlayerId(state: FlippingState, playerId: string) {
  const startIndex = state.players.findIndex((player) => player.playerId === playerId);

  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const index = (startIndex - offset + state.players.length) % state.players.length;
    const player = state.players[index];

    if (player.status === "ACTIVE") {
      return player.playerId;
    }
  }

  return playerId;
}

function nextActiveIndex(players: FlippingPlayerState[], startIndex: number) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const index = (startIndex + offset) % players.length;

    if (players[index].status === "ACTIVE") {
      return index;
    }
  }

  return startIndex;
}

function findFlippingPlayer(state: FlippingState, playerId: string) {
  const player = state.players.find((candidate) => candidate.playerId === playerId);

  if (!player) {
    throw new Error("Player not found.");
  }

  return player;
}

function cloneFlippingState(state: FlippingState): FlippingState {
  return {
    ...state,
    activeJokerCards: state.activeJokerCards.map((card) => ({ ...card })),
    activeJokerRanks: [...state.activeJokerRanks],
    inactiveJokerSets: state.inactiveJokerSets.map((set) => ({
      source: { ...set.source },
      cards: set.cards.map((card) => ({ ...card })),
    })),
    players: state.players.map((player) => ({
      ...player,
      cards: player.cards.map((card) => ({ ...card })),
      publicCards: player.publicCards.map((card) => ({ ...card })),
    })),
    actionLog: [...state.actionLog],
    lastShow: state.lastShow
      ? {
          ...state.lastShow,
          winnerIds: [...state.lastShow.winnerIds],
          requester: {
            ...state.lastShow.requester,
            effectiveCards: state.lastShow.requester.effectiveCards.map((card) => ({ ...card })),
            comparisonTuple: [...state.lastShow.requester.comparisonTuple],
          },
          defender: {
            ...state.lastShow.defender,
            effectiveCards: state.lastShow.defender.effectiveCards.map((card) => ({ ...card })),
            comparisonTuple: [...state.lastShow.defender.comparisonTuple],
          },
        }
      : undefined,
  };
}

function countRanks(ranks: Rank[]) {
  const rankCounts = new Map<Rank, number>();

  for (const rank of ranks) {
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
  }

  return rankCounts;
}

function findRankByCount(rankCounts: Map<Rank, number>, count: number) {
  for (const [rank, currentCount] of rankCounts.entries()) {
    if (currentCount === count) {
      return rank;
    }
  }

  throw new Error(`No rank found with count ${count}.`);
}

function lowSequenceStrength(ranks: Rank[]) {
  const uniqueRanks = new Set(ranks);

  if (uniqueRanks.size !== 3) {
    return undefined;
  }

  return LOW_SEQUENCE_STRENGTH.get(
    ranks
      .map((rank) => MOFLESS_RANK_VALUE[rank])
      .sort((left, right) => left - right)
      .map((value) => (value === 1 ? "A" : RANKS.find((rank) => MOFLESS_RANK_VALUE[rank] === value)))
      .join("-"),
  );
}

function lowToHighRanks(ranks: Rank[]) {
  return ranks.map((rank) => MOFLESS_RANK_VALUE[rank]).sort((left, right) => left - right);
}

function sortLowCards(cards: Card[]) {
  return [...cards].sort((left, right) => MOFLESS_RANK_VALUE[left.rank] - MOFLESS_RANK_VALUE[right.rank]);
}

function* generateReplacementHands(count: number): Generator<Card[]> {
  if (count === 0) {
    yield [];
    return;
  }

  for (const card of createFlippingDeck()) {
    for (const rest of generateReplacementHands(count - 1)) {
      yield [card, ...rest];
    }
  }
}

function seededRandom(seed: number) {
  let value = seed % 2147483647;

  if (value <= 0) {
    value += 2147483646;
  }

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

export function formatFlippingRupees(chips: number) {
  return `₹${rupeesForChips(chips).toLocaleString("en-IN")}`;
}
