import { DurableObject } from 'cloudflare:workers';
import { MAX_HUMANS } from '@ofa/net';
import type { MatchBackend } from './settings';

/** How long a match stays open to new humans after its first one arrives. */
export const OPEN_WINDOW_MS = 12_000;

interface OpenMatch {
	matchId: string;
	/** Missing on rooms opened before the standalone match server existed: those are DO rooms. */
	backend?: MatchBackend;
	createdAt: number;
	uids: string[];
}

/** 64 hex like a Durable Object id (MATCH_ID_PATTERN), for rooms on the standalone match server. */
function serverMatchId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Matchmaking: groups quick-play requests into match rooms (docs/multiplayer-server-design.md §6). */
export class Lobby extends DurableObject<Env> {
	async assign(uid: string, backend: MatchBackend = 'do'): Promise<{ matchId: string }> {
		const now = Date.now();
		let open = this.ctx.storage.kv.get<OpenMatch>('open');
		if (open && now - open.createdAt >= OPEN_WINDOW_MS) open = undefined;
		// The operator switched backends: the open room stays where it is, new players go to a new one.
		if (open && (open.backend ?? 'do') !== backend) open = undefined;
		if (open?.uids.includes(uid)) return { matchId: open.matchId };
		if (!open || open.uids.length >= MAX_HUMANS) {
			const matchId = backend === 'server' ? serverMatchId() : this.env.MATCH.newUniqueId().toString();
			open = { matchId, backend, createdAt: now, uids: [] };
		}
		open.uids.push(uid);
		this.ctx.storage.kv.put('open', open);
		return { matchId: open.matchId };
	}
}
