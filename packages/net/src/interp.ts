import { INTERP_DELAY_TICKS, MAX_INTERP_DELAY_TICKS, TICK_MS } from './constants';
import type { Snapshot } from './snapshot';

/** Snapshot timing and interpolation (docs/multiplayer-server-design.md §11.3). */

/** Estimates the server's tick timeline from snapshot arrival times. */
export class ServerClock {
	private base: number | null = null;
	private jitter = 0;

	onSnapshot(tick: number, nowMs: number): void {
		const c = nowMs - tick * TICK_MS;
		if (this.base === null) {
			this.base = c;
			return;
		}
		// The earliest arrivals are the least delayed, so follow them down at once and drift up slowly.
		const dev = Math.abs(c - this.base);
		if (c < this.base) this.base = c;
		else this.base += (c - this.base) * 0.02;
		this.jitter += (dev - this.jitter) * 0.1;
	}

	/** Estimated server tick at `nowMs` (fractional). */
	serverTick(nowMs: number): number {
		return this.base === null ? 0 : (nowMs - this.base) / TICK_MS;
	}

	/** Tick to draw remote entities at: server tick minus the interpolation delay and jitter margin. */
	renderTick(nowMs: number): number {
		return this.serverTick(nowMs) - Math.min(MAX_INTERP_DELAY_TICKS, INTERP_DELAY_TICKS + this.jitter / TICK_MS);
	}

	/** Smoothed arrival jitter in ms. */
	get jitterMs(): number {
		return this.jitter;
	}

	reset(): void {
		this.base = null;
		this.jitter = 0;
	}
}

export interface Sample {
	a: Snapshot;
	b: Snapshot;
	/** 0 at `a`, 1 at `b`. */
	alpha: number;
}

/** The most recent snapshots in tick order. */
export class SnapshotBuffer {
	private snaps: Snapshot[] = [];

	constructor(readonly capacity = 32) {}

	/** 'reset' when the tick went backwards (server restored a checkpoint): the buffer restarts from `s`. */
	push(s: Snapshot): 'ok' | 'reset' {
		const newest = this.snaps[this.snaps.length - 1];
		if (newest) {
			if (s.tick === newest.tick) return 'ok';
			if (s.tick < newest.tick) {
				this.snaps = [s];
				return 'reset';
			}
		}
		this.snaps.push(s);
		if (this.snaps.length > this.capacity) this.snaps.shift();
		return 'ok';
	}

	/** The pair around `renderTick`; clamps to the newest (alpha 1) rather than extrapolating. */
	sample(renderTick: number): Sample | null {
		const n = this.snaps.length;
		if (n === 0) return null;
		const newest = this.snaps[n - 1];
		const oldest = this.snaps[0];
		if (renderTick >= newest.tick) return { a: newest, b: newest, alpha: 1 };
		if (renderTick <= oldest.tick) return { a: oldest, b: oldest, alpha: 1 };
		let i = n - 2;
		while (this.snaps[i].tick > renderTick) i--;
		const a = this.snaps[i];
		const b = this.snaps[i + 1];
		return { a, b, alpha: (renderTick - a.tick) / (b.tick - a.tick) };
	}

	latest(): Snapshot | null {
		return this.snaps[this.snaps.length - 1] ?? null;
	}

	/** Snapshots with fromTick < tick ≤ toTick, oldest first (for dispatching their events). */
	between(fromTick: number, toTick: number): Snapshot[] {
		return this.snaps.filter((s) => s.tick > fromTick && s.tick <= toTick);
	}

	clear(): void {
		this.snaps = [];
	}
}
