import {
	ATTACK_BUFFER_TIME,
	ATTACK_ROOT_TIME,
	DASH_DISTANCE,
	DASH_HASTE_TIME,
	DASH_TIME,
	DT,
	HASTE_ATTACK_MULT,
	MAP_RADIUS,
	WALK_SPEED_FACTOR,
	clampToCircle,
	copy,
	dashCooldownFor,
	moveWithCollision,
	normalize,
	scale,
	type BuildSummary,
	type Fighter,
	type Vec2
} from '@ofa/sim';
import type { InputFrame } from './input';
import type { SelfState } from './snapshot';

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

/** Copies just the motion fields; Fighter and SelfState both carry them. */
function copyMotion(f: MotionState): MotionState {
	return {
		pos: copy(f.pos),
		facing: copy(f.facing),
		moveDir: f.moveDir ? copy(f.moveDir) : null,
		running: f.running,
		dashTime: f.dashTime,
		dashDir: copy(f.dashDir),
		dashCd: f.dashCd,
		dashCdMax: f.dashCdMax,
		rootTime: f.rootTime,
		attackCd: f.attackCd,
		attackQueued: f.attackQueued,
		hasteBuff: f.hasteBuff
	};
}

export function motionFromFighter(f: Fighter): MotionState {
	return copyMotion(f);
}

export function motionFromSelf(s: SelfState): MotionState {
	return copyMotion(s);
}

export function motionStats(build: BuildSummary, radius: number): MotionStats {
	return {
		moveSpeed: build.stats.moveSpeed,
		attackRate: build.stats.attackRate,
		cdr: build.stats.cdr,
		speedTier: build.tiers.speed,
		radius
	};
}

/** Advances `s` by one tick with `frame`'s commands applied first (null = no new input). Mutates `s`. */
export function stepMotion(s: MotionState, frame: InputFrame | null, stats: MotionStats): void {
	if (frame) {
		s.moveDir = frame.move ? normalize(frame.move) : null;
		if (s.moveDir && s.moveDir.x === 0 && s.moveDir.y === 0) s.moveDir = null;
		s.running = frame.run;
		if (frame.attack) s.attackQueued = ATTACK_BUFFER_TIME;
		if (frame.dash && s.dashCd <= 0 && s.dashTime <= 0 && s.rootTime <= 0) {
			const d = normalize(frame.dash);
			s.dashDir = d.x === 0 && d.y === 0 ? copy(s.facing) : d;
			s.facing = copy(s.dashDir);
			s.dashTime = DASH_TIME;
			s.attackQueued = 0;
			s.dashCd = s.dashCdMax = dashCooldownFor(stats.speedTier, stats.cdr, frame.dashTouch);
		}
	}

	s.attackCd -= DT;
	s.dashCd -= DT;
	s.rootTime -= DT;
	s.attackQueued -= DT;
	s.hasteBuff -= DT;

	if (s.dashTime > 0) {
		const step = (DASH_DISTANCE / DASH_TIME) * Math.min(DT, Math.max(0, s.dashTime));
		s.pos = moveWithCollision(s.pos, scale(s.dashDir, step), stats.radius);
		s.dashTime -= DT;
		if (s.dashTime <= 0 && stats.speedTier >= 2) s.hasteBuff = DASH_HASTE_TIME;
	} else {
		if (s.moveDir && s.rootTime <= 0) {
			const speed = stats.moveSpeed * (s.running ? 1 : WALK_SPEED_FACTOR);
			s.pos = moveWithCollision(s.pos, scale(s.moveDir, speed * DT), stats.radius);
			s.facing = copy(s.moveDir);
		}
		// The sim also turns toward the nearest enemy here; prediction can't, reconcile fixes facing.
		if (s.attackQueued > 0 && s.attackCd <= 0) {
			s.attackCd = 1 / (stats.attackRate * (s.hasteBuff > 0 ? HASTE_ATTACK_MULT : 1));
			s.attackQueued = 0;
			s.rootTime = ATTACK_ROOT_TIME;
		}
	}
	s.pos = clampToCircle(s.pos, { x: 0, y: 0 }, MAP_RADIUS);
}
