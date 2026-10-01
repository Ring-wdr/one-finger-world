import { describe, expect, it } from 'vitest';
import { TICK_MS } from '@ofa/net';
import { MessageBudget } from './budget';
import { TickLoop, type LoopTimers, type Tickable } from './loop';
import { MAX_CATCHUP_TICKS, type MatchState } from './types';

/** Manual clock: timers fire only when the test advances time. */
function fakeTimers() {
	let now = 0;
	let pending: { at: number; fn: () => void; id: number } | null = null;
	let ids = 0;
	const timers: LoopTimers = {
		now: () => now,
		setTimeout: (fn, ms) => {
			pending = { at: now + ms, fn, id: ++ids };
			return pending.id;
		},
		clearTimeout: (h) => {
			if (pending?.id === h) pending = null;
		}
	};
	return {
		timers,
		get pending() {
			return pending;
		},
		/** Jump to `to` and fire the due timer, if any. */
		advance(to: number) {
			now = to;
			const p = pending;
			if (p && p.at <= now) {
				pending = null;
				p.fn();
			}
		}
	};
}

class Target implements Tickable {
	state: MatchState = 'waiting';
	ticks = 0;
	throwOn = -1;
	tick() {
		if (this.ticks === this.throwOn) throw new Error('boom');
		this.ticks += 1;
	}
}

describe('TickLoop', () => {
	it('runs only while the state is running', () => {
		const t = new Target();
		const clock = fakeTimers();
		const loop = new TickLoop(t, () => {}, clock.timers);
		loop.sync();
		expect(loop.running).toBe(false);
		t.state = 'running';
		loop.sync();
		expect(loop.running).toBe(true);
		clock.advance(TICK_MS);
		clock.advance(2 * TICK_MS);
		expect(t.ticks).toBe(2);
		t.state = 'ended';
		loop.sync();
		expect(loop.running).toBe(false);
		expect(clock.pending).toBeNull();
	});

	it('catches up at most MAX_CATCHUP_TICKS after a stall, then skips ahead', () => {
		const t = new Target();
		t.state = 'running';
		const clock = fakeTimers();
		const loop = new TickLoop(t, () => {}, clock.timers);
		loop.sync();
		clock.advance(10 * TICK_MS);
		expect(t.ticks).toBe(MAX_CATCHUP_TICKS);
		// Rescheduled one tick ahead of the stall, not racing to repay it.
		expect(clock.pending!.at).toBe(11 * TICK_MS);
	});

	it('stops and reports when a tick throws', () => {
		const t = new Target();
		t.state = 'running';
		t.throwOn = 1;
		const clock = fakeTimers();
		const errors: unknown[] = [];
		const loop = new TickLoop(t, (e) => errors.push(e), clock.timers);
		loop.sync();
		clock.advance(TICK_MS);
		clock.advance(2 * TICK_MS);
		expect(errors).toHaveLength(1);
		expect(loop.running).toBe(false);
	});
});

describe('MessageBudget', () => {
	it('allows the burst, refills at the sustained rate, and keys are independent', () => {
		const b = new MessageBudget<string>(40, 100);
		for (let i = 0; i < 100; i++) expect(b.take('a', 0)).toBe(true);
		expect(b.take('a', 0)).toBe(false);
		expect(b.take('b', 0)).toBe(true);
		// 1 s later: 40 more, minus the refused message that overdrew the bucket.
		let ok = 0;
		while (b.take('a', 1000)) ok += 1;
		expect(ok).toBe(39);
		b.forget('a');
		expect(b.take('a', 1000)).toBe(true);
	});

	it('never refuses a steady 20 messages per second', () => {
		const b = new MessageBudget<string>();
		for (let i = 0; i < 2000; i++) expect(b.take('a', i * 50)).toBe(true);
	});
});
