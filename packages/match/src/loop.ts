import { TICK_MS } from '@ofa/net';
import { MAX_CATCHUP_TICKS, type MatchState } from './types';

/** What the loop drives: MatchCore, or a stand-in in tests. */
export interface Tickable {
	readonly state: MatchState;
	tick(): void;
}

export interface LoopTimers {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realTimers: LoopTimers = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
};

/**
 * The 20 Hz drift-corrected tick loop (docs/multiplayer-server-design.md §5.4), shared by the
 * Durable Object and the standalone match server. Call sync() after anything that may change
 * the match state; the loop runs exactly while the state is 'running'.
 */
export class TickLoop {
	private timer: unknown = null;
	private nextTickAt = 0;

	constructor(
		private readonly target: Tickable,
		/** A tick threw: the loop has stopped; the host restores from its last checkpoint. */
		private readonly onCrash: (err: unknown) => void,
		private readonly timers: LoopTimers = realTimers
	) {}

	get running(): boolean {
		return this.timer !== null;
	}

	sync(): void {
		const running = this.target.state === 'running';
		if (running && this.timer === null) {
			this.nextTickAt = this.timers.now() + TICK_MS;
			this.timer = this.timers.setTimeout(() => this.onTimer(), TICK_MS);
		} else if (!running && this.timer !== null) {
			this.stop();
		}
	}

	stop(): void {
		if (this.timer !== null) this.timers.clearTimeout(this.timer);
		this.timer = null;
	}

	private onTimer(): void {
		this.timer = null;
		try {
			const now = this.timers.now();
			let n = 0;
			while (now >= this.nextTickAt && n < MAX_CATCHUP_TICKS && this.target.state === 'running') {
				this.target.tick();
				this.nextTickAt += TICK_MS;
				n += 1;
			}
			// More than the catch-up allowance behind: skip ahead instead of racing.
			if (now >= this.nextTickAt) this.nextTickAt = now + TICK_MS;
		} catch (err) {
			this.onCrash(err);
			return;
		}
		if (this.target.state === 'running') this.timer = this.timers.setTimeout(() => this.onTimer(), Math.max(0, this.nextTickAt - this.timers.now()));
	}
}
