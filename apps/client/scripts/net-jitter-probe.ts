/**
 * End-to-end probe for on-screen jitter in online matches. Runs the real client netcode
 * (OnlineMatch → ViewWorldBuilder) against a running server over real WebSockets, "renders" at a
 * fixed frame rate without WebGL, and measures how the drawn positions move frame to frame:
 *
 *   bun apps/client/scripts/net-jitter-probe.ts [--url http://127.0.0.1:8787] [--seconds 20] [--fps 60]
 *                                   [--delay 0] [--jitter 0]
 *
 * --delay/--jitter add a one-way latency of delay + U(0, jitter) ms to each direction (order kept,
 * as on TCP), to stand in for a mobile link. Needs `bun run dev:online` (or a deployed Worker).
 */
import { TICK_MS } from '@ofa/net';
import type { Command, Vec2 } from '@ofa/sim';
import { ApiClient } from '../src/net/api';
import type { SocketLike } from '../src/net/connection';
import { OnlineMatch, type ViewFrame } from '../src/net/onlineMatch';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const origin = flag('url', 'http://127.0.0.1:8787');
const seconds = Number(flag('seconds', '20'));
const fps = Number(flag('fps', '60'));
const delayMs = Number(flag('delay', '0'));
const jitterMs = Number(flag('jitter', '0'));
const FRAME_MS = 1000 / fps;
/** The renderer's camera follow rate (render/Renderer.ts FOLLOW_RATE). */
const FOLLOW_RATE = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Delivers in order, each item no earlier than its own random latency. */
function laggedQueue(deliver: (item: unknown) => void) {
	let last = 0;
	return (item: unknown) => {
		if (delayMs === 0 && jitterMs === 0) return deliver(item);
		const at = Math.max(last, performance.now() + delayMs + Math.random() * jitterMs);
		last = at;
		setTimeout(() => deliver(item), at - performance.now());
	};
}

function laggedSocket(url: string): SocketLike {
	const ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	const fake: SocketLike = {
		binaryType: 'arraybuffer',
		get readyState() {
			return ws.readyState;
		},
		send: (d) => outbound(d),
		close: (c, r) => ws.close(c, r),
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null
	};
	const outbound = laggedQueue((d) => ws.readyState === 1 && ws.send(d as string));
	const inbound = laggedQueue((ev) => fake.onmessage?.(ev as { data: unknown }));
	ws.onopen = (e) => fake.onopen?.(e);
	ws.onmessage = (e) => inbound({ data: e.data });
	ws.onclose = (e) => fake.onclose?.({ code: e.code, reason: e.reason });
	ws.onerror = (e) => fake.onerror?.(e);
	return fake;
}

const memory = new Map<string, string>();
const storage = {
	getItem: (k: string) => memory.get(k) ?? null,
	setItem: (k: string, v: string) => void memory.set(k, v),
	removeItem: (k: string) => void memory.delete(k)
} as unknown as Storage;
const api = new ApiClient({ origin, storage, timeoutMs: 10_000 });
await api.ensureGuest();

let started = false;
const match = new OnlineMatch(
	api,
	{
		onLobby: () => {},
		onStart: () => (started = true),
		onEvents: () => {},
		onSelfDied: () => console.log('[probe] self died'),
		onResult: () => {},
		onEnd: () => {},
		onConnection: () => {},
		onError: (code, msg) => {
			console.error(`[probe] error ${code}: ${msg}`);
			process.exit(1);
		}
	},
	{ createSocket: laggedSocket }
);
void match.start();
const waitStart = performance.now();
while (!started) {
	if (performance.now() - waitStart > 60_000) throw new Error('match never started');
	await sleep(50);
}
console.log(`[probe] match started; sampling ${seconds}s at ${fps} fps, delay ${delayMs} ms + jitter ${jitterMs} ms`);

// ── Inputs: run in a square, a direction per 1.5 s; attack now and then in the second half.
const DIRS: Vec2[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const cmd = (c: Command) => match.command(c);

interface Sample {
	t: number;
	own: Vec2 | null;
	ownFacing: number | null;
	cam: Vec2 | null;
	remoteId: number | null;
	remote: Vec2 | null;
	alpha: number;
	offset: number;
}
const samples: Sample[] = [];
const cam: Vec2 = { x: 0, y: 0 };
let camReady = false;
const predictor = (match as unknown as { predictor: { offset: Vec2 } }).predictor;
let remoteId: number | null = null;

const lerp = (f: ViewFrame, id: number, p: Vec2): Vec2 => {
	const a = f.prev.get(id);
	return a ? { x: a.x + (p.x - a.x) * f.alpha, y: a.y + (p.y - a.y) * f.alpha } : { x: p.x, y: p.y };
};

const t0 = performance.now();
let next = t0;
let dirIndex = -1;
while (performance.now() - t0 < seconds * 1000) {
	const now = performance.now();
	const el = now - t0;
	const di = Math.floor(el / 1500) % DIRS.length;
	if (di !== dirIndex) {
		dirIndex = di;
		cmd({ type: 'move', dir: DIRS[di], run: true });
	}
	if (el > (seconds * 1000) / 2 && Math.floor(el / 700) !== Math.floor((el - FRAME_MS) / 700)) cmd({ type: 'attack' });

	const f = match.frame(now);
	if (f) {
		const me = f.me;
		const own = me ? { x: me.pos.x, y: me.pos.y } : null;
		const ownDrawn = me ? lerp(f, me.id, me.pos) : null;
		if (ownDrawn) {
			if (!camReady) {
				cam.x = ownDrawn.x;
				cam.y = ownDrawn.y;
				camReady = true;
			} else {
				const k = 1 - Math.exp((-FOLLOW_RATE * FRAME_MS) / 1000);
				cam.x += (ownDrawn.x - cam.x) * k;
				cam.y += (ownDrawn.y - cam.y) * k;
			}
		}
		// Track one remote fighter that keeps being in view.
		const others = f.world.fighters.filter((o) => o.id !== me?.id && o.alive);
		if (remoteId === null || !others.some((o) => o.id === remoteId)) remoteId = others[0]?.id ?? null;
		const r = others.find((o) => o.id === remoteId);
		samples.push({
			t: now,
			own: ownDrawn ?? own,
			ownFacing: me ? Math.atan2(me.facing.y, me.facing.x) : null,
			cam: camReady ? { ...cam } : null,
			remoteId,
			remote: r ? lerp(f, r.id, r.pos) : null,
			alpha: f.alpha,
			offset: Math.hypot(predictor.offset.x, predictor.offset.y)
		});
	}
	next += FRAME_MS;
	await sleep(Math.max(0, next - performance.now()));
}

const stats = match.netStats();
match.leave();
match.dispose();

// ── Analysis
const pct = (xs: number[], p: number) => {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => {
	const m = mean(xs);
	return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Per-frame speeds (units/s) of a drawn track, skipping gaps and the first frames after a gap. */
function speeds(get: (s: Sample) => Vec2 | null, sameTrack: (a: Sample, b: Sample) => boolean = () => true) {
	const out: number[] = [];
	for (let i = 1; i < samples.length; i++) {
		const a = get(samples[i - 1]);
		const b = get(samples[i]);
		if (!a || !b || !sameTrack(samples[i - 1], samples[i])) continue;
		const dt = (samples[i].t - samples[i - 1].t) / 1000;
		if (dt <= 0) continue;
		out.push(Math.hypot(b.x - a.x, b.y - a.y) / dt);
	}
	return out;
}

function report(name: string, v: number[]) {
	const moving = v.filter((x) => x > 0.05);
	const still = v.length - moving.length;
	// Frames that stood still between moving ones: the "step, wait, step" judder.
	let stalls = 0;
	for (let i = 1; i < v.length - 1; i++) if (v[i] <= 0.05 && v[i - 1] > 0.05 && v[i + 1] > 0.05) stalls++;
	console.log(
		`${name.padEnd(22)} frames ${String(v.length).padStart(5)}  still ${String(still).padStart(4)}  mid-motion stalls ${String(stalls).padStart(4)}` +
			`  speed p10/p50/p90 ${r3(pct(moving, 0.1))}/${r3(pct(moving, 0.5))}/${r3(pct(moving, 0.9))}  cv ${r3(sd(moving) / mean(moving))}`
	);
}

console.log(`\nframes ${samples.length}, avg frame ${r3((samples.at(-1)!.t - samples[0].t) / samples.length)} ms (tick ${TICK_MS} ms)`);
report('own (drawn)', speeds((s) => s.own));
report('own on screen (−cam)', speeds((s) => (s.own && s.cam ? { x: s.own.x - s.cam.x, y: s.own.y - s.cam.y } : null)));
report('remote fighter', speeds((s) => s.remote, (a, b) => a.remoteId === b.remoteId));
const alphaClamped = samples.filter((s) => s.alpha === 1).length;
console.log(`interp alpha==1 (no newer snapshot): ${alphaClamped}/${samples.length} frames`);
const offs = samples.map((s) => s.offset);
console.log(`prediction correction offset: p50 ${r3(pct(offs, 0.5))}  p90 ${r3(pct(offs, 0.9))}  max ${r3(Math.max(...offs))}`);
let flips = 0;
for (let i = 1; i < samples.length; i++) {
	const a = samples[i - 1].ownFacing;
	const b = samples[i].ownFacing;
	if (a === null || b === null) continue;
	let d = Math.abs(b - a) % (Math.PI * 2);
	if (d > Math.PI) d = Math.PI * 2 - d;
	if (d > Math.PI / 4) flips++;
}
console.log(`own facing jumps > 45° in one frame: ${flips}`);
console.log(`net: rtt p50 ${stats.rttP50} p95 ${stats.rttP95}, jitter ${r3(stats.jitterMs)} ms, snapshots/s ${stats.snapshotsPerSecond}, input queue ${stats.inputQueue}`);
process.exit(0);
