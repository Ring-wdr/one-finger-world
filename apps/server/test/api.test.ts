import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { API, DATA_HASH, PROTOCOL_VERSION, type ApiErrorBody, type GuestResponse, type ProfileResponse, type QuickplayResponse } from '@ofa/net';
import { signToken, verifyTicket } from '../src/auth';
import { corsHeaders, originAllowed } from '../src/http';

const ORIGIN = 'http://test';
const secret = env.AUTH_SECRET;

function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: unknown } = {}) {
	const { token, body, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('Authorization', `Bearer ${token}`);
	if (body !== undefined) headers.set('Content-Type', 'application/json');
	return exports.default.fetch(`${ORIGIN}${path}`, { ...rest, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function newGuest(): Promise<GuestResponse> {
	const res = await call(API.guest, { method: 'POST', headers: { 'CF-Connecting-IP': `ip-${crypto.randomUUID()}` } });
	expect(res.status).toBe(200);
	return res.json<GuestResponse>();
}

const post = (path: string, token: string, body?: unknown) => call(path, { method: 'POST', token, body });
const errorCode = async (res: Response) => (await res.json<ApiErrorBody>()).error.code;
const setCoins = (uid: string, coins: number) => env.DB.prepare('UPDATE players SET coins = ? WHERE id = ?').bind(coins, uid).run();

describe('guest and profile', () => {
	it('creates a guest with a valid name and reads the profile back', async () => {
		const { token, profile } = await newGuest();
		expect(profile).toMatchObject({ coins: 0, owned: [], best: 0, matches: 0, equipped: { offense: null, defense: null, utility: null } });
		const res = await call(API.profile, { token });
		expect((await res.json<ProfileResponse>()).profile).toEqual(profile);
	});

	it('renames with normalization and rejects invalid names', async () => {
		const { token } = await newGuest();
		const ok = await post(API.name, token, { name: '  새  이름 ' });
		expect(ok.status).toBe(200);
		expect((await ok.json<ProfileResponse>()).profile.name).toBe('새 이름');
		for (const name of ['a', 'x'.repeat(13), '<b>']) {
			const bad = await post(API.name, token, { name });
			expect(bad.status).toBe(422);
			expect(await errorCode(bad)).toBe('bad_name');
		}
		expect((await post(API.name, token, { name: 5 })).status).toBe(400);
		expect((await (await call(API.profile, { token })).json<ProfileResponse>()).profile.name).toBe('새 이름');
	});

	it('rejects missing, garbage and ticket-typed tokens', async () => {
		const { profile } = await newGuest();
		const ticket = await signToken(secret, { typ: 'ticket', sub: profile.uid, mid: 'a'.repeat(64), name: 'x', runes: [], iat: 0, exp: Date.now() + 60_000 });
		const unknownGuest = await signToken(secret, { typ: 'guest', sub: 'nobody', iat: 0 });
		expect((await call(API.profile)).status).toBe(401);
		for (const token of ['garbage', ticket, unknownGuest]) {
			const res = await call(API.profile, { token });
			expect(res.status).toBe(401);
			expect(await errorCode(res)).toBe('unauthorized');
		}
	});

	it('rejects oversized and malformed bodies', async () => {
		const { token } = await newGuest();
		const big = await post(API.name, token, { name: 'ab', pad: 'x'.repeat(5000) });
		expect(big.status).toBe(400);
		const bad = await call(API.name, { method: 'POST', token, body: undefined, headers: { 'Content-Type': 'application/json' } });
		expect(bad.status).toBe(400);
	});

	it('answers unknown paths with 404 and wrong methods with 405', async () => {
		const missing = await call('/api/nope');
		expect(missing.status).toBe(404);
		expect(await errorCode(missing)).toBe('not_found');
		expect((await call(API.guest)).status).toBe(405);
		expect((await call(API.profile, { method: 'POST' })).status).toBe(405);
	});
});

describe('shop', () => {
	it('buys, auto-equips, toggles, and refuses repeats, poverty and unknown runes', async () => {
		const { token, profile } = await newGuest();
		const broke = await post(API.buy, token, { runeId: 'rune_power' });
		expect(broke.status).toBe(409);
		expect(await errorCode(broke)).toBe('coins');

		await setCoins(profile.uid, 400);
		const bought = await post(API.buy, token, { runeId: 'rune_power' });
		expect(bought.status).toBe(200);
		const p = (await bought.json<ProfileResponse>()).profile;
		expect(p).toMatchObject({ coins: 250, owned: ['rune_power'], equipped: { offense: 'rune_power' } });

		const off = (await (await post(API.equip, token, { runeId: 'rune_power' })).json<ProfileResponse>()).profile;
		expect(off.equipped.offense).toBeNull();
		const on = (await (await post(API.equip, token, { runeId: 'rune_power' })).json<ProfileResponse>()).profile;
		expect(on.equipped.offense).toBe('rune_power');

		const again = await post(API.buy, token, { runeId: 'rune_power' });
		expect(again.status).toBe(409);
		expect(await errorCode(again)).toBe('owned');

		const unknown = await post(API.buy, token, { runeId: 'rune_nope' });
		expect(unknown.status).toBe(422);
		expect(await errorCode(unknown)).toBe('unknown_rune');
		expect((await post(API.buy, token, { runeId: 'x'.repeat(65) })).status).toBe(400);
	});

	it('equipping a rune that is not owned changes nothing', async () => {
		const { token, profile } = await newGuest();
		const res = await post(API.equip, token, { runeId: 'rune_haste' });
		expect(res.status).toBe(200);
		expect((await res.json<ProfileResponse>()).profile).toEqual(profile);
	});

	it('lets exactly one of two concurrent buys through when coins cover only one', async () => {
		const { token, profile } = await newGuest();
		await setCoins(profile.uid, 200);
		const results = await Promise.all([post(API.buy, token, { runeId: 'rune_power' }), post(API.buy, token, { runeId: 'rune_haste' })]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		const final = (await (await call(API.profile, { token })).json<ProfileResponse>()).profile;
		expect(final.owned).toHaveLength(1);
		expect(final.coins).toBe(50);
	});
});

describe('quickplay', () => {
	it('puts two guests in the same match with verifiable tickets', async () => {
		const a = await newGuest();
		const b = await newGuest();
		await setCoins(a.profile.uid, 150);
		await post(API.buy, a.token, { runeId: 'rune_power' });
		const renamed = await post(API.name, a.token, { name: '테스터' });
		expect(renamed.status).toBe(200);

		const qa = await (await post(API.quickplay, a.token)).json<QuickplayResponse>();
		const qb = await (await post(API.quickplay, b.token)).json<QuickplayResponse>();
		expect(qb.matchId).toBe(qa.matchId);

		const claims = await verifyTicket(secret, qa.ticket, Date.now());
		expect(claims).toMatchObject({ sub: a.profile.uid, mid: qa.matchId, name: '테스터', runes: ['rune_power'] });
		expect(claims!.exp - claims!.iat).toBe(15 * 60_000);
		expect((await verifyTicket(secret, qb.ticket, Date.now()))!.runes).toEqual([]);
	});

	it('requires a guest token', async () => {
		expect((await call(API.quickplay, { method: 'POST' })).status).toBe(401);
	});
});

describe('match websocket route', () => {
	// Only ids minted by the namespace pass idFromString.
	const matchId = env.MATCH.newUniqueId().toString();
	const ticketFor = (uid: string, mid = matchId, ttl = 60_000) =>
		signToken(secret, { typ: 'ticket', sub: uid, mid, name: 'n', runes: [], iat: Date.now(), exp: Date.now() + ttl });
	const ws = (id: string, query: Record<string, string>, headers: Record<string, string> = { Upgrade: 'websocket' }) =>
		call(`/api/match/${id}/ws?${new URLSearchParams(query)}`, { headers });
	const good = async () => ({ v: String(PROTOCOL_VERSION), h: DATA_HASH, ticket: await ticketFor('u1') });

	it('requires an upgrade, a well-formed id and matching version', async () => {
		expect((await ws(matchId, await good(), {})).status).toBe(426);
		expect((await ws('short', await good())).status).toBe(404);
		expect((await ws(matchId.toUpperCase(), await good())).status).toBe(404);
		const badV = await ws(matchId, { ...(await good()), v: '999' });
		expect(badV.status).toBe(409);
		expect(await errorCode(badV)).toBe('version');
		expect((await ws(matchId, { ...(await good()), h: 'nope' })).status).toBe(409);
	});

	it('rejects missing, wrong-match, expired and non-ticket tokens', async () => {
		const base = { v: String(PROTOCOL_VERSION), h: DATA_HASH };
		expect((await ws(matchId, base)).status).toBe(401);
		expect((await ws(matchId, { ...base, ticket: await ticketFor('u1', 'cd'.repeat(32)) })).status).toBe(401);
		expect((await ws(matchId, { ...base, ticket: await ticketFor('u1', matchId, -1) })).status).toBe(401);
		const guestToken = await signToken(secret, { typ: 'guest', sub: 'u1', iat: 0 });
		expect((await ws(matchId, { ...base, ticket: guestToken })).status).toBe(401);
	});

	it('refuses a foreign Origin', async () => {
		const res = await ws(matchId, await good(), { Upgrade: 'websocket', Origin: 'https://evil.example' });
		expect(res.status).toBe(403);
	});

	it('upgrades with a valid ticket, for same-origin and allowed origins', async () => {
		for (const headers of <Record<string, string>[]>[{ Upgrade: 'websocket' }, { Upgrade: 'websocket', Origin: ORIGIN }, { Upgrade: 'websocket', Origin: 'https://ring-wdr.github.io' }]) {
			const res = await ws(matchId, await good(), headers);
			expect(res.status).toBe(101);
			res.webSocket?.accept();
			res.webSocket?.close();
		}
	});
});

describe('CORS', () => {
	const allowed = 'https://ring-wdr.github.io';

	it('answers a preflight from an allowed origin', async () => {
		const res = await call(API.guest, { method: 'OPTIONS', headers: { Origin: allowed } });
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
		expect(res.headers.get('Vary')).toBe('Origin');
		expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
		expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
		expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
	});

	it('refuses a preflight from another origin', async () => {
		const res = await call(API.guest, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
		expect(res.status).toBe(403);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	it('adds headers to real responses for allowed origins only', async () => {
		const ok = await call(API.health, { headers: { Origin: allowed } });
		expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
		const other = await call(API.health, { headers: { Origin: 'https://evil.example' } });
		expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	it('serves same-origin requests without CORS headers', async () => {
		const res = await call(API.health, { headers: { Origin: ORIGIN } });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});
});

describe('ALLOWED_ORIGINS=* (local development)', () => {
	const devEnv = { ALLOWED_ORIGINS: '*' } as Env;
	const listEnv = { ALLOWED_ORIGINS: 'https://ring-wdr.github.io' } as Env;
	const from = (origin: string | null) => new Request(`${ORIGIN}/api/health`, origin === null ? {} : { headers: { Origin: origin } });

	it('admits any origin and echoes it instead of a literal *', () => {
		const request = from('http://192.168.0.7:5173');
		expect(originAllowed(request, devEnv)).toBe(true);
		const headers = corsHeaders(request, devEnv);
		expect(headers['Access-Control-Allow-Origin']).toBe('http://192.168.0.7:5173');
		expect(headers.Vary).toBe('Origin');
	});

	it('adds no CORS headers without an Origin', () => {
		expect(originAllowed(from(null), devEnv)).toBe(true);
		expect(corsHeaders(from(null), devEnv)).toEqual({});
	});

	it('does not treat * specially when it is not listed', () => {
		expect(originAllowed(from('http://192.168.0.7:5173'), listEnv)).toBe(false);
		expect(corsHeaders(from('http://192.168.0.7:5173'), listEnv)).toEqual({});
	});
});

describe('rate limiting', () => {
	it('rejects guest creation over the per-IP limit with 429', async () => {
		const ip = `ip-${crypto.randomUUID()}`;
		const statuses: number[] = [];
		for (let i = 0; i < 32; i++) statuses.push((await call(API.guest, { method: 'POST', headers: { 'CF-Connecting-IP': ip } })).status);
		expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
		expect(statuses.slice(30)).toContain(429);
	});
});
