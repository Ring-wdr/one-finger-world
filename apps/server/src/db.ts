import type { ProfileDto } from '@ofa/net';
import { parseProfile, type Profile, type ShopError } from '@ofa/meta';

/** Players table access (docs/multiplayer-server-design.md §9.1–9.2). All SQL is parameterized. */

interface PlayerRow {
	id: string;
	name: string;
	coins: number;
	best: number;
	matches: number;
	owned: string;
	equipped: string;
	version: number;
}

const COLUMNS = 'id, name, coins, best, matches, owned, equipped, version';

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function rowProfile(row: PlayerRow): Profile {
	return parseProfile({ coins: row.coins, best: row.best, matches: row.matches, owned: parseJson(row.owned), equipped: parseJson(row.equipped) });
}

function toDto(row: PlayerRow): ProfileDto {
	return { uid: row.id, name: row.name, ...rowProfile(row) };
}

export async function createPlayer(db: D1Database, id: string, name: string, now: number): Promise<ProfileDto> {
	await db.prepare('INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(id, name, now, now).run();
	const row = await db.prepare(`SELECT ${COLUMNS} FROM players WHERE id = ?`).bind(id).first<PlayerRow>();
	if (!row) throw new Error('player vanished after insert');
	return toDto(row);
}

export async function getProfile(db: D1Database, uid: string): Promise<ProfileDto | null> {
	const row = await db.prepare(`SELECT ${COLUMNS} FROM players WHERE id = ?`).bind(uid).first<PlayerRow>();
	return row ? toDto(row) : null;
}

export async function renamePlayer(db: D1Database, uid: string, name: string): Promise<ProfileDto | null> {
	const row = await db.prepare(`UPDATE players SET name = ? WHERE id = ? RETURNING ${COLUMNS}`).bind(name, uid).first<PlayerRow>();
	return row ? toDto(row) : null;
}

/** Optimistic concurrency: read, apply `change` (from @ofa/meta), UPDATE … WHERE version = ?; up to 3 tries. */
export async function updateProfile(
	db: D1Database,
	uid: string,
	change: (p: Profile) => Profile | ShopError
): Promise<ProfileDto | ShopError | 'conflict' | null> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await db.prepare(`SELECT ${COLUMNS} FROM players WHERE id = ?`).bind(uid).first<PlayerRow>();
		if (!row) return null;
		const next = change(rowProfile(row));
		if (typeof next === 'string') return next;
		const res = await db
			.prepare('UPDATE players SET coins = ?, owned = ?, equipped = ?, version = version + 1 WHERE id = ? AND version = ?')
			.bind(next.coins, JSON.stringify(next.owned), JSON.stringify(next.equipped), uid, row.version)
			.run();
		if (res.meta.changes > 0) return { uid, name: row.name, ...next };
	}
	return 'conflict';
}
