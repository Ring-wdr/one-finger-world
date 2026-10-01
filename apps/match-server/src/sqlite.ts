import { Database } from 'bun:sqlite';
import type { MatchMeta } from '@ofa/match';
import type { WorldCheckpoint } from '@ofa/sim';
import type { RoomStore, StoredRoom } from './store';

/**
 * Rooms on local disk (bun:sqlite, WAL). Synchronous like the Durable Object's storage from the
 * room's point of view: a checkpoint (~100 KB) every 2 s per running room.
 */
export class SqliteStore implements RoomStore {
	private readonly db: Database;
	private readonly upsertMeta;
	private readonly upsertBoth;
	private readonly del;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.run('PRAGMA journal_mode = WAL');
		this.db.run('PRAGMA synchronous = NORMAL');
		this.db.run('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, meta TEXT NOT NULL, checkpoint TEXT, updated_at INTEGER NOT NULL)');
		this.upsertMeta = this.db.prepare(
			'INSERT INTO rooms (id, meta, checkpoint, updated_at) VALUES (?1, ?2, NULL, ?3) ON CONFLICT (id) DO UPDATE SET meta = excluded.meta, updated_at = excluded.updated_at'
		);
		this.upsertBoth = this.db.prepare(
			'INSERT INTO rooms (id, meta, checkpoint, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET meta = excluded.meta, checkpoint = excluded.checkpoint, updated_at = excluded.updated_at'
		);
		this.del = this.db.prepare('DELETE FROM rooms WHERE id = ?1');
	}

	save(id: string, meta: MatchMeta, checkpoint?: WorldCheckpoint | null): void {
		const now = Date.now();
		if (checkpoint === undefined) this.upsertMeta.run(id, JSON.stringify(meta), now);
		else this.upsertBoth.run(id, JSON.stringify(meta), checkpoint === null ? null : JSON.stringify(checkpoint), now);
	}

	delete(id: string): void {
		this.del.run(id);
	}

	loadAll(): Map<string, StoredRoom> {
		const rows = this.db.query<{ id: string; meta: string; checkpoint: string | null }, []>('SELECT id, meta, checkpoint FROM rooms').all();
		return new Map(rows.map((r) => [r.id, { meta: JSON.parse(r.meta) as MatchMeta, checkpoint: r.checkpoint ? (JSON.parse(r.checkpoint) as WorldCheckpoint) : null }]));
	}

	close(): void {
		this.db.close();
	}
}
