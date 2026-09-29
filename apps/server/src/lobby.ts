import { DurableObject } from 'cloudflare:workers';

/** Matchmaking: groups quick-play requests into match rooms (docs/multiplayer-server-design.md §6). */
export class Lobby extends DurableObject<Env> {
	async assign(uid: string): Promise<{ matchId: string }> {
		void uid;
		throw new Error('not implemented yet (T5)');
	}
}
