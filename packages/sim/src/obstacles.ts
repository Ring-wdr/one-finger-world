/**
 * Static map props and the collision circles derived from them — the single source of truth
 * for terrain. The renderer draws `MAP_PROPS` as-is (same positions, scales, yaws and model
 * variants), so what blocks a unit is exactly what the player sees.
 *
 * Layout is fixed (its own seeds, independent of the match seed), so every match and the
 * tutorial share one map.
 */
import { Rng } from './rng';
import { MAP_RADIUS, RING } from './types';
import type { Vec2 } from './vec';

export type PropKind = 'rock' | 'tree' | 'deadTree';

export interface MapProp {
	kind: PropKind;
	/** Sim ground position. */
	x: number;
	y: number;
	/** Uniform model scale. */
	scale: number;
	/** Renderer yaw (radians about the vertical axis). */
	yaw: number;
	/** Model variant index into PROP_VARIANTS[kind]. */
	variant: number;
	/** Collision radius; 0 = decoration the units walk over. */
	r: number;
}

export interface Obstacle {
	x: number;
	y: number;
	r: number;
}

/**
 * Model variants per kind, in the renderer's order, with each model's ground footprint
 * (farthest vertex from the pivot in the ground plane, at scale 1 after the manifest's own
 * model scale). Measured from `models/props/nature.glb`.
 */
export const PROP_VARIANTS: Record<PropKind, readonly { name: string; footprint: number }[]> = {
	// rock_* × manifest scale 5
	rock: [
		{ name: 'a', footprint: 0.157 * 5 },
		{ name: 'b', footprint: 0.157 * 5 },
		{ name: 'c', footprint: 0.187 * 5 },
		{ name: 'd', footprint: 0.156 * 5 },
		{ name: 'e', footprint: 0.26 * 5 }
	],
	// Trees collide on their trunk only; the canopy overhangs.
	tree: [
		{ name: 'a', footprint: 0.3 },
		{ name: 'b', footprint: 0.3 }
	],
	deadTree: [
		{ name: 'small', footprint: 0.22 },
		{ name: 'medium', footprint: 0.24 },
		{ name: 'large', footprint: 0.24 }
	]
};

/** A rock's footprint is its farthest vertex; the body reads a little smaller than that. */
const ROCK_BODY = 0.85;
/** Rocks smaller than this are pebbles: visual only. */
const MIN_ROCK_RADIUS = 0.4;

/** Areas kept free of anything that blocks: map centre (sandbox/tutorial start). */
const CLEARINGS: { x: number; y: number; r: number }[] = [{ x: 0, y: 0, r: 16 }];

/** Blocking props keep at least this gap from the map edge. */
const EDGE_GAP = 2;

function generateProps(): MapProp[] {
	// Positions keep the renderer's original seeds and draw order; `look` picks variant/yaw.
	const rng = new Rng(1234);
	const look = new Rng(77);
	const props: MapProp[] = [];
	// Renderer placed at three (cos a·r, 0, sin a·r); sim y = −three z.
	const at = (r: number, a: number) => ({ x: Math.cos(a) * r, y: -Math.sin(a) * r });
	for (let i = 0; i < 220; i++) {
		const r = Math.sqrt(rng.next()) * MAP_RADIUS;
		const a = rng.range(0, Math.PI * 2);
		const scale = rng.range(0.4, 1.4);
		const yaw = rng.range(0, 6);
		const variant = look.int(PROP_VARIANTS.rock.length);
		const radius = PROP_VARIANTS.rock[variant].footprint * scale * ROCK_BODY;
		props.push({ kind: 'rock', ...at(r, a), scale, yaw, variant, r: radius >= MIN_ROCK_RADIUS ? radius : 0 });
	}
	for (let i = 0; i < 160; i++) {
		const r = RING.mid + rng.next() * (MAP_RADIUS - RING.mid);
		const a = rng.range(0, Math.PI * 2);
		const scale = rng.range(0.7, 1.3);
		const yaw = look.range(0, Math.PI * 2);
		const variant = look.int(PROP_VARIANTS.tree.length);
		props.push({ kind: 'tree', ...at(r, a), scale, yaw, variant, r: PROP_VARIANTS.tree[variant].footprint * scale });
	}
	// Sparse dead trees in the middle ring: the land withers toward the centre.
	const dead = new Rng(4321);
	for (let i = 0; i < 45; i++) {
		const r = RING.center + dead.next() * (RING.mid - RING.center);
		const a = dead.range(0, Math.PI * 2);
		const scale = dead.range(0.8, 1.2);
		const yaw = dead.range(0, Math.PI * 2);
		const variant = look.int(PROP_VARIANTS.deadTree.length);
		props.push({
			kind: 'deadTree',
			...at(r, a),
			scale,
			yaw,
			variant,
			r: PROP_VARIANTS.deadTree[variant].footprint * scale
		});
	}
	for (const p of props) {
		// Props straddling the map edge stay visual: units pinned between one and the edge
		// clamp would have nowhere to go.
		if (p.r > 0 && Math.hypot(p.x, p.y) + p.r > MAP_RADIUS - EDGE_GAP) p.r = 0;
	}
	return props.filter(
		(p) => p.r === 0 || !CLEARINGS.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + p.r)
	);
}

export const MAP_PROPS: readonly MapProp[] = generateProps();
export const OBSTACLES: readonly Obstacle[] = MAP_PROPS.filter((p) => p.r > 0).map(({ x, y, r }) => ({ x, y, r }));

// ---------------------------------------------------------------------------------------------
// Spatial grid

const CELL = 4;
/**
 * Each cell lists every obstacle within PAD of it, so a query reaching up to PAD reads a
 * single cell (no merging, no dedupe). Wider queries merge cells.
 */
const PAD = 4;
const GRID_HALF = MAP_RADIUS + 8;
const GRID_N = Math.ceil((GRID_HALF * 2) / CELL);
const cells: number[][] = Array.from({ length: GRID_N * GRID_N }, () => []);
const padded: number[][] = Array.from({ length: GRID_N * GRID_N }, () => []);
/** Largest obstacle radius: how far a query must reach to see every overlap. */
const MAX_R = OBSTACLES.reduce((m, o) => Math.max(m, o.r), 0);
const cellOf = (v: number) => Math.min(GRID_N - 1, Math.max(0, Math.floor((v + GRID_HALF) / CELL)));
OBSTACLES.forEach((o, i) => {
	for (let cy = cellOf(o.y - o.r); cy <= cellOf(o.y + o.r); cy++) {
		for (let cx = cellOf(o.x - o.r); cx <= cellOf(o.x + o.r); cx++) cells[cy * GRID_N + cx].push(i);
	}
	const e = o.r + PAD;
	for (let cy = cellOf(o.y - e); cy <= cellOf(o.y + e); cy++) {
		for (let cx = cellOf(o.x - e); cx <= cellOf(o.x + e); cx++) padded[cy * GRID_N + cx].push(i);
	}
});
const seen = new Uint32Array(OBSTACLES.length);
let stamp = 0;
/** Reused result buffer of wide `candidates` queries (valid until the next call). */
const found: number[] = [];

/**
 * Indices of every obstacle that may lie within `reach` of (x, y) — a coarse filter, callers
 * still test exact distances. Fixed order, so results are deterministic. The returned array
 * must not be modified and is only valid until the next call.
 */
function candidates(x: number, y: number, reach: number): readonly number[] {
	if (reach <= PAD) return padded[cellOf(y) * GRID_N + cellOf(x)];
	stamp = (stamp + 1) >>> 0;
	if (stamp === 0) {
		seen.fill(0);
		stamp = 1;
	}
	found.length = 0;
	const x0 = cellOf(x - reach);
	const x1 = cellOf(x + reach);
	const y0 = cellOf(y - reach);
	const y1 = cellOf(y + reach);
	for (let cy = y0; cy <= y1; cy++) {
		for (let cx = x0; cx <= x1; cx++) {
			const cell = cells[cy * GRID_N + cx];
			for (let k = 0; k < cell.length; k++) {
				const i = cell[k];
				if (seen[i] === stamp) continue;
				seen[i] = stamp;
				found.push(i);
			}
		}
	}
	return found;
}

/** Calls `fn` once for every obstacle near (x, y) ± reach (coarse, see `candidates`). */
export function forEachObstacleNear(x: number, y: number, reach: number, fn: (o: Obstacle, index: number) => void) {
	const list = candidates(x, y, reach);
	for (let k = 0; k < list.length; k++) fn(OBSTACLES[list[k]], list[k]);
}

/** The obstacle a circle (p, radius) overlaps the deepest, or null. */
export function overlappingObstacle(p: Vec2, radius: number): Obstacle | null {
	let best: Obstacle | null = null;
	let bestDepth = 0;
	const list = candidates(p.x, p.y, radius + 0.1);
	for (let k = 0; k < list.length; k++) {
		const o = OBSTACLES[list[k]];
		const depth = o.r + radius - Math.hypot(p.x - o.x, p.y - o.y);
		if (depth > bestDepth + 1e-9) {
			bestDepth = depth;
			best = o;
		}
	}
	return best;
}

let outX = 0;
let outY = 0;
let pushed = false;

/** Pushes (x, y) out of overlapping obstacles into outX/outY; false if it didn't settle. */
function pushOut(x: number, y: number, radius: number): boolean {
	const list = candidates(x, y, radius + MAX_R);
	pushed = false;
	// Wedged between two rocks the pushes alternate and converge on the gap's corner.
	for (let iter = 0; iter < 10; iter++) {
		let moved = false;
		for (let k = 0; k < list.length; k++) {
			const o = OBSTACLES[list[k]];
			const dx = x - o.x;
			const dy = y - o.y;
			const min = o.r + radius;
			const d2 = dx * dx + dy * dy;
			if (d2 >= min * min) continue;
			const d = Math.sqrt(d2);
			// Dead centre: fall out toward +x so the result stays deterministic.
			const nx = d > 1e-9 ? dx / d : 1;
			const ny = d > 1e-9 ? dy / d : 0;
			x = o.x + nx * (min + 1e-4);
			y = o.y + ny * (min + 1e-4);
			moved = true;
			pushed = true;
		}
		if (!moved) {
			outX = x;
			outY = y;
			return true;
		}
	}
	outX = x;
	outY = y;
	return false;
}

/**
 * Pushes a circle out of every obstacle it overlaps, along each obstacle's normal. Movement
 * into a rock therefore keeps only its tangential part: units slide along the surface.
 */
export function resolveObstacles(p: Vec2, radius: number): Vec2 {
	pushOut(p.x, p.y, radius);
	return pushed ? { x: outX, y: outY } : p;
}

/** Largest single move before re-resolving, so fast movers (dash) can't tunnel through. */
const SUBSTEP = 0.4;

/**
 * Moves by `delta`, resolving against obstacles in small substeps (slides, never tunnels).
 * A substep that can't settle (a gap narrower than the unit) is dropped, so a unit that
 * starts clear always ends clear.
 */
export function moveWithCollision(from: Vec2, delta: Vec2, radius: number): Vec2 {
	const l = Math.hypot(delta.x, delta.y);
	const n = Math.max(1, Math.ceil(l / SUBSTEP));
	let x = from.x;
	let y = from.y;
	for (let i = 0; i < n; i++) {
		if (!pushOut(x + delta.x / n, y + delta.y / n, radius)) break;
		x = outX;
		y = outY;
	}
	return { x, y };
}

/** A nearby free spot for a circle (always a fresh object): `p` when clear, else pushed out. */
export function clearSpot(p: Vec2, radius: number): Vec2 {
	pushOut(p.x, p.y, radius);
	return { x: outX, y: outY };
}

/** True when a circle of `radius` at `p` overlaps no obstacle. */
export function isClear(p: Vec2, radius: number): boolean {
	return overlappingObstacle(p, radius) === null;
}
