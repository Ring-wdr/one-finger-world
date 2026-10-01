import type { MatchMeta } from '@ofa/match';
import type { WorldCheckpoint } from '@ofa/sim';

export interface StoredRoom {
	meta: MatchMeta;
	checkpoint: WorldCheckpoint | null;
}

/** What a room persists so a restarted process can resume it (docs/match-server-oracle.md §6.4). */
export interface RoomStore {
	/** `checkpoint`: undefined keeps the stored one, null deletes it (MatchHost.save semantics). */
	save(id: string, meta: MatchMeta, checkpoint?: WorldCheckpoint | null): void;
	delete(id: string): void;
	loadAll(): Map<string, StoredRoom>;
}

/** For tests and local runs without a data directory. */
export class MemoryStore implements RoomStore {
	readonly rooms = new Map<string, StoredRoom>();

	save(id: string, meta: MatchMeta, checkpoint?: WorldCheckpoint | null): void {
		const prev = this.rooms.get(id);
		// Deep copies: the core keeps mutating its meta, and a store must hold what was written.
		this.rooms.set(id, {
			meta: structuredClone(meta),
			checkpoint: checkpoint === undefined ? (prev?.checkpoint ?? null) : checkpoint === null ? null : structuredClone(checkpoint)
		});
	}

	delete(id: string): void {
		this.rooms.delete(id);
	}

	loadAll(): Map<string, StoredRoom> {
		return new Map([...this.rooms].map(([id, r]) => [id, structuredClone(r)]));
	}
}
