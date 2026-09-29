import {
	TICK_MS,
	decodeInput,
	encodeSnapshot,
	frameToCommands,
	pickFocus,
	quantizeDir,
	type InputFrame,
	type ResultMessage,
	type StartMessage
} from '@ofa/net';
import { createWorld, step, type Fighter, type GameEvent, type World } from '@ofa/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from './api';
import type { SocketLike } from './connection';
import { OnlineMatch, type OnlineCallbacks } from './onlineMatch';

class FakeSocket implements SocketLike {
	binaryType = 'blob';
	readyState = 0;
	readonly sent: unknown[] = [];
	closedWith: { code?: number; reason?: string } | null = null;
	onopen: SocketLike['onopen'] = null;
	onmessage: SocketLike['onmessage'] = null;
	onclose: SocketLike['onclose'] = null;
	onerror: SocketLike['onerror'] = null;
	constructor(readonly url: string) {}
	send(data: unknown) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.readyState = 3;
		this.closedWith = { code, reason };
	}
	accept() {
		this.readyState = 1;
		this.onopen?.({});
	}
	message(data: unknown) {
		this.onmessage?.({ data });
	}
	drop(code: number, reason = '') {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	json(v: unknown) {
		this.message(JSON.stringify(v));
	}
	get frames(): InputFrame[] {
		return this.sent.filter((x): x is Uint8Array => x instanceof Uint8Array).map((b) => decodeInput(b)!);
	}
	get texts(): unknown[] {
		return this.sent.filter((x): x is string => typeof x === 'string' && x !== 'ping').map((x) => JSON.parse(x));
	}
}

interface Record {
	lobbies: { players: { name: string; you: boolean }[]; max: number; startsInMs: number | null }[];
	starts: number;
	events: { at: number; events: readonly GameEvent[] }[];
	died: number;
	results: ResultMessage[];
	ends: (number | null)[];
	conns: string[];
	errors: { code: string; message: string }[];
}

function harness() {
	const sockets: FakeSocket[] = [];
	const quickplay = vi.fn(async () => ({ matchId: 'a'.repeat(64), ticket: `tk${sockets.length}` }));
	const api = { quickplay, wsUrl: (id: string, t: string) => `ws://fake/${id}?ticket=${t}` } as unknown as ApiClient;
	const rec: Record = { lobbies: [], starts: 0, events: [], died: 0, results: [], ends: [], conns: [], errors: [] };
	const cb: OnlineCallbacks = {
		onLobby: (l) => rec.lobbies.push(l),
		onStart: () => rec.starts++,
		onEvents: (events) => rec.events.push({ at: Date.now(), events }),
		onSelfDied: () => rec.died++,
		onResult: (r) => rec.results.push(r),
		onEnd: (w) => rec.ends.push(w),
		onConnection: (s) => rec.conns.push(s),
		onError: (code, message) => rec.errors.push({ code, message })
	};
	const match = new OnlineMatch(api, cb, {
		createSocket: (url) => {
			const s = new FakeSocket(url);
			sockets.push(s);
			return s;
		},
		now: () => Date.now()
	});
	return { match, sockets, quickplay, rec, sock: () => sockets[sockets.length - 1] };
}
type Harness = ReturnType<typeof harness>;

const SEQ_STEP_MS = 16;

/**
 * The server side of a match: a real sim world, the input queue of §5.6 and 20 Hz snapshots, with a
 * fixed one-way latency in both directions. Driven by advance(), which also runs the client's frames.
 */
class ServerSim {
	readonly world: World;
	readonly me: number;
	latency = 60;
	/** Reported as the input queue length instead of the real one, to steer the client's tick rate. */
	queueReport: number | null = null;
	/** Events added to the next snapshot (the encoder still filters them by visibility). */
	extraEvents: GameEvent[] = [];
	private readonly inbox: { at: number; frame: InputFrame }[] = [];
	private readonly outbox: { at: number; bytes: ArrayBuffer }[] = [];
	private readonly queue: InputFrame[] = [];
	private read = 0;
	private ack = 0;
	private sinceAck = 0;
	private nextTick = 0;
	private paused = false;
	lastFrame: ReturnType<OnlineMatch['frame']> = null;

	constructor(
		private readonly h: Harness,
		seed = 7
	) {
		const { world, playerId } = createWorld({ seed, fighters: 12, humans: [{ name: 'me' }] });
		this.world = world;
		this.me = playerId!;
		// Nothing here should kill the player: these tests are about the wire, not combat.
		this.fighter.hp = this.fighter.maxHp = 1e6;
	}

	get fighter(): Fighter {
		return this.world.fighters.find((f) => f.id === this.me)!;
	}

	get startMessage(): StartMessage {
		return {
			t: 'start',
			matchId: 'm',
			tick: this.world.tick,
			you: this.me,
			fighters: this.world.fighters.map((f) => ({ id: f.id, name: f.name, color: f.color, human: f.bot === null }))
		};
	}

	/** quickplay → open → start + self, as the room does when the match is running. */
	async connect(): Promise<FakeSocket> {
		await this.h.match.start();
		const s = this.h.sock();
		s.accept();
		this.sendStart();
		return s;
	}

	sendStart(): void {
		const s = this.h.sock();
		s.json(this.startMessage);
		s.json({
			t: 'self',
			items: [...this.fighter.items],
			runes: [...this.fighter.runes],
			offer: this.fighter.offer,
			pendingDrafts: this.fighter.pendingDrafts,
			rerolls: this.fighter.rerolls,
			exchangeTokens: this.fighter.exchangeTokens
		});
		this.nextTick = Date.now();
	}

	/** Stops sending snapshots (a network stall) without disconnecting. */
	pause(on: boolean): void {
		this.paused = on;
		if (!on) this.nextTick = Date.now();
	}

	advance(ms: number): ReturnType<OnlineMatch['frame']> {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			vi.advanceTimersByTime(Math.min(SEQ_STEP_MS, end - Date.now()));
			const now = Date.now();
			this.pump(now);
			this.lastFrame = this.h.match.frame(now);
		}
		return this.lastFrame;
	}

	private pump(now: number): void {
		const s = this.h.sock();
		for (; this.read < s.sent.length; this.read++) {
			const f = s.sent[this.read];
			if (f instanceof Uint8Array) this.inbox.push({ at: now + this.latency, frame: decodeInput(f)! });
		}
		while (!this.paused && this.nextTick <= now) {
			while (this.inbox.length && this.inbox[0].at <= this.nextTick) this.queue.push(this.inbox.shift()!.frame);
			const frame = this.queue.shift();
			if (frame) {
				this.ack = frame.seq;
				this.sinceAck = 0;
			} else this.sinceAck++;
			step(this.world, new Map(frame ? [[this.me, frameToCommands(frame)]] : []));
			const bytes = encodeSnapshot(this.world, [...this.world.events, ...this.extraEvents], {
				focusId: pickFocus(this.world, this.me, null),
				selfId: this.me,
				ack: this.ack,
				sinceAck: this.sinceAck,
				inputQueue: this.queueReport ?? this.queue.length
			});
			this.extraEvents = [];
			this.outbox.push({ at: this.nextTick + this.latency, bytes: bytes.slice().buffer });
			this.nextTick += TICK_MS;
		}
		while (this.outbox.length && this.outbox[0].at <= now) s.message(this.outbox.shift()!.bytes);
	}
}

async function running(seed?: number) {
	const h = harness();
	const srv = new ServerSim(h, seed);
	const sock = await srv.connect();
	return { h, srv, sock, m: h.match, rec: h.rec };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('OnlineMatch lobby and start', () => {
	it('quickplays, connects to the ticketed URL and reports the lobby countdown', async () => {
		const h = harness();
		expect(h.match.phase).toBe('idle');
		await h.match.start();
		expect(h.match.phase).toBe('connecting');
		expect(h.quickplay).toHaveBeenCalledTimes(1);
		expect(h.sock().url).toBe(`ws://fake/${'a'.repeat(64)}?ticket=tk0`);
		h.sock().accept();
		h.sock().json({ t: 'lobby', matchId: 'm', players: [{ name: 'me', you: true }, { name: 'Bo', you: false }], max: 12, startsAt: 20_000, serverNow: 5_000 });
		expect(h.match.phase).toBe('waiting');
		expect(h.rec.lobbies).toEqual([{ players: [{ name: 'me', you: true }, { name: 'Bo', you: false }], max: 12, startsInMs: 15_000 }]);
		h.sock().json({ t: 'lobby', matchId: 'm', players: [{ name: 'me', you: true }], max: 12, startsAt: null, serverNow: 5_100 });
		expect(h.rec.lobbies[1].startsInMs).toBeNull();
		// A countdown that already passed never goes negative.
		h.sock().json({ t: 'lobby', matchId: 'm', players: [], max: 12, startsAt: 4_000, serverNow: 5_000 });
		expect(h.rec.lobbies[2].startsInMs).toBe(0);
	});

	it('runs on start: roster, own id, and nothing to draw until a snapshot arrives', async () => {
		const { srv, m, rec } = await running();
		expect(m.phase).toBe('running');
		expect(m.selfId).toBe(srv.me);
		expect(rec.starts).toBe(1);
		expect(m.frame(Date.now())).toBeNull();
		const f = srv.advance(200);
		expect(f).not.toBeNull();
		expect(f!.me!.name).toBe('me');
		expect(f!.world.roster.size).toBe(12);
		expect(f!.focusId).toBe(srv.me);
		expect(f!.focus).toBe(f!.me);
	});

	it('ignores malformed messages', async () => {
		const { srv, sock, m } = await running();
		sock.message('not json');
		sock.message('{"t":"nope"}');
		sock.message(new Uint8Array([2, 1, 2]).buffer);
		expect(srv.advance(200)).not.toBeNull();
		expect(m.phase).toBe('running');
	});
});

describe('OnlineMatch commands and local ticks', () => {
	it('sends one frame per tick (also standing still) with strictly increasing seq from 1', async () => {
		const { srv, sock } = await running();
		srv.advance(1000);
		const frames = sock.frames;
		expect(frames.length).toBeGreaterThanOrEqual(18);
		expect(frames.length).toBeLessThanOrEqual(20);
		expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
		expect(frames.every((f) => f.move === null && !f.run && !f.attack && f.dash === null)).toBe(true);
	});

	it('turns commands into frames: held move and one-shots exactly once', async () => {
		const { srv, sock, m } = await running();
		srv.advance(200);
		const before = sock.frames.length;
		const dir = { x: 0.6, y: -0.8 };
		m.command({ type: 'move', dir, run: true });
		srv.advance(200);
		m.command({ type: 'attack' });
		m.command({ type: 'dash', dir: { x: -1, y: 0 }, touch: true });
		m.command({ type: 'draft', index: 1 });
		m.command({ type: 'reroll' });
		m.command({ type: 'exchange', itemIndex: 3 });
		srv.advance(120);
		m.command({ type: 'move', dir: null, run: false });
		srv.advance(200);

		const frames = sock.frames.slice(before);
		const q = quantizeDir(dir);
		const moving = frames.filter((f) => f.move !== null);
		expect(moving.length).toBeGreaterThanOrEqual(5);
		for (const f of moving) {
			expect(f.move).toEqual(q);
			expect(f.run).toBe(true);
		}
		const shots = frames.filter((f) => f.attack);
		expect(shots).toHaveLength(1);
		expect(shots[0]).toMatchObject({ dash: quantizeDir({ x: -1, y: 0 }), dashTouch: true, draft: 1, reroll: true, exchange: 3 });
		expect(frames.filter((f) => f.dash !== null || f.draft !== null || f.reroll || f.exchange !== null)).toHaveLength(1);
		const last = frames[frames.length - 1];
		expect(last.move).toBeNull();
		expect(last.run).toBe(false);
	});

	it('sends a plain dash without touch and an untouched frame carries no one-shots', async () => {
		const { srv, sock, m } = await running();
		srv.advance(100);
		m.command({ type: 'dash', dir: { x: 0, y: 1 } });
		srv.advance(100);
		const dash = sock.frames.filter((f) => f.dash !== null);
		expect(dash).toHaveLength(1);
		expect(dash[0].dashTouch).toBe(false);
	});

	it('runs local ticks at 50 ms when the server queue is at target and dilates with a deep queue', async () => {
		const { srv, sock, m } = await running();
		srv.queueReport = 1;
		srv.advance(2000);
		expect(m.netStats().tickMs).toBeCloseTo(50, 5);
		let n = sock.frames.length;
		srv.advance(10_000);
		expect(sock.frames.length - n).toBeGreaterThanOrEqual(198);
		expect(sock.frames.length - n).toBeLessThanOrEqual(200);

		// Frames pile up on the server: send slower, capped at +5 %.
		srv.queueReport = 6;
		srv.advance(3000);
		expect(m.netStats().tickMs).toBeCloseTo(52.5, 1);
		expect(m.netStats().inputQueue).toBe(6);
		n = sock.frames.length;
		srv.advance(10_500);
		const sent = sock.frames.length - n;
		expect(sent).toBeGreaterThanOrEqual(198);
		expect(sent).toBeLessThanOrEqual(201);

		// And an empty queue speeds up.
		srv.queueReport = 0;
		srv.advance(4000);
		expect(m.netStats().tickMs).toBeLessThan(49.5);
		expect(m.netStats().tickMs).toBeGreaterThanOrEqual(49);
	});

	it('caps catch-up at five ticks after a long stall', async () => {
		const { srv, sock, m } = await running();
		srv.advance(500);
		const before = sock.frames.length;
		vi.advanceTimersByTime(3000);
		m.frame(Date.now());
		expect(sock.frames.length - before).toBe(5);
		// The backlog was dropped rather than replayed on later frames.
		vi.advanceTimersByTime(16);
		m.frame(Date.now());
		expect(sock.frames.length - before).toBe(5);
	});

	it('ignores one-shot commands outside a running match', async () => {
		const h = harness();
		await h.match.start();
		h.sock().accept();
		h.match.command({ type: 'attack' });
		const srv = new ServerSim(h);
		srv.sendStart();
		srv.advance(300);
		expect(h.sock().frames.some((f) => f.attack)).toBe(false);
	});
});

describe('OnlineMatch prediction', () => {
	it('moves the drawn fighter right away, before the server has seen the input', async () => {
		const { srv, m } = await running();
		srv.latency = 300;
		const start = srv.advance(400)!.me!.pos;
		const x0 = start.x;
		const y0 = start.y;
		m.command({ type: 'move', dir: { x: 1, y: 0 }, run: true });
		const f = srv.advance(150)!;
		const serverPos = srv.fighter.pos;
		expect(Math.hypot(f.me!.pos.x - x0, f.me!.pos.y - y0)).toBeGreaterThan(0.5);
		expect(Math.hypot(serverPos.x - x0, serverPos.y - y0)).toBeLessThan(0.01);
	});

	it('tracks the server within 0.05 units once movement stops, through dashes and direction changes', async () => {
		const { srv, m } = await running();
		srv.latency = 80;
		srv.advance(500);
		m.command({ type: 'move', dir: { x: 1, y: 0.3 }, run: true });
		srv.advance(1500);
		m.command({ type: 'dash', dir: { x: 0, y: 1 }, touch: true });
		srv.advance(400);
		m.command({ type: 'move', dir: { x: -0.7, y: -0.7 }, run: false });
		srv.advance(1500);
		m.command({ type: 'attack' });
		m.command({ type: 'move', dir: null, run: false });
		const f = srv.advance(3000)!;
		const truth = srv.fighter.pos;
		expect(Math.hypot(f.me!.pos.x - truth.x, f.me!.pos.y - truth.y)).toBeLessThan(0.05);
		// It really went somewhere.
		expect(Math.hypot(truth.x, truth.y)).toBeGreaterThan(5);
	});

	it('stays within a small distance of the server while moving with jittery latency', async () => {
		const { srv, m } = await running();
		srv.advance(500);
		m.command({ type: 'move', dir: { x: 0, y: -1 }, run: true });
		let worst = 0;
		for (let i = 0; i < 30; i++) {
			srv.latency = 40 + (i % 4) * 20;
			const f = srv.advance(100)!;
			// The server is behind by its latency, so compare with where it will be after one round trip.
			const ahead = Math.abs(f.me!.pos.y - srv.fighter.pos.y);
			worst = Math.max(worst, ahead);
		}
		expect(worst).toBeLessThan(2.5);
	});
});

describe('OnlineMatch events', () => {
	const other = (srv: ServerSim) => srv.world.fighters.find((f) => f.id !== srv.me && f.bot !== null)!;

	it('delivers own events on arrival and everyone else at render time, once and in order', async () => {
		const { srv, m, rec } = await running();
		srv.advance(500);
		rec.events.length = 0;
		const bot = other(srv);
		const near = { x: srv.fighter.pos.x + 3, y: srv.fighter.pos.y };
		const mine: GameEvent = { type: 'attack', unit: srv.me, pos: near, facing: { x: 1, y: 0 }, radius: 2, arc: 1, combo: 1 };
		const hitByMe: GameEvent = { type: 'hit', target: bot.id, src: srv.me, amount: 5, crit: false, pos: near };
		const theirs: GameEvent = { type: 'attack', unit: bot.id, pos: near, facing: { x: 0, y: 1 }, radius: 2, arc: 1, combo: 1 };
		const hitOnMe: GameEvent = { type: 'hit', target: srv.me, src: bot.id, amount: 3, crit: false, pos: near };
		srv.extraEvents = [theirs, mine, hitOnMe, hitByMe];
		// Advance to the moment the snapshot arrives.
		const t0 = Date.now();
		while (rec.events.length === 0) srv.advance(SEQ_STEP_MS);
		const arrival = Date.now();
		expect(rec.events[0].events).toMatchObject([
			{ type: 'attack', unit: srv.me },
			{ type: 'hit', src: srv.me, target: bot.id }
		]);
		expect(arrival - t0).toBeLessThan(200);

		while (rec.events.length < 2 && Date.now() - arrival < 1000) srv.advance(SEQ_STEP_MS);
		expect(rec.events).toHaveLength(2);
		expect(rec.events[1].events).toMatchObject([
			{ type: 'attack', unit: bot.id },
			{ type: 'hit', src: bot.id, target: srv.me }
		]);
		// Held back by roughly the interpolation delay (2 ticks) at least.
		expect(rec.events[1].at - arrival).toBeGreaterThanOrEqual(80);
		srv.advance(1000);
		expect(rec.events.flatMap((e) => e.events).filter((e) => e.type === 'attack' && e.unit === bot.id)).toHaveLength(1);
		expect(m.phase).toBe('running');
	});

	it('keeps global events for render time (phase and death)', async () => {
		const { srv, rec } = await running();
		srv.advance(500);
		rec.events.length = 0;
		const bot = other(srv);
		const death: GameEvent = { type: 'death', unit: bot.id, kind: 'fighter', killer: null, pos: { x: 0, y: 0 } };
		srv.extraEvents = [death];
		srv.advance(1000);
		expect(rec.events.flatMap((e) => e.events)).toContainEqual(death);
	});

	it('does not replay events when a snapshot tick repeats', async () => {
		const { srv, sock, rec } = await running();
		srv.advance(300);
		rec.events.length = 0;
		const near = { x: srv.fighter.pos.x + 3, y: srv.fighter.pos.y };
		const mine: GameEvent = { type: 'attack', unit: srv.me, pos: near, facing: { x: 1, y: 0 }, radius: 2, arc: 1, combo: 1 };
		const bytes = encodeSnapshot(srv.world, [mine], { focusId: srv.me, selfId: srv.me, ack: 0, sinceAck: 0, inputQueue: 1 });
		const ab = bytes.slice().buffer;
		sock.message(ab);
		sock.message(ab);
		expect(rec.events.flatMap((e) => e.events).filter((e) => e === mine || e.type === 'attack' && e.unit === srv.me)).toHaveLength(1);
	});
});

describe('OnlineMatch self death, result and end', () => {
	it('reports the own death once and stops sending input', async () => {
		const { srv, sock, m, rec } = await running();
		srv.advance(500);
		expect(rec.died).toBe(0);
		srv.fighter.alive = false;
		const f = srv.advance(500)!;
		expect(rec.died).toBe(1);
		expect(m.phase).toBe('running');
		expect(f.me).toBeUndefined();
		const n = sock.frames.length;
		srv.advance(500);
		expect(sock.frames.length).toBe(n);
		expect(rec.died).toBe(1);
		// Focus moves to someone still alive.
		expect(srv.lastFrame!.focus).toBeDefined();
		expect(srv.lastFrame!.focusId).not.toBe(srv.me);
	});

	it('hands the result to the callback and sends RTT stats once', async () => {
		const { srv, sock, m, rec } = await running();
		srv.advance(500);
		// Pings go out at 2 s and 4 s; the pongs come 40 and 60 ms later.
		vi.advanceTimersByTime(1500);
		vi.advanceTimersByTime(40);
		sock.message('pong');
		vi.advanceTimersByTime(1960);
		vi.advanceTimersByTime(60);
		sock.message('pong');
		const result: ResultMessage = {
			t: 'result', placement: 3, kills: 2, level: 4, time: 61, reward: null, coins: 12, best: 3, newBest: true, rewardPending: false
		};
		sock.json(result);
		sock.json(result);
		expect(rec.results).toEqual([result, result]);
		const stats = sock.texts.filter((t) => (t as { t: string }).t === 'stats');
		expect(stats).toHaveLength(1);
		expect(stats[0]).toEqual({ t: 'stats', rtt: { p50: 40, p95: 60, n: 2 } });
		expect(m.netStats()).toMatchObject({ rttP50: 40, rttP95: 60 });
	});

	it('ends the match on `end`', async () => {
		const { srv, sock, m, rec } = await running();
		srv.advance(300);
		sock.json({ t: 'end', winner: 5 });
		expect(m.phase).toBe('ended');
		expect(rec.ends).toEqual([5]);
		// The last picture stays available but no more input goes out.
		const n = sock.frames.length;
		expect(srv.advance(300)).not.toBeNull();
		expect(sock.frames.length).toBe(n);
		sock.drop(1000);
		expect(rec.errors).toEqual([]);
	});

	it('leave() tells the server, closes normally and ends', async () => {
		const { srv, sock, m, rec } = await running();
		srv.advance(300);
		m.leave();
		expect(sock.texts).toContainEqual({ t: 'leave' });
		expect(sock.closedWith?.code).toBe(1000);
		expect(m.phase).toBe('ended');
		sock.drop(1000);
		expect(rec.errors).toEqual([]);
	});
});

describe('OnlineMatch spectating', () => {
	it('spectate() forwards the request', async () => {
		const { sock, m } = await running();
		m.spectate(4);
		expect(sock.texts).toContainEqual({ t: 'spectate', id: 4 });
	});

	it('spectateNext() walks the living fighters by id, skipping the dead and wrapping', async () => {
		const { srv, sock, m } = await running();
		const ids = srv.world.fighters.map((f) => f.id).sort((a, b) => a - b);
		srv.extraEvents = [{ type: 'death', unit: ids[1], kind: 'fighter', killer: null, pos: { x: 0, y: 0 } }];
		srv.advance(600);
		const asked = () => sock.texts.filter((t) => (t as { t: string }).t === 'spectate').map((t) => (t as { id: number }).id);
		// Focus starts on the own fighter (ids[0]); ids[1] is dead so ids[2] is next.
		m.spectateNext();
		m.spectateNext();
		m.spectateNext();
		expect(asked()).toEqual([ids[2], ids[3], ids[4]]);
		m.spectate(ids[ids.length - 1]);
		m.spectateNext();
		expect(asked().slice(-1)).toEqual([ids[0]]);
	});
});

describe('OnlineMatch errors and retries', () => {
	it('retries a 4003 with a fresh quickplay, three times at most', async () => {
		const h = harness();
		await h.match.start();
		for (let i = 1; i <= 3; i++) {
			h.sock().accept();
			h.sock().drop(4003);
			await vi.advanceTimersByTimeAsync(0);
			expect(h.quickplay).toHaveBeenCalledTimes(i + 1);
			expect(h.sockets).toHaveLength(i + 1);
			expect(h.rec.errors).toEqual([]);
			expect(h.match.phase).toBe('connecting');
		}
		h.sock().drop(4003);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.quickplay).toHaveBeenCalledTimes(4);
		expect(h.rec.errors.map((e) => e.code)).toEqual(['started']);
		expect(h.match.phase).toBe('error');
	});

	it.each([
		[4002, 'full'],
		[4004, 'ended'],
		[4006, 'version'],
		[4005, 'server'],
		[4010, 'server'],
		[4001, 'server']
	] as const)('maps close %i to %s', async (code, expected) => {
		const h = harness();
		await h.match.start();
		h.sock().accept();
		h.sock().drop(code, 'why');
		expect(h.rec.errors.map((e) => e.code)).toEqual([expected]);
		expect(h.match.phase).toBe('error');
		expect(h.sockets).toHaveLength(1);
	});

	it('says another tab took over on 4001', async () => {
		const h = harness();
		await h.match.start();
		h.sock().accept();
		h.sock().drop(4001);
		expect(h.rec.errors[0].message).toMatch(/another tab/i);
	});

	it('reports a network error when reconnecting fails for good', async () => {
		const { h, sock } = await running();
		sock.drop(1006);
		expect(h.rec.conns).toEqual(['open', 'reconnecting']);
		// Every retry fails immediately.
		for (let i = 0; i < 12 && h.rec.errors.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(8000);
			h.sock().drop(1006);
		}
		expect(h.rec.errors.map((e) => e.code)).toEqual(['network']);
		expect(h.match.phase).toBe('error');
	});

	it('maps quickplay failures: 401 → unauthorized, anything else → network', async () => {
		const h = harness();
		h.quickplay.mockRejectedValueOnce(new ApiRequestError(401, 'unauthorized', 'no'));
		await h.match.start();
		expect(h.rec.errors.map((e) => e.code)).toEqual(['unauthorized']);
		expect(h.match.phase).toBe('error');

		h.quickplay.mockRejectedValueOnce(new ApiRequestError(429, 'rate_limited', 'slow down'));
		await h.match.start();
		h.quickplay.mockRejectedValueOnce(new ApiRequestError(0, 'network', 'offline'));
		await h.match.start();
		expect(h.rec.errors.map((e) => e.code)).toEqual(['unauthorized', 'network', 'network']);
	});

	it('drops a quickplay answer that arrives after leave()', async () => {
		const h = harness();
		let resolve!: (v: { matchId: string; ticket: string }) => void;
		h.quickplay.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const started = h.match.start();
		h.match.leave();
		resolve({ matchId: 'a'.repeat(64), ticket: 't' });
		await started;
		expect(h.sockets).toHaveLength(0);
		expect(h.match.phase).toBe('ended');
	});
});

describe('OnlineMatch reconnection', () => {
	it('keeps the match across a dropped socket and starts over cleanly on the new start', async () => {
		const { h, srv, sock, m, rec } = await running();
		srv.advance(1000);
		const framesBefore = sock.frames.length;
		expect(framesBefore).toBeGreaterThan(10);

		sock.drop(1006);
		expect(rec.conns).toEqual(['open', 'reconnecting']);
		expect(m.phase).toBe('running');
		await vi.advanceTimersByTimeAsync(500);
		expect(h.sockets).toHaveLength(2);
		expect(h.quickplay).toHaveBeenCalledTimes(1);
		expect(h.sockets[1].url).toBe(sock.url);
		h.sockets[1].accept();
		expect(rec.conns).toEqual(['open', 'reconnecting', 'open']);

		// The room greets a returning player with start + self, then snapshots.
		srv.sendStart();
		expect(rec.starts).toBe(1);
		expect(m.phase).toBe('running');
		expect(m.frame(Date.now())).toBeNull();
		const f = srv.advance(1500)!;
		expect(f.me).toBeDefined();
		// The new connection's frames start at seq 1 again, and the server (which resets lastSeq) still follows.
		const fresh = h.sockets[1].frames;
		expect(fresh.length).toBeGreaterThan(10);
		expect(fresh[0].seq).toBe(1);
		expect(fresh.map((x) => x.seq)).toEqual(fresh.map((_, i) => i + 1));
		m.command({ type: 'move', dir: { x: 0, y: 1 }, run: true });
		srv.advance(1000);
		m.command({ type: 'move', dir: null, run: false });
		const end = srv.advance(2500)!;
		expect(Math.hypot(end.me!.pos.x - srv.fighter.pos.x, end.me!.pos.y - srv.fighter.pos.y)).toBeLessThan(0.05);
		expect(rec.errors).toEqual([]);
	});
});

describe('OnlineMatch net stats', () => {
	it('reports snapshot rate, jitter and RTT percentiles', async () => {
		const { srv, sock, m } = await running();
		expect(m.netStats()).toMatchObject({ rttP50: null, rttP95: null, inputQueue: 0 });
		srv.advance(2500);
		const s = m.netStats();
		expect(s.snapshotsPerSecond).toBeGreaterThanOrEqual(19);
		expect(s.snapshotsPerSecond).toBeLessThanOrEqual(21);
		expect(s.jitterMs).toBeGreaterThanOrEqual(0);
		expect(s.tickMs).toBeGreaterThan(45);
		for (const rtt of [10, 20, 30, 40, 100]) {
			vi.advanceTimersByTime(2000 - rtt);
			vi.advanceTimersByTime(rtt);
			sock.message('pong');
		}
		// The pongs above arrive at 2 s intervals right after each ping went out.
		expect(m.netStats().rttP50).not.toBeNull();
		expect(m.netStats().rttP95!).toBeGreaterThanOrEqual(m.netStats().rttP50!);
	});

	it('dispose() stops everything', async () => {
		const { srv, sock, m } = await running();
		srv.advance(300);
		m.dispose();
		expect(sock.closedWith).not.toBeNull();
		expect(m.phase).toBe('idle');
		expect(m.frame(Date.now())).toBeNull();
	});
});
