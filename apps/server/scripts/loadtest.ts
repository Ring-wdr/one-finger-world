/**
 * Load test and latency measurement (docs/multiplayer-server-design.md §14):
 *
 *   bun apps/server/scripts/loadtest.ts --url http://127.0.0.1:8787 --clients 12 --seconds 60
 *
 * Every client is a guest that quick-plays into the same room, sends an input frame every tick like the
 * real client and records RTT (ping/pong), snapshot spacing, traffic and ack lag. Exits non-zero when
 * a client never got a `start`.
 */
import {
	API,
	DATA_HASH,
	PING,
	PONG,
	PROTOCOL_VERSION,
	TICK_MS,
	decodeSnapshot,
	emptyFrame,
	encodeInput,
	parseServerMessage,
	quantizeDir,
	type GuestResponse,
	type InputFrame,
	type QuickplayResponse,
	type ResultMessage
} from '@ofa/net';

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const baseUrl = flag('url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const clientCount = Number(flag('clients', '12'));
const seconds = Number(flag('seconds', '60'));
if (!Number.isInteger(clientCount) || clientCount < 1 || !(seconds > 0)) {
	console.error('usage: loadtest.ts [--url http://127.0.0.1:8787] [--clients 12] [--seconds 60]');
	process.exit(2);
}

const PING_INTERVAL_MS = 2000;
/** The lobby starts a full room after 1.5 s; anything much longer means the match never began. */
const START_TIMEOUT_MS = 30_000;
/** How long to wait for `result` after `end` before leaving. */
const RESULT_GRACE_MS = 1000;

/** Nearest-rank percentile of an unsorted sample; NaN when empty. */
function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(baseUrl + path, init);
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

class LoadClient {
	readonly rtt: number[] = [];
	readonly intervals: number[] = [];
	readonly ackLag: number[] = [];
	bytesDown = 0;
	bytesUp = 0;
	messagesDown = 0;
	messagesUp = 0;
	snapshots = 0;
	closes: number[] = [];
	result: ResultMessage | null = null;
	error: string | null = null;
	started = false;

	private ws!: WebSocket;
	private seq = 0;
	private offer = false;
	private pingSentAt: number | null = null;
	private lastSnapshotAt: number | null = null;
	private startedAt = 0;
	private endedAt = 0;
	private timers: ReturnType<typeof setInterval>[] = [];
	private direction = { x: 0, y: 0 };
	private directionUntil = 0;
	private finishNow!: () => void;
	private finished = new Promise<void>((resolve) => (this.finishNow = resolve));
	private started$!: () => void;
	private startSignal = new Promise<void>((resolve) => (this.started$ = resolve));

	constructor(readonly index: number) {}

	/** Signs in, joins the lobby and opens the socket; resolves once connected. */
	async connect(): Promise<void> {
		const { token } = await api<GuestResponse>(API.guest, { method: 'POST' });
		const { matchId, ticket } = await api<QuickplayResponse>(API.quickplay, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
		const wsUrl = new URL(baseUrl.replace(/^http/, 'ws') + API.matchWs(matchId));
		wsUrl.search = new URLSearchParams({ ticket, v: String(PROTOCOL_VERSION), h: DATA_HASH }).toString();
		this.ws = new WebSocket(wsUrl);
		this.ws.binaryType = 'arraybuffer';
		this.ws.addEventListener('message', (e) => this.onMessage(e.data as string | ArrayBuffer));
		this.ws.addEventListener('close', (e) => {
			this.closes.push(e.code);
			this.finishNow();
		});
		await new Promise<void>((resolve, reject) => {
			this.ws.addEventListener('open', () => resolve(), { once: true });
			this.ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
		});
	}

	/** Resolves true once the match has started, false when it did not within the timeout. */
	async waitStarted(): Promise<boolean> {
		return Promise.race([this.startSignal.then(() => true), sleep(START_TIMEOUT_MS).then(() => false)]);
	}

	/** Plays until `seconds` pass or the match ends, then leaves and closes. */
	async play(): Promise<void> {
		const deadline = sleep(seconds * 1000);
		await Promise.race([deadline, this.finished]);
		for (const t of this.timers) clearInterval(t);
		this.endedAt = performance.now();
		if (this.ws.readyState === WebSocket.OPEN) {
			this.sendText(JSON.stringify({ t: 'leave' }));
			this.ws.close(1000);
		}
	}

	get durationS(): number {
		return Math.max(0.001, ((this.endedAt || performance.now()) - this.startedAt) / 1000);
	}

	private sendText(text: string): void {
		this.bytesUp += new TextEncoder().encode(text).length;
		this.messagesUp++;
		this.ws.send(text);
	}

	private onMessage(data: string | ArrayBuffer): void {
		const now = performance.now();
		this.messagesDown++;
		if (typeof data !== 'string') {
			this.bytesDown += data.byteLength;
			this.onSnapshot(data, now);
			return;
		}
		this.bytesDown += new TextEncoder().encode(data).length;
		if (data === PONG) {
			if (this.pingSentAt !== null) this.rtt.push(now - this.pingSentAt);
			this.pingSentAt = null;
			return;
		}
		const msg = parseServerMessage(data);
		if (!msg) return;
		switch (msg.t) {
			case 'start':
				if (!this.started) this.begin();
				break;
			case 'self':
				this.offer = msg.offer !== null && msg.offer.length > 0;
				break;
			case 'result':
				this.result = msg;
				break;
			case 'end':
				setTimeout(() => this.finishNow(), RESULT_GRACE_MS);
				break;
		}
	}

	private onSnapshot(data: ArrayBuffer, now: number): void {
		if (!this.started) return;
		const snap = decodeSnapshot(data);
		this.snapshots++;
		if (this.lastSnapshotAt !== null) this.intervals.push(now - this.lastSnapshotAt);
		this.lastSnapshotAt = now;
		if (snap.ack > 0) this.ackLag.push(this.seq - snap.ack);
	}

	private begin(): void {
		this.started = true;
		this.startedAt = performance.now();
		this.started$();
		this.timers.push(setInterval(() => this.sendInput(), TICK_MS));
		this.timers.push(
			setInterval(() => {
				// One ping outstanding at a time; a lost pong just skips a sample.
				if (this.pingSentAt !== null) return;
				this.pingSentAt = performance.now();
				this.sendText(PING);
			}, PING_INTERVAL_MS)
		);
	}

	private sendInput(): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		const now = performance.now();
		if (now >= this.directionUntil) {
			const angle = Math.random() * Math.PI * 2;
			this.direction = quantizeDir({ x: Math.cos(angle), y: Math.sin(angle) });
			this.directionUntil = now + 1000 + Math.random() * 2000;
		}
		const frame: InputFrame = { ...emptyFrame(++this.seq), move: this.direction, run: true, attack: Math.random() < 0.1 };
		if (Math.random() < 0.01) {
			frame.dash = this.direction;
			frame.dashTouch = true;
		}
		if (this.offer) {
			frame.draft = 0;
			this.offer = false;
		}
		const bytes = encodeInput(frame);
		this.bytesUp += bytes.byteLength;
		this.messagesUp++;
		this.ws.send(bytes.slice());
	}
}

const fmt = (v: number, digits = 1): string => (Number.isNaN(v) ? '-' : v.toFixed(digits));

console.log(`loadtest: ${clientCount} clients -> ${baseUrl} for ${seconds}s`);
const clients = Array.from({ length: clientCount }, (_, i) => new LoadClient(i));
await Promise.all(
	clients.map((c) =>
		c.connect().catch((e: unknown) => {
			c.error = e instanceof Error ? e.message : String(e);
		})
	)
);
const started = await Promise.all(clients.map((c) => (c.error ? false : c.waitStarted())));
started.forEach((ok, i) => {
	if (!ok && !clients[i].error) clients[i].error = `no start within ${START_TIMEOUT_MS / 1000}s`;
});
console.log(`${started.filter(Boolean).length}/${clientCount} clients started; playing`);
await Promise.all(clients.map((c) => (c.started ? c.play() : undefined)));
// Let the close handshakes finish before summarising.
await sleep(200);

const columns = ['#', 'rtt p50', 'rtt p95', 'snap p50', 'snap p95', 'snap p99', 'snap max', 'down KB/s', 'up KB/s', 'snap/s', 'ack lag', 'closes', 'result'];
const rows = clients.map((c) => [
	String(c.index),
	fmt(percentile(c.rtt, 50)),
	fmt(percentile(c.rtt, 95)),
	fmt(percentile(c.intervals, 50)),
	fmt(percentile(c.intervals, 95)),
	fmt(percentile(c.intervals, 99)),
	fmt(percentile(c.intervals, 100)),
	fmt(c.bytesDown / 1024 / c.durationS),
	fmt(c.bytesUp / 1024 / c.durationS),
	fmt(c.snapshots / c.durationS),
	fmt(percentile(c.ackLag, 50), 0),
	c.closes.join(',') || '-',
	c.error ? `FAILED: ${c.error}` : c.result ? `#${c.result.placement} k${c.result.kills}` : '-'
]);
const widths = columns.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells: string[]) => cells.map((cell, i) => cell.padStart(widths[i])).join('  ');
console.log(`\n(rtt and snapshot intervals in ms, ack lag in input frames)\n${line(columns)}`);
for (const r of rows) console.log(line(r));

const ok = clients.filter((c) => c.started);
const pool = (pick: (c: LoadClient) => number[]) => ok.flatMap(pick);
const totalDown = ok.reduce((sum, c) => sum + c.bytesDown / 1024 / c.durationS, 0);
const totalUp = ok.reduce((sum, c) => sum + c.bytesUp / 1024 / c.durationS, 0);
const rtt = pool((c) => c.rtt);
const intervals = pool((c) => c.intervals);
console.log(
	`\ntotals over ${ok.length} clients: rtt p50 ${fmt(percentile(rtt, 50))} / p95 ${fmt(percentile(rtt, 95))} ms (n=${rtt.length}), ` +
		`snapshot interval p50 ${fmt(percentile(intervals, 50))} / p95 ${fmt(percentile(intervals, 95))} / p99 ${fmt(percentile(intervals, 99))} / max ${fmt(percentile(intervals, 100))} ms, ` +
		`down ${fmt(totalDown)} KB/s, up ${fmt(totalUp)} KB/s`
);
console.log('go/no-go (design §14): rtt p50 < 40 ms, rtt p95 < 80 ms, snapshot interval p99 < 70 ms with 12 players (RTT is only meaningful over a real mobile link)');

const failed = clients.filter((c) => !c.started);
if (failed.length > 0) {
	console.error(`${failed.length} client(s) failed to start`);
	process.exit(1);
}
process.exit(0);
