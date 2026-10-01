import type { RuneSlot } from '@ofa/sim';

/** HTTP API contract (docs/multiplayer-server-design.md §7). All bodies are JSON. */

export const API = {
	health: '/api/health',
	guest: '/api/guest',
	profile: '/api/profile',
	name: '/api/profile/name',
	buy: '/api/shop/buy',
	equip: '/api/shop/equip',
	quickplay: '/api/quickplay',
	matchWs: (matchId: string) => `/api/match/${matchId}/ws`,
	/** Match server → Worker, signed with INTERNAL_SECRET (docs/match-server-oracle.md §8). */
	internalGrant: '/api/internal/grant',
	internalMatch: '/api/internal/match'
} as const;

/** The match server's own WebSocket path (no /api prefix: it is not the Worker). */
export const serverMatchWs = (matchId: string) => `/match/${matchId}/ws`;

/** A Durable Object id string, as the lobby hands it out. */
export const MATCH_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface ProfileDto {
	uid: string;
	name: string;
	coins: number;
	owned: string[];
	equipped: Record<RuneSlot, string | null>;
	best: number;
	matches: number;
}

export interface HealthResponse {
	ok: true;
	protocol: number;
	dataHash: string;
	/** False while the operator has closed online play; the client then explains instead of queueing. */
	multiplayer: boolean;
	/** Where new matches run (docs/match-server-oracle.md): the Worker's Durable Objects or the standalone match server. */
	matchBackend?: 'do' | 'server';
}

export interface GuestResponse {
	token: string;
	profile: ProfileDto;
}

export interface ProfileResponse {
	profile: ProfileDto;
}

export interface NameRequest {
	name: string;
}

export interface RuneRequest {
	runeId: string;
}

export interface QuickplayResponse {
	matchId: string;
	ticket: string;
	/** Origin of the standalone match server (wss://…) when the match runs there; absent for Durable Object matches. */
	server?: string;
}

export type ApiErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'not_found'
	| 'rate_limited'
	| 'coins'
	| 'owned'
	| 'unknown_rune'
	| 'bad_name'
	| 'conflict'
	| 'version'
	| 'closed'
	| 'server';

export interface ApiErrorBody {
	error: { code: ApiErrorCode; message: string };
}
