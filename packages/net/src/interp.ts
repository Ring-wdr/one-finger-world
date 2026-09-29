import type { Snapshot } from './snapshot';
import { todo } from './todo';

/** Snapshot timing and interpolation (docs/multiplayer-server-design.md §11.3). */

/** Estimates the server's tick timeline from snapshot arrival times. */
export class ServerClock {
	onSnapshot(tick: number, nowMs: number): void {
		todo('T4', tick, nowMs);
	}

	/** Estimated server tick at `nowMs` (fractional). */
	serverTick(nowMs: number): number {
		return todo('T4', nowMs);
	}

	/** Tick to draw remote entities at: server tick minus the interpolation delay and jitter margin. */
	renderTick(nowMs: number): number {
		return todo('T4', nowMs);
	}

	/** Smoothed arrival jitter in ms. */
	get jitterMs(): number {
		return todo('T4');
	}

	reset(): void {
		todo('T4');
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
	constructor(readonly capacity = 32) {}

	/** 'reset' when the tick went backwards (server restored a checkpoint): the buffer restarts from `s`. */
	push(s: Snapshot): 'ok' | 'reset' {
		return todo('T4', s);
	}

	/** The pair around `renderTick`; clamps to the newest (alpha 1) rather than extrapolating. */
	sample(renderTick: number): Sample | null {
		return todo('T4', renderTick);
	}

	latest(): Snapshot | null {
		return todo('T4');
	}

	/** Snapshots with fromTick < tick ≤ toTick, oldest first (for dispatching their events). */
	between(fromTick: number, toTick: number): Snapshot[] {
		return todo('T4', fromTick, toTick);
	}

	clear(): void {
		todo('T4');
	}
}
