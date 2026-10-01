import { describe, expect, it } from 'vitest';
import { INTERP_DELAY_TICKS, MAX_INTERP_DELAY_TICKS, TICK_MS } from './constants';
import { ServerClock, SnapshotBuffer } from './interp';
import type { Snapshot } from './snapshot';

const snap = (tick: number): Snapshot => ({ tick }) as Snapshot;

describe('ServerClock', () => {
	it('returns 0 before any sample and after reset', () => {
		const c = new ServerClock();
		expect(c.serverTick(12345)).toBe(0);
		c.onSnapshot(10, 1000);
		c.reset();
		expect(c.serverTick(12345)).toBe(0);
		expect(c.jitterMs).toBe(0);
	});

	it('tracks a steady 40 ms latency with the base 2-tick delay', () => {
		const c = new ServerClock();
		const t0 = 5000;
		for (let tick = 100; tick < 200; tick++) c.onSnapshot(tick, t0 + (tick - 100) * TICK_MS + 40);
		const now = t0 + 99 * TICK_MS + 40;
		expect(c.jitterMs).toBe(0);
		expect(c.serverTick(now)).toBeCloseTo(199, 9);
		expect(c.renderTick(now)).toBeCloseTo(199 - INTERP_DELAY_TICKS, 9);
	});

	it('keeps the render tick behind the newest snapshot under 0-30 ms jitter', () => {
		const c = new ServerClock();
		const buf = new SnapshotBuffer();
		let seed = 17;
		const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
		let sampled = 0;
		for (let tick = 1; tick <= 400; tick++) {
			const arrival = tick * TICK_MS + 40 + rand() * 30;
			c.onSnapshot(tick, arrival);
			buf.push(snap(tick));
			const rt = c.renderTick(arrival);
			if (tick > 20) {
				expect(rt).toBeLessThan(tick);
				const s = buf.sample(rt)!;
				expect(s.alpha).toBeGreaterThanOrEqual(0);
				expect(s.alpha).toBeLessThanOrEqual(1);
				expect(s.a.tick).toBeLessThanOrEqual(s.b.tick);
				sampled++;
			}
		}
		expect(sampled).toBeGreaterThan(300);
		expect(c.jitterMs).toBeGreaterThan(0);
	});

	it('caps the interpolation delay', () => {
		const c = new ServerClock();
		c.onSnapshot(0, 0);
		// Alternating early/late arrivals push the jitter estimate far up.
		for (let i = 1; i <= 200; i++) c.onSnapshot(i, i * TICK_MS + (i % 2 ? 900 : 0));
		const now = 10_000;
		expect(c.serverTick(now) - c.renderTick(now)).toBeCloseTo(MAX_INTERP_DELAY_TICKS, 9);
	});

	it('follows a server clock running 1% fast without drifting away', () => {
		const c = new ServerClock();
		const period = TICK_MS / 1.01;
		let worst = 0;
		for (let tick = 1; tick <= 2000; tick++) {
			const now = tick * period + 40;
			c.onSnapshot(tick, now);
			if (tick > 100) worst = Math.max(worst, Math.abs(c.serverTick(now) - tick));
		}
		// Arrivals keep coming earlier, so the base follows them down immediately.
		expect(worst).toBeLessThan(0.01);
	});

	it('moves the base up only slowly for late arrivals', () => {
		const c = new ServerClock();
		c.onSnapshot(10, 10 * TICK_MS);
		c.onSnapshot(11, 11 * TICK_MS + 100);
		// base moved 2% of 100 ms
		expect(c.serverTick(11 * TICK_MS + 100)).toBeCloseTo(13 - 2 / TICK_MS, 9);
		expect(c.jitterMs).toBeCloseTo(10, 9);
	});
});

describe('SnapshotBuffer', () => {
	it('is empty at first', () => {
		const b = new SnapshotBuffer();
		expect(b.sample(5)).toBeNull();
		expect(b.latest()).toBeNull();
		expect(b.between(0, 10)).toEqual([]);
	});

	it('ignores a repeated tick', () => {
		const b = new SnapshotBuffer();
		const first = snap(3);
		b.push(first);
		expect(b.push(snap(3))).toBe('ok');
		expect(b.latest()).toBe(first);
		expect(b.between(0, 10)).toHaveLength(1);
	});

	it('interpolates between the surrounding pair and clamps at both ends', () => {
		const b = new SnapshotBuffer();
		for (const t of [10, 12, 13, 17]) b.push(snap(t));
		const mid = b.sample(11.5)!;
		expect([mid.a.tick, mid.b.tick, mid.alpha]).toEqual([10, 12, 0.75]);
		const exact = b.sample(13)!;
		expect([exact.a.tick, exact.b.tick, exact.alpha]).toEqual([13, 17, 0]);
		const late = b.sample(99)!;
		expect([late.a.tick, late.b.tick, late.alpha]).toEqual([17, 17, 1]);
		const early = b.sample(1)!;
		expect([early.a.tick, early.b.tick, early.alpha]).toEqual([10, 10, 1]);
		expect(b.sample(10)!.alpha).toBe(1);
	});

	it('resets when the tick goes backwards', () => {
		const b = new SnapshotBuffer();
		for (const t of [40, 41, 42]) b.push(snap(t));
		const restored = snap(30);
		expect(b.push(restored)).toBe('reset');
		expect(b.latest()).toBe(restored);
		expect(b.between(0, 100)).toEqual([restored]);
		expect(b.push(snap(31))).toBe('ok');
	});

	it('keeps only the newest `capacity` snapshots', () => {
		const b = new SnapshotBuffer(4);
		for (let t = 1; t <= 10; t++) b.push(snap(t));
		expect(b.between(0, 100).map((s) => s.tick)).toEqual([7, 8, 9, 10]);
		expect(new SnapshotBuffer().capacity).toBe(32);
	});

	it('between() is exclusive of from and inclusive of to', () => {
		const b = new SnapshotBuffer();
		for (let t = 1; t <= 6; t++) b.push(snap(t));
		expect(b.between(2, 5).map((s) => s.tick)).toEqual([3, 4, 5]);
		b.clear();
		expect(b.latest()).toBeNull();
	});
});
