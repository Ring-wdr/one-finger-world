import { DurableObject } from 'cloudflare:workers';
import { MAX_HUMANS } from '@ofa/net';

/** How long a match stays open to new humans after its first one arrives. */
export const OPEN_WINDOW_MS = 12_000;

interface OpenMatch {
	matchId: string;
	createdAt: number;
	uids: string[];
}

/** Matchmaking: groups quick-play requests into match rooms (docs/multiplayer-server-design.md §6). */
export class Lobby extends DurableObject<Env> {
	async assign(uid: string): Promise<{ matchId: string }> {
		const now = Date.now();
		let open = this.ctx.storage.kv.get<OpenMatch>('open');
		if (open && now - open.createdAt >= OPEN_WINDOW_MS) open = undefined;
		if (open?.uids.includes(uid)) return { matchId: open.matchId };
		if (!open || open.uids.length >= MAX_HUMANS) {
			open = { matchId: this.env.MATCH.newUniqueId().toString(), createdAt: now, uids: [] };
		}
		open.uids.push(uid);
		this.ctx.storage.kv.put('open', open);
		return { matchId: open.matchId };
	}
}
