import { describe, expect, it } from 'vitest';
import { CLEANUP_AFTER_END_MS, END_LINGER_MS, signInternal, signToken, verifyInternal, WAIT_MS, type LoopTimers, type MatchCore, type RewardGrant, type SeatClaim } from '@ofa/match';
import { API, Close, DATA_HASH, decodeSnapshot, parseServerMessage, PROTOCOL_VERSION, TICK_MS, type ServerMessage } from '@ofa/net';
import { admit } from './admit';
import { readConfig } from './config';
import { CLOSE_RESTART, type RoomSocket } from './room';
import { Rooms, STALE_ROOM_MS } from './rooms';
import { MemoryStore } from './store';
import { WorkerClient, type WorkerApi } from './worker';

const T0 = 1_700_000_000_000;
const MATCH = 'ab'.repeat(32);

/** Manual clock driving every timer the rooms set (tick loop and alarms). */
class Clock implements LoopTimers {
	t = T0;
	private queue: { at: number; fn: () => void; id: number }[] = [];
	private ids = 0;
	now = () => this.t;
	setTimeout = (fn: () => void, ms: number) => {
		const id = ++this.ids;
		this.queue.push({ at: this.t + ms, fn, id });
		return id;
	};
	clearTimeout = (h: unknown) => {
		this.queue = this.queue.filter((q) => q.id !== h);
	};
	/** Advance time, firing due timers in order (timers they set fire too if due). */
	async advance(ms: number) {
		const end = this.t + ms;
		for (;;) {
			this.queue.sort((a, b) => a.at - b.at);
			const next = this.queue[0];
			if (!next || next.at > end) break;
			this.queue.shift();
			this.t = Math.max(this.t, next.at);
			next.fn();
			await Promise.resolve();
		}
		this.t = end;
		await new Promise((r) => setTimeout(r, 0));
	}
}

class FakeSocket implements RoomSocket {
	sent: (string | Uint8Array)[] = [];
	closed: { code: number; reason: string } | null = null;
	send(data: string | Uint8Array) {
		this.sent.push(data);
	}
	close(code: number, reason: string) {
		this.closed ??= { code, reason };
	}
	json(): ServerMessage[] {
		return this.sent.flatMap((d) => (typeof d === 'string' ? [parseServerMessage(d)!] : []));
	}
	has(t: ServerMessage['t']) {
		return this.json().some((m) => m.t === t);
	}
	snapshots() {
		return this.sent.filter((d): d is Uint8Array => typeof d !== 'string').map(decodeSnapshot);
	}
}

class FakeWorker implements WorkerApi {
	grants: RewardGrant[] = [];
	recorded = 0;
	async grant(g: RewardGrant) {
		this.grants.push(g);
		return { status: 'granted' as const, coins: g.coins, best: g.score, prevBest: 0 };
	}
	async recordMatch() {
		this.recorded += 1;
	}
}

function setup(store = new MemoryStore(), clock = new Clock()) {
	const worker = new FakeWorker();
	const logs: Record<string, unknown>[] = [];
	const rooms = new Rooms({ store, worker, log: (f) => logs.push(f), timers: clock });
	return { store, clock, worker, logs, rooms };
}

const claim = (uid: string, clock: Clock): SeatClaim => ({ uid, name: `n-${uid}`, runes: [], iat: clock.t });
const coreOf = (rooms: Rooms) => (rooms.get(MATCH) as unknown as { core: MatchCore }).core;

async function runningMatch() {
	const s = setup();
	const room = s.rooms.open(MATCH);
	const a = new FakeSocket();
	const b = new FakeSocket();
	const ca = room.join(a, claim('ua', s.clock))!;
	room.join(b, claim('ub', s.clock));
	await s.clock.advance(WAIT_MS + 10);
	return { ...s, room, a, b, ca };
}

describe('Room on the standalone server', () => {
	it('starts after the lobby wait and streams snapshots at the tick rate', async () => {
		const { room, a, clock } = await runningMatch();
		expect(room.state).toBe('running');
		expect(a.has('start')).toBe(true);
		const before = a.snapshots().length;
		await clock.advance(10 * TICK_MS);
		expect(a.snapshots().length - before).toBeGreaterThanOrEqual(9);
	});

	it('closes a flooding socket with Close.Flood and keeps the match for the others', async () => {
		const { room, a, b, ca, clock } = await runningMatch();
		for (let i = 0; i < 300 && room.message(ca, '{}'); i++);
		expect(a.closed?.code).toBe(Close.Flood);
		await clock.advance(5 * TICK_MS);
		expect(b.closed).toBeNull();
		expect(room.state).toBe('running');
	});

	it('survives a restart: checkpoint, close 1012, restore from the store, rejoin the same seat', async () => {
		const { rooms, a, store, clock } = await runningMatch();
		await clock.advance(30 * TICK_MS);
		const tickBefore = coreOf(rooms).world!.tick;
		rooms.shutdown();
		expect(a.closed?.code).toBe(CLOSE_RESTART);

		const next = setup(store, clock);
		expect(next.rooms.restore(clock.t)).toBe(1);
		const room = next.rooms.get(MATCH)!;
		expect(room.state).toBe('running');
		expect(coreOf(next.rooms).world!.tick).toBe(tickBefore);
		const a2 = new FakeSocket();
		expect(room.join(a2, { ...claim('ua', clock), iat: clock.t - 10 * 60_000 })).not.toBeNull();
		expect(a2.has('start')).toBe(true);
	});

	it('pays every seat through the Worker, then forgets the room and its storage', async () => {
		const { rooms, worker, store, clock, a } = await runningMatch();
		coreOf(rooms).fastForward();
		await clock.advance(END_LINGER_MS + 10);
		expect(worker.grants.map((g) => g.uid).sort()).toEqual(['ua', 'ub']);
		expect(worker.recorded).toBe(1);
		expect(a.has('result')).toBe(true);
		await clock.advance(CLEANUP_AFTER_END_MS + 10);
		expect(rooms.get(MATCH)).toBeUndefined();
		expect(store.rooms.size).toBe(0);
	});

	it('drops stored rooms too old to still be playing', () => {
		const { store, clock } = setup();
		const s = setup(store, clock);
		s.rooms.open(MATCH).join(new FakeSocket(), claim('ua', clock));
		expect(store.rooms.size).toBe(1);
		expect(setup(store, clock).rooms.restore(clock.t + STALE_ROOM_MS + 1)).toBe(0);
		expect(store.rooms.size).toBe(0);
	});
});

describe('admit', () => {
	const secret = 'ticket-secret';
	const ticket = (over: Record<string, unknown> = {}) =>
		signToken(secret, { typ: 'ticket', sub: 'u1', mid: MATCH, name: 'n', runes: ['r'], iat: T0, exp: T0 + 60_000, ...over } as never);
	const query = async (over: Record<string, string> = {}) => new URLSearchParams({ ticket: await ticket(), v: String(PROTOCOL_VERSION), h: DATA_HASH, ...over });
	const base = { matchId: MATCH, upgrade: 'websocket' as string | null, origin: 'https://game.test' as string | null, allowedOrigins: ['https://game.test'], ticketSecret: secret, now: T0 };

	it('admits a valid ticket and hands back the seat claim', async () => {
		expect(await admit({ ...base, query: await query() })).toEqual({ ok: true, claim: { uid: 'u1', name: 'n', runes: ['r'], iat: T0 } });
		expect((await admit({ ...base, origin: null, query: await query() })).ok).toBe(true);
	});

	it('refuses in the Worker order: upgrade, id, origin, version, ticket', async () => {
		const status = async (over: Partial<typeof base> & { query?: URLSearchParams }) => {
			const r = await admit({ ...base, query: await query(), ...over });
			return r.ok ? 200 : r.status;
		};
		expect(await status({ upgrade: null })).toBe(426);
		expect(await status({ matchId: 'short' })).toBe(404);
		expect(await status({ origin: 'https://evil.test' })).toBe(403);
		expect(await status({ query: await query({ v: '999' }) })).toBe(409);
		expect(await status({ query: await query({ h: 'nope' }) })).toBe(409);
		expect(await status({ query: await query({ ticket: 'garbage' }) })).toBe(401);
		expect(await status({ query: new URLSearchParams({ ticket: await ticket({ mid: 'cd'.repeat(32) }), v: String(PROTOCOL_VERSION), h: DATA_HASH }) })).toBe(401);
		expect(await status({ query: new URLSearchParams({ ticket: await ticket({ exp: T0 - 1 }), v: String(PROTOCOL_VERSION), h: DATA_HASH }) })).toBe(401);
		expect(await status({ ticketSecret: 'other' })).toBe(401);
	});
});

describe('WorkerClient', () => {
	it('signs the exact body it sends to the internal routes', async () => {
		const calls: { url: string; body: string; sig: string | null }[] = [];
		const fetchFn = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: init.body as string, sig: new Headers(init.headers).get('X-OFA-Sig') });
			return Response.json({ status: 'granted', coins: 1, best: 2, prevBest: 0 });
		}) as unknown as typeof fetch;
		const w = new WorkerClient('https://worker.test', 'internal', fetchFn);
		const g: RewardGrant = { matchId: MATCH, uid: 'u', score: 2, coins: 1, result: { placement: 1, kills: 0, level: 1, time: 1, leftEarly: false } };
		expect(await w.grant(g)).toMatchObject({ status: 'granted' });
		expect(calls[0]!.url).toBe(`https://worker.test${API.internalGrant}`);
		expect(await verifyInternal('internal', calls[0]!.sig, calls[0]!.body, Date.now())).toBe(true);
		expect(await signInternal('internal', calls[0]!.body, 0)).not.toBe(calls[0]!.sig);
	});

	it('throws on a non-2xx answer so the core retries the grant', async () => {
		const w = new WorkerClient('https://worker.test', 'internal', (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
		await expect(w.recordMatch({ matchId: MATCH, seed: 1, startedAt: 1, endedAt: 2, durationS: 1, humans: 1, winnerUid: null })).rejects.toThrow('500');
	});
});

describe('readConfig', () => {
	const env = { TICKET_SECRET: 't', INTERNAL_SECRET: 'i', WORKER_ORIGIN: 'https://w.test/', ALLOWED_ORIGINS: 'https://a.test, https://b.test' };

	it('reads the environment with defaults', () => {
		expect(readConfig(env)).toMatchObject({ host: '127.0.0.1', port: 8080, workerOrigin: 'https://w.test', allowedOrigins: ['https://a.test', 'https://b.test'], dataDir: '', maxConnectionsPerIp: 32 });
	});

	it('refuses to start without the secrets', () => {
		expect(() => readConfig({ ...env, TICKET_SECRET: '' })).toThrow('TICKET_SECRET');
		expect(() => readConfig({ ...env, INTERNAL_SECRET: undefined })).toThrow('INTERNAL_SECRET');
	});
});
