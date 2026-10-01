/** Operator switches kept in D1 (`settings` table), read with a short per-isolate cache. */

/** How long an isolate trusts its last read; a switch takes effect everywhere within this. */
export const SETTINGS_CACHE_MS = 10_000;

let cached: { open: boolean; at: number } | null = null;

/** Whether new online matches may start. A missing row means open; a failed read keeps the last value (open at first). */
export async function multiplayerOpen(db: D1Database, now = Date.now()): Promise<boolean> {
	if (cached && now - cached.at < SETTINGS_CACHE_MS) return cached.open;
	let open = cached?.open ?? true;
	try {
		const row = await db.prepare("SELECT value FROM settings WHERE key = 'multiplayer'").first<{ value: string }>();
		open = row?.value !== 'off';
	} catch (err) {
		console.error(JSON.stringify({ event: 'settings_error', message: err instanceof Error ? err.message : String(err) }));
	}
	cached = { open, at: now };
	return open;
}

/** Tests flip the switch and must not wait for the cache. */
export function clearSettingsCache(): void {
	cached = null;
}
