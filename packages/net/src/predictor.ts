import { copy, type Vec2 } from '@ofa/sim';
import type { InputFrame } from './input';
import { stepMotion, type MotionState, type MotionStats } from './motion';

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
	private readonly historySize: number;
	private readonly smoothRate: number;
	private readonly snapDistance: number;
	private predicted: MotionState | null = null;
	/** Predicted position before the latest frame, so the display can move between local ticks. */
	private before: Vec2 = { x: 0, y: 0 };
	/** Tick fraction of the last displayPos call; a reconcile keeps that drawn spot continuous. */
	private alpha = 1;
	private history: InputFrame[] = [];
	private offset: Vec2 = { x: 0, y: 0 };

	constructor(opts: PredictorOptions = {}) {
		this.historySize = opts.historySize ?? 128;
		this.smoothRate = opts.smoothRate ?? 12;
		this.snapDistance = opts.snapDistance ?? 3;
	}

	/** The predicted state after every pushed frame, or null before the first reset. */
	get state(): MotionState | null {
		return this.predicted;
	}

	/** Starts over from an authoritative state (match start, reconnect). */
	reset(state: MotionState): void {
		this.predicted = cloneState(state);
		this.before = copy(state.pos);
		this.history = [];
		this.offset = { x: 0, y: 0 };
	}

	/** Applies one local tick's frame (already sent) and remembers it for replay. */
	push(frame: InputFrame, stats: MotionStats): void {
		if (!this.predicted) return;
		this.before = copy(this.predicted.pos);
		stepMotion(this.predicted, frame, stats);
		this.history.push(frame);
		if (this.history.length > this.historySize) this.history.shift();
	}

	/** Rebases on the server's state after it applied frame `ack`, then replays newer frames. */
	reconcile(server: MotionState, ack: number, stats: MotionStats): void {
		if (!this.predicted) {
			this.reset(server);
			return;
		}
		const p0 = this.base(this.alpha);
		this.history = this.history.filter((f) => f.seq > ack);
		const next = cloneState(server);
		let before = copy(next.pos);
		for (const f of this.history) {
			before = copy(next.pos);
			stepMotion(next, f, stats);
		}
		this.predicted = next;
		this.before = before;
		const p1 = this.base(this.alpha);
		this.offset = { x: this.offset.x + p0.x - p1.x, y: this.offset.y + p0.y - p1.y };
		if (Math.hypot(this.offset.x, this.offset.y) > this.snapDistance) this.offset = { x: 0, y: 0 };
	}

	/**
	 * Where to draw the fighter: the prediction `alpha` of the way through the latest local tick
	 * (from the position before it), plus the decaying correction offset. Drawing only the
	 * latest tick's position would move the fighter in 20 Hz steps on a 60 Hz screen.
	 */
	displayPos(dt: number, alpha = 1): Vec2 {
		const k = Math.exp(-this.smoothRate * dt);
		this.offset = { x: this.offset.x * k, y: this.offset.y * k };
		this.alpha = Math.max(0, Math.min(1, alpha));
		const p = this.base(this.alpha);
		return { x: p.x + this.offset.x, y: p.y + this.offset.y };
	}

	private base(alpha: number): Vec2 {
		const p = this.predicted?.pos ?? { x: 0, y: 0 };
		const a = this.before;
		return { x: a.x + (p.x - a.x) * alpha, y: a.y + (p.y - a.y) * alpha };
	}

	clear(): void {
		this.predicted = null;
		this.before = { x: 0, y: 0 };
		this.alpha = 1;
		this.history = [];
		this.offset = { x: 0, y: 0 };
	}
}

function cloneState(s: MotionState): MotionState {
	return {
		...s,
		pos: copy(s.pos),
		facing: copy(s.facing),
		moveDir: s.moveDir ? copy(s.moveDir) : null,
		dashDir: copy(s.dashDir)
	};
}
