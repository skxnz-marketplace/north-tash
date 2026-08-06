import type { Card } from "./aflatoon.ts";

export type TableGameMode = "AFLATOON" | "TEXAS_HOLDEM" | "CLASSIC_FLIPPING" | "FLIPPING_MOFLESS";

export type GameErrorCode =
  | "GAME_NOT_FOUND"
  | "HAND_NOT_FOUND"
  | "PLAYER_NOT_SEATED"
  | "NOT_YOUR_TURN"
  | "ILLEGAL_ACTION"
  | "STALE_STATE"
  | "DUPLICATE_ACTION"
  | "INSUFFICIENT_CHIPS"
  | "INVALID_BET_AMOUNT"
  | "PLAYER_ALREADY_FOLDED"
  | "PLAYER_ALREADY_PACKED"
  | "PLAYER_ALREADY_ALL_IN"
  | "GAME_NOT_READY"
  | "MINIMUM_PLAYERS_NOT_MET"
  | "PRIVATE_STATE_ACCESS_DENIED"
  | "INTERNAL_STATE_CONFLICT";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: GameErrorCode; message: string };

export type LegalAction = {
  type: string;
  exactAmount?: number;
  minimumAmount?: number;
  maximumAmount?: number;
  minimumRaiseTo?: number;
  maximumRaiseTo?: number;
  disabledReason?: string;
};

export type LegalActionSet = {
  canAct: boolean;
  actions: LegalAction[];
};

export type CreateGameInput = {
  roomCode: string;
  handId?: string;
  seed?: number;
  dealerIndex?: number;
  players: Array<{
    id: string;
    name: string;
    chips: number;
  }>;
};

export type StateTransition<TState> = {
  state: TState;
  events: GameEvent[];
};

export type SettlementResult = {
  winners: Array<{ playerId: string; chips: number; reason: string }>;
  events: GameEvent[];
};

export interface GameRulesEngine<TState, TAction> {
  createInitialState(input: CreateGameInput): TState;
  getLegalActions(state: TState, playerId: string): LegalActionSet;
  validateAction(state: TState, playerId: string, action: TAction): ValidationResult;
  applyAction(state: TState, playerId: string, action: TAction): StateTransition<TState>;
  isRoundComplete(state: TState): boolean;
  isHandComplete(state: TState): boolean;
  settleHand(state: TState): SettlementResult;
}

export type GameEventType =
  | "GAME_CREATED"
  | "PLAYER_JOINED"
  | "PLAYER_LEFT"
  | "HAND_STARTED"
  | "DECK_SHUFFLED"
  | "CARDS_DEALT"
  | "FORCED_BET_POSTED"
  | "CHECKED"
  | "BET_PLACED"
  | "CALLED"
  | "RAISED"
  | "ALL_IN"
  | "FOLDED"
  | "SHOWDOWN_STARTED"
  | "POT_CREATED"
  | "POT_AWARDED"
  | "HAND_COMPLETED"
  | "HAND_CANCELLED"
  | "BETTING_ROUND_COMPLETED"
  | "COMMUNITY_CARDS_REVEALED";

export type GameEvent = {
  id: string;
  type: GameEventType;
  playerId?: string;
  amount?: number;
  message: string;
};

export type PublicCard = Card | { hidden: true };

export const CHIP_VALUE_RUPEES = 50;

export function createGameEvent(
  type: GameEventType,
  message: string,
  detail: Pick<GameEvent, "playerId" | "amount"> = {},
): GameEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    message,
    ...detail,
  };
}
