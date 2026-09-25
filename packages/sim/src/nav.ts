/**
 * AI locomotion around map obstacles: look-ahead steering plus stuck detection with a held
 * detour waypoint. Used by monsters and bots (bots turn the result into a normal `move`
 * Command). Collision itself (sliding) lives in obstacles.ts and applies to every unit.
 */
import { clearSpot, forEachObstacleNear, OBSTACLES } from './obstacles';
import { DT } from './types';
import type { Vec2 } from './vec';

export interface NavState {
	/** Position at the start of the current progress window. */
	anchor: Vec2;
	/** Seconds into the current progress window. */
	window: number;
	/** Distance the unit meant to cover during the window. */
	expect: number;
	/** Tick of the last navigate() call; a gap restarts the window. */
	lastTick: number;
	/** Preferred way around things: +1 = counter-clockwise (left), −1 = right. */
	side: 1 | -1;
	/** Obstacle currently being steered around (keeps the chosen side stable), or −1. */
	steerObs: number;
	steerSide: 1 | -1;
	/** Held waypoint around whatever blocked the unit. */
	detour: Vec2 | null;
	detourTime: number;
	/** Consecutive progress windows that ended stuck. */
	stuckCount: number;
}

/** How far ahead steering checks the path. */
export const LOOKAHEAD = 2;
/** Extra clearance steering keeps from an obstacle's surface. */
const STEER_MARGIN = 0.15;
/** Below this dot-product gap the two tangents count as equally good (head-on). */
const SIDE_TIE = 0.05;
/** Hysteresis: an obstacle being rounded only switches sides for a clearly better tangent. */
const SIDE_SWITCH = 0.5;
const STUCK_WINDOW = 0.5;
const STUCK_FRACTION = 0.3;
/** Windows expecting less than this distance don't judge progress (e.g. slow wandering). */
const MIN_EXPECT = 0.3;
const DETOUR_HOLD = 1;
const DETOUR_ARRIVE = 0.6;
const DETOUR_CLEARANCE = 1.2;

export function newNav(id: number, pos: Vec2): NavState {
	const side: 1 | -1 = id % 2 === 0 ? 1 : -1;
	return {
		anchor: { x: pos.x, y: pos.y },
		window: 0,
		expect: 0,
		lastTick: -2,
		side,
		steerObs: -1,
		steerSide: side,
		detour: null,
		detourTime: 0,
		stuckCount: 0
	};
}

/**
 * Deflects a unit direction `dir` around the first obstacle within `lookahead` on its path,
 * toward the tangent that keeps the most forward progress. Ties (head-on) and an obstacle
 * already being rounded keep the unit's current side, so the choice can't flicker.
 */
export function steer(pos: Vec2, dir: Vec2, radius: number, lookahead: number, nav?: NavState): Vec2 {
	let hit = -1;
	let hitT = Infinity;
	forEachObstacleNear(pos.x, pos.y, lookahead + radius + STEER_MARGIN + 0.1, (o, i) => {
		const R = o.r + radius + STEER_MARGIN;
		const cx = o.x - pos.x;
		const cy = o.y - pos.y;
		const t = cx * dir.x + cy * dir.y;
		if (t <= 0) return; // behind, or beside and moving away
		const perp2 = cx * cx + cy * cy - t * t;
		if (perp2 >= R * R) return;
		const entry = t - Math.sqrt(R * R - perp2);
		if (entry > lookahead) return;
		if (entry < hitT - 1e-9) {
			hitT = entry;
			hit = i;
		}
	});
	if (hit < 0) {
		if (nav) nav.steerObs = -1;
		return dir;
	}

	const o = OBSTACLES[hit];
	const R = o.r + radius + STEER_MARGIN;
	const cx = o.x - pos.x;
	const cy = o.y - pos.y;
	const d = Math.hypot(cx, cy);
	const half = d > R ? Math.asin(R / d) : Math.PI / 2;
	const base = Math.atan2(cy, cx);
	const left = { x: Math.cos(base + half), y: Math.sin(base + half) };
	const right = { x: Math.cos(base - half), y: Math.sin(base - half) };
	const dl = left.x * dir.x + left.y * dir.y;
	const dr = right.x * dir.x + right.y * dir.y;

	let side: 1 | -1;
	if (nav && nav.steerObs === hit) {
		// Keep rounding the same way unless the other side became clearly better.
		const keep = nav.steerSide === 1 ? dl : dr;
		const other = nav.steerSide === 1 ? dr : dl;
		side = other - keep > SIDE_SWITCH ? (nav.steerSide === 1 ? -1 : 1) : nav.steerSide;
	} else if (Math.abs(dl - dr) < SIDE_TIE) side = nav?.side ?? 1;
	else side = dl > dr ? 1 : -1;
	if (nav) {
		nav.steerObs = hit;
		nav.steerSide = side;
	}
	return side === 1 ? left : right;
}

/**
 * One tick of AI locomotion toward `goal` at `speed` (0 = can't move this tick, e.g. rooted).
 * Tracks progress, sets a detour when stuck, and returns the steered unit direction
 * (null when already at the goal).
 */
export function navigate(nav: NavState, pos: Vec2, radius: number, goal: Vec2, speed: number, tick: number): Vec2 | null {
	if (tick - nav.lastTick > 1) resetWindow(nav, pos);
	nav.lastTick = tick;

	if (speed > 0) {
		nav.window += DT;
		nav.expect += speed * DT;
		if (nav.window >= STUCK_WINDOW) {
			const moved = Math.hypot(pos.x - nav.anchor.x, pos.y - nav.anchor.y);
			if (nav.expect >= MIN_EXPECT && moved < STUCK_FRACTION * nav.expect) onStuck(nav, pos, radius, goal);
			else nav.stuckCount = 0;
			resetWindow(nav, pos);
		}
	}

	if (nav.detour) {
		nav.detourTime -= DT;
		const dd = Math.hypot(nav.detour.x - pos.x, nav.detour.y - pos.y);
		if (nav.detourTime <= 0 || dd < DETOUR_ARRIVE) nav.detour = null;
	}

	const target = nav.detour ?? goal;
	const dx = target.x - pos.x;
	const dy = target.y - pos.y;
	const l = Math.hypot(dx, dy);
	if (l < 1e-6) return null;
	return steer(pos, { x: dx / l, y: dy / l }, radius, Math.min(LOOKAHEAD, l), nav);
}

function resetWindow(nav: NavState, pos: Vec2) {
	nav.anchor = { x: pos.x, y: pos.y };
	nav.window = 0;
	nav.expect = 0;
}

/** Picks a waypoint around the obstacle in the way, on the unit's side (flipped if a detour already failed). */
function onStuck(nav: NavState, pos: Vec2, radius: number, goal: Vec2) {
	nav.stuckCount += 1;
	if (nav.detour) nav.side = nav.side === 1 ? -1 : 1;
	nav.steerSide = nav.side;

	let gx = goal.x - pos.x;
	let gy = goal.y - pos.y;
	const gl = Math.hypot(gx, gy);
	if (gl > 1e-6) {
		gx /= gl;
		gy /= gl;
	} else {
		gx = 1;
		gy = 0;
	}
	// Left of the goal direction, times the chosen side.
	const sx = -gy * nav.side;
	const sy = gx * nav.side;

	let block: (typeof OBSTACLES)[number] | null = null;
	let blockD = Infinity;
	forEachObstacleNear(pos.x, pos.y, radius + 4, (o) => {
		const cx = o.x - pos.x;
		const cy = o.y - pos.y;
		const gap = Math.hypot(cx, cy) - o.r - radius;
		if (gap > 1 || cx * gx + cy * gy < -0.2 * o.r) return;
		if (gap < blockD - 1e-9) {
			blockD = gap;
			block = o;
		}
	});

	let w: Vec2;
	if (block) {
		const o = block as (typeof OBSTACLES)[number];
		const off = o.r + radius + DETOUR_CLEARANCE;
		w = { x: o.x + sx * off + gx * o.r * 0.5, y: o.y + sy * off + gy * o.r * 0.5 };
	} else {
		w = { x: pos.x + sx * 3, y: pos.y + sy * 3 };
	}
	nav.detour = clearSpot(w, radius + 0.2);
	nav.detourTime = DETOUR_HOLD;
	nav.steerObs = -1;
}
