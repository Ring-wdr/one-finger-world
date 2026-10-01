/** Operator switches kept in D1 (`settings` table), read with a short per-isolate cache. */

/** How long an isolate trusts its last read; a switch takes effect everywhere within this. */
export const SETTINGS_CACHE_MS = 10_000;

/** Where new matches run: the MatchRoom Durable Object, or the standalone match server (docs/match-server-oracle.md). */
export type MatchBackend = 'do' | 'server';

export interface Settings {
	/** Whether new online matches may start. */
	open: boolean;
	backend: MatchBackend;
}

const DEFAULTS: Settings = { open: true, backend: 'do' };

let cached: { settings: Settings; at: number } | null = null;

/** Missing rows mean the defaults; a failed read keeps the last value (the defaults at first). */
export async function readSettings(db: D1Database, now = Date.now()): Promise<Settings> {
	if (cached && now - cached.at < SETTINGS_CACHE_MS) return cached.settings;
	let settings = cached?.settings ?? DEFAULTS;
	try {
		const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('multiplayer', 'match_backend')").all<{ key: string; value: string }>();
		const row = (key: string) => results.find((r) => r.key === key)?.value;
		settings = { open: row('multiplayer') !== 'off', backend: row('match_backend') === 'server' ? 'server' : 'do' };
	} catch (err) {
		console.error(JSON.stringify({ event: 'settings_error', message: err instanceof Error ? err.message : String(err) }));
	}
	cached = { settings, at: now };
	return settings;
}

export async function multiplayerOpen(db: D1Database, now = Date.now()): Promise<boolean> {
	return (await readSettings(db, now)).open;
}

/** Tests flip the switches and must not wait for the cache. */
export function clearSettingsCache(): void {
	cached = null;
}
