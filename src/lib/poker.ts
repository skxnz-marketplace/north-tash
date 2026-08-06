import solver from "pokersolver";

import { RANKS, SUITS } from "./aflatoon.ts";
import type { Card } from "./aflatoon.ts";
import {
  createGameEvent,
  type CreateGameInput,
  type GameRulesEngine,
  type LegalAction,
  type LegalActionSet,
  type SettlementResult,
  type StateTransition,
  type ValidationResult,
} from "./game-rules.ts";

const { Hand } = solver;

export const TEXAS_HOLDEM_RULES = {
  minPlayers: 2,
  maxPlayers: 7,
  smallBlind: 1,
  bigBlind: 2,
  rupeesPerChip: 50,
  bettingStructure: "NO_LIMIT",
  burnCardsEnabled: true,
} as const;

export type PokerStreet =
  | "PRE_FLOP"
  | "FLOP"
  | "TURN"
  | "RIVER"
  | "SHOWDOWN"
  | "SETTLEMENT"
  | "COMPLETE";

export type PokerPlayerStatus =
  | "ACTIVE"
  | "FOLDED"
  | "ALL_IN"
  | "SITTING_OUT"
  | "DISCONNECTED"
  | "WINNER";

export type PokerActionType = "CHECK" | "CALL" | "BET" | "RAISE_TO" | "ALL_IN" | "FOLD";

export type PokerAction =
  | { type: "CHECK" }
  | { type: "CALL" }
  | { type: "BET"; amount: number }
  | { type: "RAISE_TO"; amount: number }
  | { type: "ALL_IN" }
  | { type: "FOLD" };

export type PokerPlayerState = {
  playerId: string;
  name: string;
  seatIndex: number;
  holeCards: Card[];
  status: PokerPlayerStatus;
  stack: number;
  currentStreetContribution: number;
  totalHandContribution: number;
  hasActedThisStreet: boolean;
  lastAction: PokerActionType | null;
};

export type PokerPot = {
  id: string;
  type: "MAIN" | "SIDE";
  amount: number;
  lowerContributionBoundary: number;
  upperContributionBoundary: number;
  contributorPlayerIds: string[];
  eligiblePlayerIds: string[];
};

export type TexasHoldemState = {
  mode: "TEXAS_HOLDEM";
  roomCode: string;
  handId: string;
  dealerPlayerId: string;
  smallBlindPlayerId: string;
  bigBlindPlayerId: string;
  currentActorPlayerId: string | null;
  street: PokerStreet;
  communityCards: Card[];
  burnCards: Card[];
  deck: Card[];
  currentHighestStreetContribution: number;
  lastFullRaiseSize: number;
  lastAggressorPlayerId: string | null;
  players: PokerPlayerState[];
  pots: PokerPot[];
  stateVersion: number;
  events: string[];
  winners?: Array<{
    playerId: string;
    chips: number;
    handLabel?: string;
    bestCards?: Card[];
    potId: string;
  }>;
};

export type PokerHandSummary = {
  label: string;
  bestCards: Card[];
};

const SUIT_CODES: Record<Card["suit"], string> = {
  spades: "s",
  hearts: "h",
  diamonds: "d",
  clubs: "c",
};

const SUIT_NAMES: Record<string, Card["suit"]> = {
  s: "spades",
  h: "hearts",
  d: "diamonds",
  c: "clubs",
};

function cardId(card: Card) {
  return `${card.rank}-${card.suit}`;
}

function cardCode(card: Card) {
  return `${card.rank === "10" ? "T" : card.rank}${SUIT_CODES[card.suit]}`;
}

function fromSolvedCard(card: { value: string; suit: string }): Card {
  return {
    rank: (card.value === "T" ? "10" : card.value) as Card["rank"],
    suit: SUIT_NAMES[card.suit] ?? "spades",
  };
}

export function createPokerDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shufflePokerDeck(deck: Card[], seed = Date.now()) {
  const shuffled = [...deck];
  const random = seededRandom(seed);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

export function assertUniqueCards(cards: Card[]) {
  const unique = new Set(cards.map(cardId));

  if (unique.size !== cards.length) {
    throw new Error("Deck contains duplicate cards.");
  }
}

export function describeHoldemHand(holeCards: Card[], board: Card[]): PokerHandSummary | null {
  const available = [...holeCards, ...board];

  if (available.length < 5) {
    return null;
  }

  const solved = Hand.solve(available.map(cardCode));

  return {
    label: solved.descr || solved.name,
    bestCards: solved.cards.map(fromSolvedCard),
  };
}

export function winningHoldemPlayerIds(
  players: Array<{ id: string; holeCards: Card[]; folded?: boolean }>,
  board: Card[],
) {
  const live = players.filter((player) => !player.folded && player.holeCards.length === 2);
  const solved = live.map((player) => ({
    id: player.id,
    hand: Hand.solve([...player.holeCards, ...board].map(cardCode)),
  }));
  const winners = new Set(Hand.winners(solved.map((entry) => entry.hand)));

  return solved.filter((entry) => winners.has(entry.hand)).map((entry) => entry.id);
}

export class TexasHoldemRulesEngine
  implements GameRulesEngine<TexasHoldemState, PokerAction>
{
  createInitialState(input: CreateGameInput): TexasHoldemState {
    if (
      input.players.length < TEXAS_HOLDEM_RULES.minPlayers ||
      input.players.length > TEXAS_HOLDEM_RULES.maxPlayers
    ) {
      throw new RangeError("Texas Hold'em needs 2 to 7 players.");
    }

    const deck = shufflePokerDeck(createPokerDeck(), input.seed);
    assertUniqueCards(deck);

    const dealerIndex = normalizeIndex(input.dealerIndex ?? 0, input.players.length);
    const headsUp = input.players.length === 2;
    const smallBlindIndex = headsUp ? dealerIndex : nextIndex(input.players, dealerIndex);
    const bigBlindIndex = headsUp ? nextIndex(input.players, dealerIndex) : nextIndex(input.players, smallBlindIndex);
    const firstActorIndex = headsUp ? smallBlindIndex : nextIndex(input.players, bigBlindIndex);
    const players = input.players.map<PokerPlayerState>((player, index) => ({
      playerId: player.id,
      name: player.name,
      seatIndex: index,
      holeCards: [],
      status: "ACTIVE",
      stack: player.chips,
      currentStreetContribution: 0,
      totalHandContribution: 0,
      hasActedThisStreet: false,
      lastAction: null,
    }));

    postForcedBlind(players[smallBlindIndex], TEXAS_HOLDEM_RULES.smallBlind);
    postForcedBlind(players[bigBlindIndex], TEXAS_HOLDEM_RULES.bigBlind);

    for (let round = 0; round < 2; round += 1) {
      for (const player of players) {
        const card = deck.shift();

        if (!card) {
          throw new Error("Deck exhausted during Poker deal.");
        }

        player.holeCards.push(card);
      }
    }

    return {
      mode: "TEXAS_HOLDEM",
      roomCode: input.roomCode,
      handId: input.handId ?? `holdem-${Date.now()}`,
      dealerPlayerId: players[dealerIndex].playerId,
      smallBlindPlayerId: players[smallBlindIndex].playerId,
      bigBlindPlayerId: players[bigBlindIndex].playerId,
      currentActorPlayerId: nextEligibleActorId(players, firstActorIndex),
      street: "PRE_FLOP",
      communityCards: [],
      burnCards: [],
      deck,
      currentHighestStreetContribution: Math.min(
        TEXAS_HOLDEM_RULES.bigBlind,
        input.players[bigBlindIndex].chips,
      ),
      lastFullRaiseSize: TEXAS_HOLDEM_RULES.bigBlind,
      lastAggressorPlayerId: players[bigBlindIndex].playerId,
      players,
      pots: buildPokerPots(players, dealerIndex),
      stateVersion: 0,
      events: [
        `Hand started. ${players[smallBlindIndex].name} posted small blind, ${players[bigBlindIndex].name} posted big blind.`,
      ],
    };
  }

  getLegalActions(state: TexasHoldemState, playerId: string): LegalActionSet {
    const player = findPlayer(state, playerId);
    const canAct =
      state.currentActorPlayerId === playerId &&
      state.street !== "COMPLETE" &&
      state.street !== "SETTLEMENT" &&
      state.street !== "SHOWDOWN" &&
      player?.status === "ACTIVE";

    if (!canAct || !player) {
      return { canAct: false, actions: [] };
    }

    const callAmount = Math.max(
      0,
      state.currentHighestStreetContribution - player.currentStreetContribution,
    );
    const actions: LegalAction[] = [{ type: "FOLD" }];

    if (callAmount === 0) {
      actions.push({ type: "CHECK" });
      if (player.stack > 0 && state.currentHighestStreetContribution === 0) {
        actions.push({
          type: "BET",
          minimumAmount: Math.min(TEXAS_HOLDEM_RULES.bigBlind, player.stack),
          maximumAmount: player.stack,
        });
      } else if (player.stack > 0) {
        const minimumRaiseTo = state.currentHighestStreetContribution + state.lastFullRaiseSize;
        const maximumRaiseTo = player.currentStreetContribution + player.stack;

        if (maximumRaiseTo >= minimumRaiseTo) {
          actions.push({
            type: "RAISE_TO",
            minimumRaiseTo,
            maximumRaiseTo,
          });
        }
      }
    } else {
      actions.push({
        type: "CALL",
        exactAmount: Math.min(callAmount, player.stack),
      });

      const minimumRaiseTo = state.currentHighestStreetContribution + state.lastFullRaiseSize;
      const maximumRaiseTo = player.currentStreetContribution + player.stack;

      if (maximumRaiseTo >= minimumRaiseTo) {
        actions.push({
          type: "RAISE_TO",
          minimumRaiseTo,
          maximumRaiseTo,
        });
      }
    }

    if (player.stack > 0) {
      actions.push({ type: "ALL_IN", exactAmount: player.stack });
    }

    return { canAct, actions };
  }

  validateAction(
    state: TexasHoldemState,
    playerId: string,
    action: PokerAction,
  ): ValidationResult {
    const legalActions = this.getLegalActions(state, playerId);

    if (!legalActions.canAct) {
      return { ok: false, code: "NOT_YOUR_TURN", message: "It is not this player's Poker turn." };
    }

    const legal = legalActions.actions.find((candidate) => candidate.type === action.type);

    if (!legal) {
      return { ok: false, code: "ILLEGAL_ACTION", message: `${action.type} is not legal now.` };
    }

    if (action.type === "BET") {
      if (!Number.isInteger(action.amount) || action.amount < (legal.minimumAmount ?? 0) || action.amount > (legal.maximumAmount ?? 0)) {
        return { ok: false, code: "INVALID_BET_AMOUNT", message: "Invalid Poker bet amount." };
      }
    }

    if (action.type === "RAISE_TO") {
      if (!Number.isInteger(action.amount) || action.amount < (legal.minimumRaiseTo ?? 0) || action.amount > (legal.maximumRaiseTo ?? 0)) {
        return { ok: false, code: "INVALID_BET_AMOUNT", message: "Invalid Poker raise amount." };
      }
    }

    return { ok: true };
  }

  applyAction(
    state: TexasHoldemState,
    playerId: string,
    action: PokerAction,
  ): StateTransition<TexasHoldemState> {
    const validation = this.validateAction(state, playerId, action);

    if (!validation.ok) {
      throw new Error(validation.message);
    }

    let next = clonePokerState(state);
    const player = findPlayer(next, playerId);
    const events = [];

    if (!player) {
      throw new Error("Poker player not found.");
    }

    if (action.type === "FOLD") {
      player.status = "FOLDED";
      player.hasActedThisStreet = true;
      player.lastAction = "FOLD";
      events.push(createGameEvent("FOLDED", `${player.name} folded.`, { playerId }));
    } else if (action.type === "CHECK") {
      player.hasActedThisStreet = true;
      player.lastAction = "CHECK";
      events.push(createGameEvent("CHECKED", `${player.name} checked.`, { playerId }));
    } else if (action.type === "CALL") {
      const amount = Math.min(
        player.stack,
        next.currentHighestStreetContribution - player.currentStreetContribution,
      );
      commitChips(player, amount);
      player.hasActedThisStreet = true;
      player.lastAction = "CALL";
      events.push(createGameEvent("CALLED", `${player.name} called ${amount}.`, { playerId, amount }));
    } else if (action.type === "BET") {
      commitChips(player, action.amount);
      next.currentHighestStreetContribution = player.currentStreetContribution;
      next.lastFullRaiseSize = action.amount;
      next.lastAggressorPlayerId = player.playerId;
      markOtherActivePlayersUnacted(next, player.playerId);
      player.hasActedThisStreet = true;
      player.lastAction = "BET";
      events.push(createGameEvent("BET_PLACED", `${player.name} bet ${action.amount}.`, { playerId, amount: action.amount }));
    } else if (action.type === "RAISE_TO") {
      const addAmount = action.amount - player.currentStreetContribution;
      const raiseSize = action.amount - next.currentHighestStreetContribution;
      commitChips(player, addAmount);
      if (raiseSize >= next.lastFullRaiseSize) {
        next.lastFullRaiseSize = raiseSize;
        markOtherActivePlayersUnacted(next, player.playerId);
      }
      next.currentHighestStreetContribution = Math.max(next.currentHighestStreetContribution, action.amount);
      next.lastAggressorPlayerId = player.playerId;
      player.hasActedThisStreet = true;
      player.lastAction = "RAISE_TO";
      events.push(createGameEvent("RAISED", `${player.name} raised to ${action.amount}.`, { playerId, amount: addAmount }));
    } else if (action.type === "ALL_IN") {
      const amount = player.stack;
      const previousHighest = next.currentHighestStreetContribution;
      commitChips(player, amount);
      if (player.currentStreetContribution > next.currentHighestStreetContribution) {
        const raiseSize = player.currentStreetContribution - previousHighest;
        next.currentHighestStreetContribution = player.currentStreetContribution;
        next.lastAggressorPlayerId = player.playerId;
        if (raiseSize >= next.lastFullRaiseSize) {
          next.lastFullRaiseSize = raiseSize;
          markOtherActivePlayersUnacted(next, player.playerId);
        }
      }
      player.status = "ALL_IN";
      player.hasActedThisStreet = true;
      player.lastAction = "ALL_IN";
      events.push(createGameEvent("ALL_IN", `${player.name} went all-in for ${amount}.`, { playerId, amount }));
    }

    next.pots = buildPokerPots(next.players, dealerIndexOf(next));
    next = advancePokerAfterAction(next);

    return {
      state: {
        ...next,
        stateVersion: state.stateVersion + 1,
        events: [...events.map((event) => event.message), ...next.events].slice(0, 14),
      },
      events,
    };
  }

  isRoundComplete(state: TexasHoldemState): boolean {
    return isBettingRoundComplete(state);
  }

  isHandComplete(state: TexasHoldemState): boolean {
    return state.street === "COMPLETE";
  }

  settleHand(state: TexasHoldemState): SettlementResult {
    const dealerIndex = dealerIndexOf(state);
    const pots = buildPokerPots(state.players, dealerIndex);
    const winners = [];
    const events = [];

    for (const pot of pots) {
      const eligible = state.players.filter((player) =>
        pot.eligiblePlayerIds.includes(player.playerId),
      );
      const solved = eligible.map((player) => ({
        player,
        hand: Hand.solve([...player.holeCards, ...state.communityCards].map(cardCode)),
      }));
      const winningHands = new Set(Hand.winners(solved.map((entry) => entry.hand)));
      const potWinners = solved.filter((entry) => winningHands.has(entry.hand));
      const ordered = orderFromDealerLeft(
        state.players,
        dealerIndex,
        potWinners.map((entry) => entry.player.playerId),
      );
      const share = Math.floor(pot.amount / potWinners.length);
      let remainder = pot.amount % potWinners.length;

      for (const winnerId of ordered) {
        const winner = state.players.find((player) => player.playerId === winnerId);
        const solvedWinner = solved.find((entry) => entry.player.playerId === winnerId);

        if (!winner || !solvedWinner) {
          continue;
        }

        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        winners.push({
          playerId: winner.playerId,
          chips: share + extra,
          reason: `${winner.name} wins ${pot.id} with ${solvedWinner.hand.descr || solvedWinner.hand.name}.`,
        });
        events.push(
          createGameEvent(
            "POT_AWARDED",
            `${winner.name} wins ${share + extra} from ${pot.id}.`,
            { playerId: winner.playerId, amount: share + extra },
          ),
        );
      }
    }

    return { winners, events };
  }
}

export const texasHoldemRulesEngine = new TexasHoldemRulesEngine();

export function buildPokerPots(players: PokerPlayerState[], dealerIndex = 0): PokerPot[] {
  const contributionLevels = [
    ...new Set(players.map((player) => player.totalHandContribution).filter((amount) => amount > 0)),
  ].sort((a, b) => a - b);
  const pots: PokerPot[] = [];
  let lower = 0;

  for (const upper of contributionLevels) {
    const contributors = players.filter((player) => player.totalHandContribution >= upper);
    const eligible = contributors.filter((player) => player.status !== "FOLDED");
    const amount = (upper - lower) * contributors.length;

    if (amount > 0 && contributors.length > 1 && eligible.length > 0) {
      pots.push({
        id: pots.length === 0 ? "main-pot" : `side-pot-${pots.length}`,
        type: pots.length === 0 ? "MAIN" : "SIDE",
        amount,
        lowerContributionBoundary: lower,
        upperContributionBoundary: upper,
        contributorPlayerIds: contributors.map((player) => player.playerId),
        eligiblePlayerIds: orderFromDealerLeft(players, dealerIndex, eligible.map((player) => player.playerId)),
      });
    }

    lower = upper;
  }

  return pots;
}

export function sanitizePokerForPublic(state: TexasHoldemState): TexasHoldemState {
  return {
    ...state,
    deck: [],
    burnCards: [],
    players: state.players.map((player) => ({ ...player, holeCards: [] })),
  };
}

export function pokerPrivateView(state: TexasHoldemState, playerId: string) {
  const player = findPlayer(state, playerId);

  return {
    playerId,
    holeCards: player?.holeCards ?? [],
    bestHand: player ? describeHoldemHand(player.holeCards, state.communityCards) : null,
  };
}

function advancePokerAfterAction(state: TexasHoldemState): TexasHoldemState {
  const live = state.players.filter((player) => player.status !== "FOLDED");

  if (live.length === 1) {
    const next = clonePokerState(state);
    const winner = live[0];
    const totalPot = next.players.reduce((sum, player) => sum + player.totalHandContribution, 0);
    winner.stack += totalPot;
    winner.status = "WINNER";
    next.street = "COMPLETE";
    next.currentActorPlayerId = null;
    next.pots = [];
    next.winners = [{ playerId: winner.playerId, chips: totalPot, potId: "main-pot" }];
    next.events = [`${winner.name} wins ${totalPot}; everyone else folded.`, ...next.events];
    return next;
  }

  if (!isBettingRoundComplete(state)) {
    return {
      ...state,
      currentActorPlayerId: nextEligibleActorIdAfter(state, state.currentActorPlayerId),
    };
  }

  return advanceStreet(state);
}

function advanceStreet(state: TexasHoldemState): TexasHoldemState {
  let next = clonePokerState(state);

  if (next.players.filter((player) => player.status === "ACTIVE").length <= 1) {
    while (next.street !== "RIVER" && next.street !== "COMPLETE") {
      next = dealNextStreet(next);
    }
    return settlePokerState(next);
  }

  if (next.street === "RIVER") {
    return settlePokerState(next);
  }

  next = dealNextStreet(next);
  next.currentHighestStreetContribution = 0;
  next.lastFullRaiseSize = TEXAS_HOLDEM_RULES.bigBlind;
  next.lastAggressorPlayerId = null;
  next.players = next.players.map((player) => ({
    ...player,
    currentStreetContribution: 0,
    hasActedThisStreet: player.status !== "ACTIVE",
  }));
  next.currentActorPlayerId = nextEligibleActorIdAfterDealer(next);
  return next;
}

function dealNextStreet(state: TexasHoldemState): TexasHoldemState {
  const next = clonePokerState(state);
  const burn = next.deck.shift();

  if (burn) {
    next.burnCards.push(burn);
  }

  if (next.street === "PRE_FLOP") {
    next.communityCards.push(...next.deck.splice(0, 3));
    next.street = "FLOP";
    next.events = ["Flop dealt.", ...next.events];
  } else if (next.street === "FLOP") {
    const turn = next.deck.shift();
    if (turn) {
      next.communityCards.push(turn);
    }
    next.street = "TURN";
    next.events = ["Turn dealt.", ...next.events];
  } else if (next.street === "TURN") {
    const river = next.deck.shift();
    if (river) {
      next.communityCards.push(river);
    }
    next.street = "RIVER";
    next.events = ["River dealt.", ...next.events];
  }

  return next;
}

function settlePokerState(state: TexasHoldemState): TexasHoldemState {
  const next = clonePokerState(state);
  const settlement = texasHoldemRulesEngine.settleHand(next);

  for (const win of settlement.winners) {
    const player = next.players.find((candidate) => candidate.playerId === win.playerId);

    if (player) {
      player.stack += win.chips;
      player.status = "WINNER";
    }
  }

  next.street = "COMPLETE";
  next.currentActorPlayerId = null;
  next.winners = settlement.winners.map((winner) => {
    const player = next.players.find((candidate) => candidate.playerId === winner.playerId);
    const summary = player ? describeHoldemHand(player.holeCards, next.communityCards) : null;

    return {
      playerId: winner.playerId,
      chips: winner.chips,
      handLabel: summary?.label,
      bestCards: summary?.bestCards,
      potId: "pot",
    };
  });
  next.events = [...settlement.events.map((event) => event.message), ...next.events];
  return next;
}

function isBettingRoundComplete(state: TexasHoldemState) {
  const active = state.players.filter((player) => player.status === "ACTIVE");

  if (active.length === 0) {
    return true;
  }

  return active.every(
    (player) =>
      player.hasActedThisStreet &&
      player.currentStreetContribution === state.currentHighestStreetContribution,
  );
}

function postForcedBlind(player: PokerPlayerState, amount: number) {
  commitChips(player, Math.min(player.stack, amount));
  if (player.stack === 0) {
    player.status = "ALL_IN";
  }
}

function commitChips(player: PokerPlayerState, amount: number) {
  const committed = Math.min(player.stack, Math.max(0, amount));
  player.stack -= committed;
  player.currentStreetContribution += committed;
  player.totalHandContribution += committed;
  if (player.stack === 0 && committed > 0) {
    player.status = "ALL_IN";
  }
  return committed;
}

function markOtherActivePlayersUnacted(state: TexasHoldemState, actorId: string) {
  state.players = state.players.map((player) =>
    player.playerId === actorId || player.status !== "ACTIVE"
      ? player
      : { ...player, hasActedThisStreet: false },
  );
}

function nextEligibleActorIdAfter(state: TexasHoldemState, actorId: string | null) {
  const fromIndex = Math.max(
    0,
    state.players.findIndex((player) => player.playerId === actorId),
  );

  return nextEligibleActorId(state.players, nextIndex(state.players, fromIndex));
}

function nextEligibleActorIdAfterDealer(state: TexasHoldemState) {
  const dealerIndex = dealerIndexOf(state);

  return nextEligibleActorId(state.players, nextIndex(state.players, dealerIndex));
}

function nextEligibleActorId(players: PokerPlayerState[], startIndex: number) {
  for (let offset = 0; offset < players.length; offset += 1) {
    const index = (startIndex + offset) % players.length;
    const player = players[index];

    if (player.status === "ACTIVE") {
      return player.playerId;
    }
  }

  return null;
}

function orderFromDealerLeft(players: PokerPlayerState[], dealerIndex: number, playerIds: string[]) {
  const idSet = new Set(playerIds);
  const ordered = [];

  for (let offset = 1; offset <= players.length; offset += 1) {
    const player = players[(dealerIndex + offset) % players.length];

    if (idSet.has(player.playerId)) {
      ordered.push(player.playerId);
    }
  }

  return ordered;
}

function dealerIndexOf(state: TexasHoldemState) {
  return Math.max(
    0,
    state.players.findIndex((player) => player.playerId === state.dealerPlayerId),
  );
}

function findPlayer(state: TexasHoldemState, playerId: string) {
  return state.players.find((player) => player.playerId === playerId);
}

function clonePokerState(state: TexasHoldemState): TexasHoldemState {
  return {
    ...state,
    communityCards: state.communityCards.map((card) => ({ ...card })),
    burnCards: state.burnCards.map((card) => ({ ...card })),
    deck: state.deck.map((card) => ({ ...card })),
    players: state.players.map((player) => ({
      ...player,
      holeCards: player.holeCards.map((card) => ({ ...card })),
    })),
    pots: state.pots.map((pot) => ({
      ...pot,
      contributorPlayerIds: [...pot.contributorPlayerIds],
      eligiblePlayerIds: [...pot.eligiblePlayerIds],
    })),
    events: [...state.events],
    winners: state.winners?.map((winner) => ({
      ...winner,
      bestCards: winner.bestCards?.map((card) => ({ ...card })),
    })),
  };
}

function nextIndex<T>(items: T[], fromIndex: number) {
  return (fromIndex + 1) % items.length;
}

function normalizeIndex(index: number, length: number) {
  return ((index % length) + length) % length;
}

function seededRandom(seed = Date.now()) {
  let value = Math.abs(Math.floor(seed)) % 2147483647;

  if (value === 0) {
    value = 1;
  }

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}
