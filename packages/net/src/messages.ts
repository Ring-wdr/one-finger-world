import type { MatchReward } from '@ofa/meta';
import { MAX_TEXT_MESSAGE } from './constants';

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

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);

const isReward = (v: unknown): boolean =>
	isObj(v) &&
	isNum(v.score) &&
	isNum(v.coins) &&
	Array.isArray(v.breakdown) &&
	v.breakdown.every((b) => isObj(b) && isStr(b.label) && isNum(b.points));

const isRoster = (v: unknown): boolean => isObj(v) && isNum(v.id) && isStr(v.name) && isStr(v.color) && isBool(v.human);
const isLobbyPlayer = (v: unknown): boolean => isObj(v) && isStr(v.name) && isBool(v.you);

/** Field checks per message kind; a message passes when every listed field does. */
const SERVER_SHAPES: Record<ServerMessage['t'], Record<string, (v: unknown) => boolean>> = {
	lobby: {
		matchId: isStr,
		players: (v) => Array.isArray(v) && v.every(isLobbyPlayer),
		max: isNum,
		startsAt: orNull(isNum),
		serverNow: isNum
	},
	start: {
		matchId: isStr,
		tick: isNum,
		you: orNull(isNum),
		fighters: (v) => Array.isArray(v) && v.every(isRoster)
	},
	self: {
		items: isStrArr,
		runes: isStrArr,
		offer: orNull(isStrArr),
		pendingDrafts: isNum,
		rerolls: isNum,
		exchangeTokens: isNum
	},
	result: {
		placement: isNum,
		kills: isNum,
		level: isNum,
		time: isNum,
		reward: orNull(isReward),
		coins: orNull(isNum),
		best: orNull(isNum),
		newBest: isBool,
		rewardPending: isBool
	},
	end: { winner: orNull(isNum) }
};

const CLIENT_SHAPES: Record<ClientMessage['t'], Record<string, (v: unknown) => boolean>> = {
	spectate: { id: isNum },
	leave: {},
	stats: { rtt: (v) => isObj(v) && isNum(v.p50) && isNum(v.p95) && isNum(v.n) }
};

function parseJson(text: string): Obj | null {
	try {
		const v: unknown = JSON.parse(text);
		return isObj(v) ? v : null;
	} catch {
		return null;
	}
}

function matches(v: Obj, shapes: Record<string, Record<string, (x: unknown) => boolean>>): boolean {
	const shape = isStr(v.t) && Object.hasOwn(shapes, v.t) ? shapes[v.t] : undefined;
	return shape !== undefined && Object.entries(shape).every(([key, check]) => check(v[key]));
}

/** Parses and shape-checks a server message; null when malformed or unknown. */
export function parseServerMessage(text: string): ServerMessage | null {
	const v = parseJson(text);
	return v && matches(v, SERVER_SHAPES) ? (v as unknown as ServerMessage) : null;
}

/** Parses and shape-checks a client message; null when malformed, unknown or too long. */
export function parseClientMessage(text: string): ClientMessage | null {
	if (new TextEncoder().encode(text).length > MAX_TEXT_MESSAGE) return null;
	const v = parseJson(text);
	return v && matches(v, CLIENT_SHAPES) ? (v as unknown as ClientMessage) : null;
}
