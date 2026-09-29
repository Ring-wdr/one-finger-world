import type { MatchReward } from '@ofa/meta';
import { todo } from './todo';

/** JSON control messages (docs/multiplayer-server-design.md §10.6). Snapshots and inputs are binary. */

export interface RosterEntry {
	id: number;
	name: string;
	color: string;
	/** A human seat (even while the AI stands in for a disconnected player). */
	human: boolean;
}

export interface LobbyMessage {
	t: 'lobby';
	matchId: string;
	players: { name: string; you: boolean }[];
	max: number;
	/** Server epoch ms when the match starts, or null until someone has joined. */
	startsAt: number | null;
	/** Server epoch ms when this message was sent, to offset the countdown. */
	serverNow: number;
}

export interface StartMessage {
	t: 'start';
	matchId: string;
	tick: number;
	/** The receiver's fighter id. */
	you: number | null;
	fighters: RosterEntry[];
}

/** The receiver's build and draft state; sent on change, before that tick's snapshot. */
export interface SelfMessage {
	t: 'self';
	items: string[];
	runes: string[];
	offer: string[] | null;
	pendingDrafts: number;
	rerolls: number;
	exchangeTokens: number;
}

/** The receiver's final result, sent when it is decided (death, or match end). */
export interface ResultMessage {
	t: 'result';
	placement: number;
	kills: number;
	level: number;
	time: number;
	reward: MatchReward | null;
	/** Coin balance after the reward, when the grant succeeded. */
	coins: number | null;
	best: number | null;
	newBest: boolean;
	/** The grant is being retried; coins show up on the next profile load. */
	rewardPending: boolean;
}

export interface EndMessage {
	t: 'end';
	winner: number | null;
}

export type ServerMessage = LobbyMessage | StartMessage | SelfMessage | ResultMessage | EndMessage;

export type ClientMessage =
	| { t: 'spectate'; id: number }
	| { t: 'leave' }
	| { t: 'stats'; rtt: { p50: number; p95: number; n: number } };

/** Parses and shape-checks a server message; null when malformed or unknown. */
export function parseServerMessage(text: string): ServerMessage | null {
	return todo('T3', text);
}

/** Parses and shape-checks a client message; null when malformed, unknown or too long. */
export function parseClientMessage(text: string): ClientMessage | null {
	return todo('T3', text);
}
