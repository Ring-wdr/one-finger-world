import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { API, DATA_HASH, PROTOCOL_VERSION, type ApiErrorBody, type GuestResponse, type HealthResponse } from '@ofa/net';
import { clearSettingsCache, multiplayerOpen, SETTINGS_CACHE_MS } from '../src/settings';

const setMultiplayer = async (value: 'on' | 'off') => {
	await env.DB.prepare("UPDATE settings SET value = ?, updated_at = 1 WHERE key = 'multiplayer'").bind(value).run();
	clearSettingsCache();
};

afterEach(() => setMultiplayer('on'));

describe('GET /api/health', () => {
	it('reports the protocol version, data hash and whether online play is open', async () => {
		const res = await exports.default.fetch('http://test/api/health');
		expect(res.status).toBe(200);
		expect(await res.json<HealthResponse>()).toEqual({ ok: true, protocol: PROTOCOL_VERSION, dataHash: DATA_HASH, multiplayer: true, matchBackend: 'do' });
	});
});

describe('operator switch', () => {
	it('closes quickplay with 503 closed and says so in health', async () => {
		const g = await (await exports.default.fetch(`http://test${API.guest}`, { method: 'POST' })).json<GuestResponse>();
		await setMultiplayer('off');
		expect((await (await exports.default.fetch('http://test/api/health')).json<HealthResponse>()).multiplayer).toBe(false);
		const res = await exports.default.fetch(`http://test${API.quickplay}`, { method: 'POST', headers: { Authorization: `Bearer ${g.token}` } });
		expect(res.status).toBe(503);
		expect((await res.json<ApiErrorBody>()).error.code).toBe('closed');
		// The rest of the API (profile, shop) keeps working.
		expect((await exports.default.fetch(`http://test${API.profile}`, { headers: { Authorization: `Bearer ${g.token}` } })).status).toBe(200);

		await setMultiplayer('on');
		const again = await exports.default.fetch(`http://test${API.quickplay}`, { method: 'POST', headers: { Authorization: `Bearer ${g.token}` } });
		expect(again.status).toBe(200);
	});

	it('caches the switch per isolate and treats a missing row as open', async () => {
		await setMultiplayer('off');
		expect(await multiplayerOpen(env.DB, 1_000)).toBe(false);
		await env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'multiplayer'").run();
		expect(await multiplayerOpen(env.DB, 1_000 + SETTINGS_CACHE_MS - 1)).toBe(false);
		expect(await multiplayerOpen(env.DB, 1_000 + SETTINGS_CACHE_MS)).toBe(true);

		await env.DB.prepare("DELETE FROM settings WHERE key = 'multiplayer'").run();
		clearSettingsCache();
		expect(await multiplayerOpen(env.DB)).toBe(true);
		await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('multiplayer', 'on', 0)").run();
	});
});
