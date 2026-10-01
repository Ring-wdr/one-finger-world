import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_SIG_HEADER, signInternal, verifyTicket, type RewardGrant, type RewardOutcome } from '@ofa/match';
import { API, MATCH_ID_PATTERN, type GuestResponse, type HealthResponse, type QuickplayResponse } from '@ofa/net';
import worker from '../src/index';
import { clearSettingsCache } from '../src/settings';

const SERVER = 'wss://match.test';

const setBackend = async (value: 'do' | 'server') => {
	await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('match_backend', ?, 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(value).run();
	clearSettingsCache();
};

afterEach(() => setBackend('do'));

/** The Worker with MATCH_SERVER_ORIGIN set, as production will have once the match server exists. */
const withServer = (request: Request) => worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, MATCH_SERVER_ORIGIN: SERVER } as Env);

async function newGuest(): Promise<GuestResponse> {
	const res = await exports.default.fetch(`http://test${API.guest}`, { method: 'POST', headers: { 'CF-Connecting-IP': `ip-${crypto.randomUUID()}` } });
	return res.json<GuestResponse>();
}

const quickplay = (token: string, fetcher: (r: Request) => Promise<Response> = (r) => exports.default.fetch(r)) =>
	fetcher(new Request(`http://test${API.quickplay}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }));

describe('match backend switch', () => {
	it('stays on Durable Objects until the match server origin is configured', async () => {
		await setBackend('server');
		const g = await newGuest();
		const q = await (await quickplay(g.token)).json<QuickplayResponse>();
		expect(q.server).toBeUndefined();
		expect((await (await exports.default.fetch('http://test/api/health')).json<HealthResponse>()).matchBackend).toBe('do');
	});

	it('sends players to the match server, then back to a fresh DO room when switched back', async () => {
		await setBackend('server');
		const a = await newGuest();
		const b = await newGuest();
		const qa = await (await quickplay(a.token, withServer)).json<QuickplayResponse>();
		const qb = await (await quickplay(b.token, withServer)).json<QuickplayResponse>();
		expect(qa.server).toBe(SERVER);
		expect(qa.matchId).toMatch(MATCH_ID_PATTERN);
		expect(qb.matchId).toBe(qa.matchId);
		expect(await verifyTicket(env.TICKET_SECRET, qa.ticket, Date.now())).toMatchObject({ sub: a.profile.uid, mid: qa.matchId });
		expect(await verifyTicket(env.AUTH_SECRET, qa.ticket, Date.now())).toBeNull();

		await setBackend('do');
		const qc = await (await quickplay((await newGuest()).token, withServer)).json<QuickplayResponse>();
		expect(qc.server).toBeUndefined();
		expect(qc.matchId).not.toBe(qa.matchId);
		// A DO room id: the namespace accepts it.
		expect(() => env.MATCH.idFromString(qc.matchId)).not.toThrow();
	});
});

describe('internal API (match server → Worker)', () => {
	const matchId = 'ab'.repeat(32);
	const signed = async (path: string, body: string, headers: Record<string, string> = {}, secret = env.INTERNAL_SECRET) =>
		exports.default.fetch(`http://test${path}`, { method: 'POST', body, headers: { [INTERNAL_SIG_HEADER]: await signInternal(secret, body, Date.now()), ...headers } });
	const grantFor = (uid: string): RewardGrant => ({ matchId, uid, score: 1234, coins: 123, result: { placement: 2, kills: 3, level: 7, time: 300, leftEarly: false } });

	it('grants a reward once and reports the repeat as a duplicate', async () => {
		const g = await newGuest();
		const body = JSON.stringify(grantFor(g.profile.uid));
		const first = await signed(API.internalGrant, body);
		expect(first.status).toBe(200);
		expect(await first.json<RewardOutcome>()).toMatchObject({ status: 'granted', coins: 123, best: 1234 });
		const again = await (await signed(API.internalGrant, body)).json<RewardOutcome>();
		expect(again).toMatchObject({ status: 'duplicate', coins: 123 });
	});

	it('records the match row', async () => {
		const body = JSON.stringify({ matchId, seed: 7, startedAt: 1, endedAt: 2, durationS: 300, humans: 2, winnerUid: null });
		expect((await signed(API.internalMatch, body)).status).toBe(200);
		expect(await env.DB.prepare('SELECT humans FROM matches WHERE id = ?').bind(matchId).first()).toEqual({ humans: 2 });
	});

	it('refuses bad signatures, browser origins and malformed bodies', async () => {
		const body = JSON.stringify(grantFor('nobody'));
		expect((await signed(API.internalGrant, body, {}, 'wrong-secret')).status).toBe(401);
		expect((await exports.default.fetch(`http://test${API.internalGrant}`, { method: 'POST', body })).status).toBe(401);
		expect((await signed(API.internalGrant, body, { Origin: 'https://evil.example' })).status).toBe(404);
		const bad = JSON.stringify({ ...grantFor('x'), coins: -5 });
		expect((await signed(API.internalGrant, bad)).status).toBe(400);
		expect((await signed(API.internalMatch, '{"matchId":"nope"}')).status).toBe(400);
	});
});
