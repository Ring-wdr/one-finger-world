import type { MatchReward } from '@ofa/meta';
import type { WorldCheckpoint } from '@ofa/sim';

/**
 * Contract between MatchCore (pure state machine, core.ts) and MatchRoom (the Durable Object
 * shell, room.ts). See docs/multiplayer-server-design.md §5.
 */

// ── Timing (§5.12)

export const WAIT_MS = 15_000;
export const FULL_START_DELAY_MS = 1_500;
export const JOIN_TICKET_MAX_AGE_MS = 30_000;
export const DISCONNECT_GRACE_MS = 3_000;
export const ABANDON_MS = 30_000;
export const CHECKPOINT_EVERY_TICKS = 40;
export const WATCHDOG_MS = 5_000;
export const END_LINGER_MS = 5_000;
export const CLEANUP_AFTER_END_MS = 60_000;
export const EMPTY_ROOM_TTL_MS = 60_000;
export const MAX_CATCHUP_TICKS = 3;
export const MAX_TICK_CRASHES = 3;
export const MAX_MATCH_SECONDS = 900;
export const GRANT_RETRY_MS = 30_000;
export const MAX_GRANT_ATTEMPTS = 10;
/** A tick interval above this counts as late in the match_end metrics. */
export const LATE_TICK_MS = 70;

// ── Seats

/** Identifies one WebSocket connection inside the room. */
export type ConnId = string;

/** What the Worker vouches for when it forwards a WebSocket upgrade (from a verified ticket). */
export interface SeatClaim {
	uid: string;
	name: string;
	runes: string[];
	/** Ticket issue time (epoch ms): only fresh tickets may take a new seat. */
	iat: number;
}

/** Request header carrying the SeatClaim from the Worker to the room. */
export const SEAT_HEADER = 'X-OFA-Seat';

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Header values must be Latin-1, and names are Korean: base64url of the UTF-8 JSON. */
export function encodeSeatHeader(c: SeatClaim): string {
	return b64url(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeSeatHeader(value: string | null): SeatClaim | null {
	if (!value) return null;
	try {
		const c = JSON.parse(new TextDecoder().decode(unb64url(value))) as Partial<SeatClaim>;
		if (typeof c.uid !== 'string' || !c.uid || typeof c.name !== 'string' || typeof c.iat !== 'number') return null;
		if (!Array.isArray(c.runes) || !c.runes.every((r) => typeof r === 'string')) return null;
		return { uid: c.uid, name: c.name, runes: c.runes, iat: c.iat };
	} catch {
		return null;
	}
}

export type MatchState = 'empty' | 'waiting' | 'running' | 'ended';

/** How a seat's match went, as rewards see it. */
export interface SeatResult {
	placement: number;
	kills: number;
	level: number;
	/** Seconds survived (match time when eliminated, locked or the match ended). */
	time: number;
	/** The human stopped playing before the result was decided (left or never came back). */
	leftEarly: boolean;
}

/** Reward grant state and what to tell the seat about it. */
export interface SeatOutcome {
	reward: MatchReward;
	/** Balances after the grant; null while it is pending. */
	coins: number | null;
	best: number | null;
	newBest: boolean;
	status: 'pending' | 'granted' | 'failed';
	attempts: number;
}

/** A human in this match. Persisted in MatchMeta, so it survives restarts. */
export interface Seat {
	uid: string;
	name: string;
	runes: string[];
	fighterId: number | null;
	/** Result captured when the AI took over; cleared when the human comes back. */
	locked: SeatResult | null;
	/** Result once decided (death or match end); never changes afterwards. */
	final: SeatResult | null;
	outcome: SeatOutcome | null;
	/** Sent { t: 'leave' }. */
	left: boolean;
}

/** Everything the room persists besides the world checkpoint (storage key 'meta'). */
export interface MatchMeta {
	v: 1;
	matchId: string;
	state: MatchState;
	createdAt: number;
	/** Waiting: when the match starts. */
	startsAt: number | null;
	/** Waiting with no seats: since when (cleanup after EMPTY_ROOM_TTL_MS). */
	emptySince: number | null;
	seed: number | null;
	startedAt: number | null;
	endedAt: number | null;
	winner: number | null;
	seats: Seat[];
	/** Consecutive tick failures after restores. */
	crashes: number;
	/** Times the running match was restored from a checkpoint (deploys, evictions, crashes). */
	restores: number;
	aborted: boolean;
}

// ── Rewards (D1, apps/server/src/match/rewards.ts)

export interface RewardGrant {
	matchId: string;
	uid: string;
	result: SeatResult;
	score: number;
	coins: number;
}

export interface RewardOutcome {
	/** 'duplicate': this seat was already paid (a retry); balances are still current. */
	status: 'granted' | 'duplicate';
	coins: number;
	best: number;
	prevBest: number;
}

export interface MatchSummary {
	matchId: string;
	seed: number;
	startedAt: number;
	endedAt: number;
	durationS: number;
	humans: number;
	winnerUid: string | null;
}

// ── Host

/** What MatchCore needs from its Durable Object. Everything here is synchronous except D1. */
export interface MatchHost {
	now(): number;
	send(conn: ConnId, data: string | Uint8Array): void;
	close(conn: ConnId, code: number, reason: string): void;
	/**
	 * Persist meta, plus the checkpoint when given (null deletes it). Written with
	 * allowUnconfirmed so snapshots are not held behind the write.
	 */
	save(meta: MatchMeta, checkpoint?: WorldCheckpoint | null): void;
	/** Replace the single alarm (null deletes it). */
	setAlarm(at: number | null): void;
	grant(g: RewardGrant): Promise<RewardOutcome>;
	recordMatch(s: MatchSummary): Promise<void>;
	/** The match is over and reported: delete all storage and the alarm. */
	destroy(): void;
	log(fields: Record<string, unknown>): void;
	/** A random u32 for the match seed. */
	random32(): number;
}
