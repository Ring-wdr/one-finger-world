import { PING, PONG } from '@ofa/net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchConnection, type ConnectionHandlers, type SocketLike } from './connection';

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
	/** Server side. */
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
}

function setup() {
	const sockets: FakeSocket[] = [];
	const events: string[] = [];
	const texts: string[] = [];
	const binaries: ArrayBuffer[] = [];
	const handlers: ConnectionHandlers = {
		onOpen: () => events.push('open'),
		onText: (t) => texts.push(t),
		onBinary: (d) => binaries.push(d),
		onClosed: (code, reason) => events.push(`closed ${code} ${reason}`),
		onReconnecting: (n) => events.push(`reconnecting ${n}`)
	};
	const conn = new MatchConnection('wss://x/ws', handlers, {
		createSocket: (url) => {
			const s = new FakeSocket(url);
			sockets.push(s);
			return s;
		},
		now: () => Date.now()
	});
	return { conn, sockets, events, texts, binaries, last: () => sockets[sockets.length - 1] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MatchConnection messages', () => {
	it('opens an arraybuffer socket and forwards text and binary, dropping sends until open', () => {
		const t = setup();
		t.conn.open();
		expect(t.last().url).toBe('wss://x/ws');
		expect(t.last().binaryType).toBe('arraybuffer');
		t.conn.sendBinary(new Uint8Array([1]));
		t.conn.sendText('x');
		expect(t.last().sent).toEqual([]);
		t.last().accept();
		expect(t.events).toEqual(['open']);
		t.conn.sendBinary(new Uint8Array([1, 2]));
		t.conn.sendText('hello');
		expect(t.last().sent).toEqual([new Uint8Array([1, 2]), 'hello']);
		t.last().message('{"t":"lobby"}');
		const buf = new Uint8Array([9, 8]).buffer;
		t.last().message(buf);
		expect(t.texts).toEqual(['{"t":"lobby"}']);
		expect(t.binaries).toEqual([buf]);
	});

	it('consumes PONG instead of passing it on', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.last().message(PONG);
		expect(t.texts).toEqual([]);
	});
});

describe('MatchConnection ping', () => {
	it('pings every 2 s, measures the round trip and sends only one ping at a time', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		vi.advanceTimersByTime(1999);
		expect(t.last().sent).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(t.last().sent).toEqual([PING]);
		vi.advanceTimersByTime(30);
		t.last().message(PONG);
		expect(t.conn.rtts).toEqual([30]);
		// Next ping goes out, and stays the only one while it is unanswered.
		vi.advanceTimersByTime(1970);
		expect(t.last().sent).toEqual([PING, PING]);
		vi.advanceTimersByTime(6000);
		expect(t.last().sent).toEqual([PING, PING]);
		t.last().message(PONG);
		expect(t.conn.rtts).toHaveLength(2);
		expect(t.conn.rtts[1]).toBe(6000);
		// An unsolicited pong adds nothing.
		t.last().message(PONG);
		expect(t.conn.rtts).toHaveLength(2);
	});

	it('keeps the latest 30 samples, newest last', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		for (let i = 1; i <= 35; i++) {
			// Ping i goes out at 2000 · i and its pong comes i ms later.
			vi.advanceTimersByTime(2000 - (i - 1));
			vi.advanceTimersByTime(i);
			t.last().message(PONG);
		}
		expect(t.conn.rtts).toHaveLength(30);
		expect(t.conn.rtts[29]).toBe(35);
		expect(t.conn.rtts[0]).toBe(6);
	});
});

describe('MatchConnection reconnect', () => {
	it('retries at 0.5, 1, 2, 4, 8, 8 s and gives up 30 s after the first failure', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.events.length = 0;
		t.last().drop(1006);
		for (const delay of [500, 1000, 2000, 4000, 8000, 8000, 8000]) {
			const before = t.sockets.length;
			vi.advanceTimersByTime(delay - 1);
			expect(t.sockets.length).toBe(before);
			vi.advanceTimersByTime(1);
			expect(t.sockets.length).toBe(before + 1);
			t.last().drop(1006);
		}
		expect(t.events).toEqual([
			'reconnecting 1', 'reconnecting 2', 'reconnecting 3', 'reconnecting 4', 'reconnecting 5', 'reconnecting 6', 'reconnecting 7',
			'closed 1006 '
		]);
		vi.advanceTimersByTime(60_000);
		expect(t.sockets).toHaveLength(8);
	});

	it('starts the schedule over after a successful reconnect', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.last().drop(1006);
		vi.advanceTimersByTime(500);
		t.last().drop(1006);
		vi.advanceTimersByTime(1000);
		t.last().accept();
		t.events.length = 0;
		t.last().drop(1001);
		expect(t.events).toEqual(['reconnecting 1']);
		vi.advanceTimersByTime(500);
		expect(t.sockets).toHaveLength(4);
		t.last().accept();
		expect(t.events).toEqual(['reconnecting 1', 'open']);
		t.conn.sendText('again');
		expect(t.last().sent).toEqual(['again']);
	});

	it.each([[1000], [4002], [4003], [4006], [4999]])('does not retry a %i close', (code) => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.events.length = 0;
		t.last().drop(code, 'why');
		expect(t.events).toEqual([`closed ${code} why`]);
		vi.advanceTimersByTime(60_000);
		expect(t.sockets).toHaveLength(1);
	});

	it('does not ping while reconnecting', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.last().drop(1006);
		vi.advanceTimersByTime(500);
		vi.advanceTimersByTime(3000);
		expect(t.last().sent).toEqual([]);
	});
});

describe('MatchConnection close', () => {
	it('closes the socket without reconnecting or calling back', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.events.length = 0;
		const s = t.last();
		t.conn.close(1000, 'bye');
		expect(s.closedWith).toEqual({ code: 1000, reason: 'bye' });
		s.drop(1000);
		vi.advanceTimersByTime(60_000);
		expect(t.events).toEqual([]);
		expect(t.sockets).toHaveLength(1);
	});

	it('cancels a pending reconnect', () => {
		const t = setup();
		t.conn.open();
		t.last().accept();
		t.last().drop(1006);
		t.conn.close();
		vi.advanceTimersByTime(60_000);
		expect(t.sockets).toHaveLength(1);
	});
});
