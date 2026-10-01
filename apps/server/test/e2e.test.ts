import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { API, DATA_HASH, PROTOCOL_VERSION, type GuestResponse, type ProfileResponse, type QuickplayResponse } from '@ofa/net';
import { signToken } from '@ofa/match';
import { Client } from './wsclient';

/** The whole path a browser takes: HTTP API → lobby → ticket → Worker WebSocket route → room → D1. */

const base = 'http://game.test';
const call = (path: string, init?: RequestInit) => exports.default.fetch(`${base}${path}`, init);
const authed = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });

async function guest(): Promise<GuestResponse> {
	const res = await call(API.guest, { method: 'POST' });
	expect(res.status).toBe(200);
	return res.json<GuestResponse>();
}

async function quickplay(token: string): Promise<QuickplayResponse> {
	const res = await call(API.quickplay, authed(token, { method: 'POST' }));
	expect(res.status).toBe(200);
	return res.json<QuickplayResponse>();
}

const wsPath = (q: QuickplayResponse) => `${API.matchWs(q.matchId)}?ticket=${encodeURIComponent(q.ticket)}&v=${PROTOCOL_VERSION}&h=${DATA_HASH}`;

async function connect(q: QuickplayResponse): Promise<Client> {
	return Client.from(await call(wsPath(q), { headers: { Upgrade: 'websocket' } }));
}

describe('end to end through the Worker', () => {
	it('two guests quick-play into one match, play it out and get paid once', { timeout: 60_000 }, async () => {
		const [a, b] = [await guest(), await guest()];
		const [qa, qb] = [await quickplay(a.token), await quickplay(b.token)];
		expect(qb.matchId).toBe(qa.matchId);

		const ca = await connect(qa);
		const cb = await connect(qb);
		const lobby = await ca.message('lobby', (m) => m.players.length === 2);
		expect(lobby.players.map((p) => p.name)).toEqual([a.profile.name, b.profile.name]);

		const room = env.MATCH.get(env.MATCH.idFromString(qa.matchId));
		await room.debugForceStart();
		const start = await ca.message('start');
		expect(start.fighters.filter((f) => f.human).map((f) => f.name)).toEqual([a.profile.name, b.profile.name]);
		await cb.message('start');

		// Input through the Worker-forwarded socket moves the fighter.
		const first = await ca.snapshot((s) => s.self !== null);
		const stop = ca.streamInput({ move: { x: 0, y: 1 }, run: true });
		await ca.snapshot((s) => s.self !== null && s.self.pos.y - first.self!.pos.y > 0.5);
		stop();

		await room.debugFastForward();
		const [ra, rb] = [await ca.message('result'), await cb.message('result')];
		await ca.message('end');
		expect(ra.reward!.coins).toBeGreaterThan(0);

		// The profile API reflects the grant, and buying with the new coins works.
		const pa = await (await call(API.profile, authed(a.token))).json<ProfileResponse>();
		expect(pa.profile.coins).toBe(ra.reward!.coins);
		expect(pa.profile.matches).toBe(1);
		const pb = await (await call(API.profile, authed(b.token))).json<ProfileResponse>();
		expect(pb.profile.coins).toBe(rb.reward!.coins);
	});

	it('a well-formed id that this namespace never minted is 404, not a server error', async () => {
		const g = await guest();
		const mid = 'ab'.repeat(32);
		const ticket = await signToken(env.TICKET_SECRET, { typ: 'ticket', sub: g.profile.uid, mid, name: g.profile.name, runes: [], iat: Date.now(), exp: Date.now() + 60_000 });
		const res = await call(wsPath({ matchId: mid, ticket }), { headers: { Upgrade: 'websocket' } });
		expect(res.status).toBe(404);
	});

	it('refuses a client built from other game data', async () => {
		const g = await guest();
		const q = await quickplay(g.token);
		const res = await call(`${API.matchWs(q.matchId)}?ticket=${encodeURIComponent(q.ticket)}&v=${PROTOCOL_VERSION}&h=deadbeef`, { headers: { Upgrade: 'websocket' } });
		expect(res.status).toBe(409);
	});
});
