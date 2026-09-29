import { PING, PONG } from '@ofa/net';

/** Browser WebSocket wrapper: ping/RTT and reconnect (docs/multiplayer-server-design.md §10.1, §11.7, §11.8). */

/** The slice of WebSocket this module uses, so tests can drive a fake. */
export interface SocketLike {
	binaryType: string;
	readyState: number;
	send(data: string | ArrayBuffer | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export interface ConnectionHandlers {
	onOpen(): void;
	onText(text: string): void;
	onBinary(data: ArrayBuffer): void;
	/** Gave up: a 4xxx close (not retried), or reconnecting failed for 30 s. */
	onClosed(code: number, reason: string): void;
	onReconnecting(attempt: number): void;
}

export interface ConnectionDeps {
	createSocket?: (url: string) => SocketLike;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;
const PING_INTERVAL_MS = 2000;
const MAX_RTT_SAMPLES = 30;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const GIVE_UP_MS = 30_000;

export class MatchConnection {
	private readonly createSocket: (url: string) => SocketLike;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private socket: SocketLike | null = null;
	private pingTimer: unknown = null;
	private reconnectTimer: unknown = null;
	private pingSentAt: number | null = null;
	/** When the current run of failed connections began; null while connected. */
	private failingSince: number | null = null;
	private attempt = 0;
	private readonly samples: number[] = [];

	constructor(
		private readonly url: string,
		private readonly handlers: ConnectionHandlers,
		deps: ConnectionDeps = {}
	) {
		this.createSocket = deps.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
		this.now = deps.now ?? (() => performance.now());
		this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/** Latest RTT samples (ms) from ping/pong, newest last, at most 30. */
	get rtts(): readonly number[] {
		return this.samples;
	}

	open(): void {
		this.connect();
	}

	/** Dropped while the socket is not open. */
	sendBinary(data: Uint8Array): void {
		if (this.socket?.readyState === OPEN) this.socket.send(data);
	}

	sendText(text: string): void {
		if (this.socket?.readyState === OPEN) this.socket.send(text);
	}

	/** No reconnect afterwards, and no handler is called. */
	close(code?: number, reason?: string): void {
		this.stopTimers();
		const s = this.socket;
		this.socket = null;
		s?.close(code, reason);
	}

	private connect(): void {
		const s = this.createSocket(this.url);
		this.socket = s;
		s.binaryType = 'arraybuffer';
		// A replaced socket's late events must not act on the new one.
		s.onopen = () => {
			if (this.socket !== s) return;
			this.failingSince = null;
			this.attempt = 0;
			this.pingSentAt = null;
			this.schedulePing();
			this.handlers.onOpen();
		};
		s.onmessage = (ev) => {
			if (this.socket !== s) return;
			const d = ev.data;
			if (typeof d === 'string') {
				if (d === PONG) this.onPong();
				else this.handlers.onText(d);
			} else if (d instanceof ArrayBuffer) this.handlers.onBinary(d);
		};
		s.onclose = (ev) => {
			if (this.socket !== s) return;
			this.socket = null;
			this.onSocketClosed(ev.code, ev.reason);
		};
	}

	private onSocketClosed(code: number, reason: string): void {
		this.stopTimers();
		if (code === 1000 || (code >= 4000 && code <= 4999)) {
			this.handlers.onClosed(code, reason);
			return;
		}
		const now = this.now();
		this.failingSince ??= now;
		if (now - this.failingSince >= GIVE_UP_MS) {
			this.handlers.onClosed(code, reason);
			return;
		}
		const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
		this.attempt++;
		this.handlers.onReconnecting(this.attempt);
		this.reconnectTimer = this.setTimer(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private schedulePing(): void {
		this.pingTimer = this.setTimer(() => {
			if (this.pingSentAt === null && this.socket?.readyState === OPEN) {
				this.pingSentAt = this.now();
				this.socket.send(PING);
			}
			this.schedulePing();
		}, PING_INTERVAL_MS);
	}

	private onPong(): void {
		if (this.pingSentAt === null) return;
		this.samples.push(this.now() - this.pingSentAt);
		if (this.samples.length > MAX_RTT_SAMPLES) this.samples.shift();
		this.pingSentAt = null;
	}

	private stopTimers(): void {
		if (this.pingTimer !== null) this.clearTimer(this.pingTimer);
		if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
		this.pingTimer = this.reconnectTimer = null;
		this.pingSentAt = null;
	}
}
