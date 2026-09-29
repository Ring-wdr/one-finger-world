import type { Vec2 } from '@ofa/sim';
import type { InputFrame } from './input';
import type { MotionState, MotionStats } from './motion';
import { todo } from './todo';

export interface PredictorOptions {
	/** Frames kept for replay. */
	historySize?: number;
	/** Correction offset decay rate, 1/s. */
	smoothRate?: number;
	/** Corrections larger than this (world units) snap instead of easing. */
	snapDistance?: number;
}

/**
 * Predicts the local fighter ahead of the server and reconciles with each authoritative self
 * state: rebase on the server's state for `ack`, replay the frames sent after it, and ease the
 * visible position over the difference (docs/multiplayer-server-design.md §11.2).
 */
export class Predictor {
	constructor(opts: PredictorOptions = {}) {
		todo('T4', opts);
	}

	/** The predicted state after every pushed frame, or null before the first reset. */
	get state(): MotionState | null {
		return todo('T4');
	}

	/** Starts over from an authoritative state (match start, reconnect). */
	reset(state: MotionState): void {
		todo('T4', state);
	}

	/** Applies one local tick's frame (already sent) and remembers it for replay. */
	push(frame: InputFrame, stats: MotionStats): void {
		todo('T4', frame, stats);
	}

	/** Rebases on the server's state after it applied frame `ack`, then replays newer frames. */
	reconcile(server: MotionState, ack: number, stats: MotionStats): void {
		todo('T4', server, ack, stats);
	}

	/** Where to draw the fighter: prediction plus the decaying correction offset. */
	displayPos(dt: number): Vec2 {
		return todo('T4', dt);
	}

	clear(): void {
		todo('T4');
	}
}
