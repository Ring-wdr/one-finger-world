import { Rng, createWorld, step, type Fighter, type World } from '@ofa/sim';
import { describe, expect, it } from 'vitest';
import { emptyFrame, frameToCommands, quantizeDir, type InputFrame } from './input';
import { motionFromFighter, motionStats, type MotionState } from './motion';
import { Predictor } from './predictor';

function setup() {
	const { world, playerId } = createWorld({ seed: 3, fighters: 1, playerName: 'me', sandbox: true });
	const f = world.fighters.find((x) => x.id === playerId)!;
	f.offer = null;
	f.pendingDrafts = 0;
	return { world, f, stats: motionStats(f.build, f.radius) };
}

function randomFrame(rng: Rng, seq: number, active: boolean): InputFrame {
	const fr = emptyFrame(seq);
	if (!active) return fr;
	if (rng.next() < 0.85) fr.move = quantizeDir({ x: rng.range(-1, 1), y: rng.range(-1, 1) });
	fr.run = rng.next() < 0.6;
	fr.attack = rng.next() < 0.15;
	if (rng.next() < 0.05) fr.dash = quantizeDir({ x: rng.range(-1, 1), y: rng.range(-1, 1) });
	return fr;
}

const clone = (m: MotionState): MotionState => structuredClone(m);

/** Client and server in one loop, with a per-frame delivery delay of `delay(tick)` ticks. */
function simulate(opts: {
	ticks: number;
	quietFrom: number;
	delay: (tick: number) => number;
	starve?: (tick: number) => boolean;
	onTick?: (c: { tick: number; predictor: Predictor; f: Fighter; world: World }) => void;
}) {
	const { world, f, stats } = setup();
	const rng = new Rng(99);
	const predictor = new Predictor();
	predictor.reset(motionFromFighter(f));
	const toServer: { at: number; frame: InputFrame }[] = [];
	const toClient: { at: number; state: MotionState; ack: number }[] = [];
	const queue: InputFrame[] = [];
	const predicted = new Map<number, MotionState>();
	const served = new Map<number, MotionState>();
	let ack = 0;
	let lastArrival = 0;
	let lastReply = 0;

	for (let tick = 1; tick <= opts.ticks; tick++) {
		// Client: authoritative states that arrived, then this tick's frame.
		while (toClient.length && toClient[0].at <= tick) {
			const r = toClient.shift()!;
			predictor.reconcile(r.state, r.ack, stats);
		}
		const frame = randomFrame(rng, tick, tick <= opts.quietFrom);
		predictor.push(frame, stats);
		predicted.set(tick, clone(predictor.state!));
		lastArrival = Math.max(lastArrival, tick + opts.delay(tick));
		toServer.push({ at: lastArrival, frame });

		// Server: frames in order, at most one per tick.
		while (toServer.length && toServer[0].at <= tick) queue.push(toServer.shift()!.frame);
		const next = opts.starve?.(tick) ? undefined : queue.shift();
		if (next) ack = next.seq;
		step(world, new Map(next ? [[f.id, frameToCommands(next)]] : []));
		if (next) served.set(next.seq, motionFromFighter(f));
		lastReply = Math.max(lastReply, tick + 1 + opts.delay(tick));
		toClient.push({ at: lastReply, state: motionFromFighter(f), ack });

		opts.onTick?.({ tick, predictor, f, world });
	}
	return { predicted, served };
}

describe('Predictor with a simulated server', () => {
	for (const L of [0, 2, 5]) {
		it(`predicts exactly what the server reaches with a steady queue (latency ${L})`, () => {
			const { predicted, served } = simulate({ ticks: 400, quietFrom: 400, delay: () => L });
			let compared = 0;
			for (let seq = 6 * L + 10; seq <= 400 - 2 * L - 2; seq++) {
				const s = served.get(seq);
				if (!s) continue;
				expect(predicted.get(seq), `seq ${seq}`).toEqual(s);
				compared++;
			}
			expect(compared).toBeGreaterThan(300 - 8 * L);
		});
	}

	it('keeps the correction bounded under jitter and starvation, and settles once input stops', () => {
		const jitter = new Rng(5);
		const starve = new Rng(6);
		let maxOffset = 0;
		let settledError = Infinity;
		simulate({
			ticks: 500,
			quietFrom: 400,
			delay: () => 2 + jitter.int(4),
			starve: () => starve.next() < 0.05,
			onTick: ({ tick, predictor, f }) => {
				const shown = predictor.displayPos(0.05);
				const offset = Math.hypot(shown.x - predictor.state!.pos.x, shown.y - predictor.state!.pos.y);
				maxOffset = Math.max(maxOffset, offset);
				if (tick === 500) settledError = Math.hypot(shown.x - f.pos.x, shown.y - f.pos.y);
			}
		});
		expect(maxOffset).toBeGreaterThan(0);
		expect(maxOffset).toBeLessThanOrEqual(3);
		// Input stopped at tick 400: a second (20 ticks) later, plus queue drain, the display sits on the server.
		expect(settledError).toBeLessThan(0.01);
	});
});

describe('Predictor corrections', () => {
	const at = (x: number): MotionState => {
		const { f } = setup();
		const m = motionFromFighter(f);
		m.pos = { x, y: 0 };
		return m;
	};

	it('snaps a large correction', () => {
		const { stats } = setup();
		const p = new Predictor();
		p.reset(at(0));
		p.reconcile(at(5), 0, stats);
		expect(p.state!.pos).toEqual({ x: 5, y: 0 });
		expect(p.displayPos(0)).toEqual({ x: 5, y: 0 });
	});

	it('eases a small correction', () => {
		const { stats } = setup();
		const p = new Predictor();
		p.reset(at(0));
		p.reconcile(at(0.5), 0, stats);
		expect(p.state!.pos.x).toBe(0.5);
		expect(p.displayPos(0).x).toBeCloseTo(0, 12);
		const later = p.displayPos(0.1).x;
		expect(later).toBeGreaterThan(0);
		expect(later).toBeLessThan(0.5);
		expect(p.displayPos(10).x).toBeCloseTo(0.5, 6);
	});

	it('forgets frames up to the ack and keeps the rest', () => {
		const { stats } = setup();
		const p = new Predictor();
		p.reset(at(0));
		const right = { ...emptyFrame(1), move: { x: 1, y: 0 }, run: true };
		for (let i = 1; i <= 4; i++) p.push({ ...right, seq: i }, stats);
		const full = p.state!.pos.x;
		// The server has applied 2 of 4 frames; replaying the other two lands on the same spot.
		const half = new Predictor();
		half.reset(at(0));
		for (let i = 1; i <= 2; i++) half.push({ ...right, seq: i }, stats);
		p.reconcile(clone(half.state!), 2, stats);
		expect(p.state!.pos.x).toBeCloseTo(full, 12);
		expect(Math.abs(p.displayPos(0).x - full)).toBeLessThan(1e-9);
	});

	it('drops the oldest frames past historySize', () => {
		const { stats } = setup();
		const p = new Predictor({ historySize: 3 });
		p.reset(at(0));
		const right = { ...emptyFrame(1), move: { x: 1, y: 0 }, run: true };
		for (let i = 1; i <= 10; i++) p.push({ ...right, seq: i }, stats);
		const start = at(0);
		p.reconcile(start, 0, stats);
		// Only the last three frames replay from the server state.
		const three = new Predictor();
		three.reset(at(0));
		for (let i = 8; i <= 10; i++) three.push({ ...right, seq: i }, stats);
		expect(p.state!.pos.x).toBeCloseTo(three.state!.pos.x, 12);
	});

	it('acts as a reset before the first reset and after clear', () => {
		const { stats } = setup();
		const p = new Predictor();
		expect(p.state).toBeNull();
		p.reconcile(at(2), 0, stats);
		expect(p.state!.pos.x).toBe(2);
		expect(p.displayPos(0.05).x).toBe(2);
		p.clear();
		expect(p.state).toBeNull();
	});

	it('does not alias the state it was reset or reconciled with', () => {
		const { stats } = setup();
		const s = at(1);
		const p = new Predictor();
		p.reset(s);
		p.push(emptyFrame(1), stats);
		s.pos.x = 50;
		expect(p.state!.pos.x).toBe(1);
	});
});

describe('Predictor display between local ticks', () => {
	const { stats } = setup();
	const right = (seq: number): InputFrame => ({ ...emptyFrame(seq), move: { x: 1, y: 0 }, run: true });
	const start = (): MotionState => {
		const { f } = setup();
		const m = motionFromFighter(f);
		m.pos = { x: 0, y: 0 };
		return m;
	};

	it('moves through the latest tick with alpha instead of jumping a whole tick', () => {
		const p = new Predictor();
		p.reset(start());
		p.push(right(1), stats);
		const end = p.state!.pos.x;
		expect(end).toBeGreaterThan(0);
		expect(p.displayPos(0, 0).x).toBeCloseTo(0, 12);
		expect(p.displayPos(0, 0.5).x).toBeCloseTo(end / 2, 12);
		expect(p.displayPos(0, 1).x).toBeCloseTo(end, 12);
		p.push(right(2), stats);
		expect(p.displayPos(0, 0).x).toBeCloseTo(end, 12);
	});

	it('keeps a frame-by-frame steady pace at 60 fps', () => {
		const p = new Predictor();
		p.reset(start());
		const xs: number[] = [];
		let acc = 0;
		let seq = 0;
		for (let frame = 0; frame < 60; frame++) {
			acc += 1000 / 60;
			while (acc >= 50) {
				acc -= 50;
				p.push(right(++seq), stats);
			}
			xs.push(p.displayPos(1 / 60, acc / 50).x);
		}
		const steps = xs.slice(10).map((x, i) => x - xs[9 + i]);
		const min = Math.min(...steps);
		const max = Math.max(...steps);
		expect(min).toBeGreaterThan(0);
		expect(max / min).toBeLessThan(1.01);
	});

	it('keeps the drawn spot continuous across a reconcile at the current alpha', () => {
		const p = new Predictor();
		p.reset(start());
		for (let i = 1; i <= 4; i++) p.push(right(i), stats);
		const shown = p.displayPos(0, 0.4);
		// The server is a little ahead of what was predicted for frame 2.
		const half = new Predictor();
		half.reset(start());
		for (let i = 1; i <= 2; i++) half.push(right(i), stats);
		const server = clone(half.state!);
		server.pos.x += 0.2;
		p.reconcile(server, 2, stats);
		expect(p.displayPos(0, 0.4).x).toBeCloseTo(shown.x, 12);
		expect(p.displayPos(10, 0.4).x).toBeCloseTo(shown.x + 0.2, 6);
	});
});
