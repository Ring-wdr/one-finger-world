import { MAX_MATCH_SECONDS } from '@ofa/match';
import { Room, type RoomDeps } from './room';

/** Stored rooms older than this cannot still be playing; restart drops them instead of resuming. */
export const STALE_ROOM_MS = 2 * MAX_MATCH_SECONDS * 1000;

/** matchId → Room. Rooms are created by the first valid connection and removed when the match cleans up. */
export class Rooms {
	private readonly rooms = new Map<string, Room>();

	constructor(private readonly deps: RoomDeps) {}

	/** Resume what the last process left in the store (§6.4). Returns how many rooms came back. */
	restore(now = Date.now()): number {
		for (const [id, stored] of this.deps.store.loadAll()) {
			if (now - stored.meta.createdAt > STALE_ROOM_MS) {
				this.deps.store.delete(id);
				continue;
			}
			this.rooms.set(id, new Room(id, this.deps, (r) => this.forget(r), stored));
		}
		return this.rooms.size;
	}

	open(id: string): Room {
		let room = this.rooms.get(id);
		if (!room) {
			room = new Room(id, this.deps, (r) => this.forget(r));
			this.rooms.set(id, room);
		}
		return room;
	}

	get(id: string): Room | undefined {
		return this.rooms.get(id);
	}

	shutdown(): void {
		for (const room of this.rooms.values()) room.shutdown();
	}

	stats(): { rooms: number; running: number; connections: number } {
		let running = 0;
		let connections = 0;
		for (const r of this.rooms.values()) {
			if (r.state === 'running') running += 1;
			connections += r.connections;
		}
		return { rooms: this.rooms.size, running, connections };
	}

	private forget(room: Room): void {
		if (this.rooms.get(room.id) === room) this.rooms.delete(room.id);
	}
}
