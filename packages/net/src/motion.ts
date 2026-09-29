import type { BuildSummary, Fighter, Vec2 } from '@ofa/sim';
import type { InputFrame } from './input';
import type { SelfState } from './snapshot';
import { todo } from './todo';

/**
 * Client-side prediction of the local fighter's movement (docs/multiplayer-server-design.md §11.2).
 * stepMotion replays exactly the parts of sim `step()` that move a fighter, in the same order and
 * with the same sim helpers and constants, so a prediction without surprises matches the server
 * bit for bit.
 */

export interface MotionState {
	pos: Vec2;
	facing: Vec2;
	moveDir: Vec2 | null;
	running: boolean;
	dashTime: number;
	dashDir: Vec2;
	dashCd: number;
	dashCdMax: number;
	rootTime: number;
	attackCd: number;
	attackQueued: number;
	hasteBuff: number;
}

/** The build numbers movement depends on. */
export interface MotionStats {
	moveSpeed: number;
	attackRate: number;
	cdr: number;
	speedTier: number;
	radius: number;
}

export function motionFromFighter(f: Fighter): MotionState {
	return todo('T4', f);
}

export function motionFromSelf(s: SelfState): MotionState {
	return todo('T4', s);
}

export function motionStats(build: BuildSummary, radius: number): MotionStats {
	return todo('T4', build, radius);
}

/** Advances `s` by one tick with `frame`'s commands applied first (null = no new input). Mutates `s`. */
export function stepMotion(s: MotionState, frame: InputFrame | null, stats: MotionStats): void {
	todo('T4', s, frame, stats);
}
