import { isClear, MAP_PROPS, MAP_RADIUS, PROP_VARIANTS, RING, Rng } from '@ofa/sim';

/**
 * Ground decoration: grass, flowers, pebbles, twigs, bones, embers — scattered over the terrain
 * to dress it, never to block. Purely visual, so it lives here rather than in the sim: units
 * walk straight through it and it has no say in collision or line of sight.
 *
 * The layout is fixed (its own seed), like the map props, and follows the rings the terrain
 * paints: lush grass outside, dry dirt in the middle, scorched earth in the centre.
 */

export const DECOR_VARIANTS = ['grass', 'grass_dry', 'flowers', 'bush', 'mushrooms', 'pebbles', 'twigs', 'bones', 'stump', 'embers'] as const;
export type DecorVariant = (typeof DECOR_VARIANTS)[number];

export interface Decor {
	variant: DecorVariant;
	/** Sim ground position. */
	x: number;
	y: number;
	scale: number;
	/** Renderer yaw (radians about the vertical axis). */
	yaw: number;
}

type Ring = 'outer' | 'mid' | 'center';

/** Per ring: the chance a grid cell holds something at all, and the mix of what it holds. */
export const DECOR_RINGS: Record<Ring, { density: number; mix: readonly [DecorVariant, number][] }> = {
	outer: {
		density: 0.26,
		mix: [['grass', 50], ['flowers', 14], ['pebbles', 13], ['bush', 9], ['grass_dry', 8], ['mushrooms', 6]]
	},
	mid: {
		density: 0.2,
		mix: [['grass_dry', 46], ['pebbles', 20], ['twigs', 18], ['grass', 8], ['bones', 8]]
	},
	center: {
		density: 0.14,
		mix: [['pebbles', 34], ['embers', 28], ['stump', 20], ['bones', 18]]
	}
};

/** Grass and flowers grow in patches: one spot sprouts several pieces around it. */
const PATCH: Partial<Record<DecorVariant, { min: number; max: number; spread: number }>> = {
	grass: { min: 3, max: 5, spread: 0.9 },
	grass_dry: { min: 2, max: 4, spread: 0.9 },
	flowers: { min: 2, max: 4, spread: 0.7 }
};

/** Grid spacing of candidate spots; each is jittered within its cell. */
const STEP = 2.2;
/** Ring borders blend over ± this much, as the terrain's own borders wander. */
const BORDER = 5;
/** Kept clear of every rock (their footprint), and of blocking props by this radius. */
const CLEARANCE = 0.3;

/** Smooth value noise in [0, 1], for clumping. */
function valueNoise(x: number, y: number): number {
	const hash = (i: number, j: number) => {
		const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
		return s - Math.floor(s);
	};
	const i = Math.floor(x);
	const j = Math.floor(y);
	const fx = x - i;
	const fy = y - j;
	const ux = fx * fx * (3 - 2 * fx);
	const uy = fy * fy * (3 - 2 * fy);
	const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * ux;
	const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * ux;
	return a + (b - a) * uy;
}

const ringAt = (r: number): Ring => (r < RING.center ? 'center' : r < RING.mid ? 'mid' : 'outer');

/** The variant a roll in [0, 1) lands on, by weight. */
function pick(mix: readonly [DecorVariant, number][], roll: number): DecorVariant {
	let t = roll * mix.reduce((sum, [, w]) => sum + w, 0);
	for (const [variant, w] of mix) {
		t -= w;
		if (t < 0) return variant;
	}
	return mix[mix.length - 1][0];
}

export function layoutDecor(seed = 2468): Decor[] {
	const rng = new Rng(seed);
	const rocks = MAP_PROPS.filter((p) => p.kind === 'rock').map((p) => ({
		x: p.x,
		y: p.y,
		r: PROP_VARIANTS.rock[p.variant].footprint * p.scale
	}));
	const out: Decor[] = [];
	const n = Math.ceil(MAP_RADIUS / STEP);
	for (let gy = -n; gy < n; gy++) {
		for (let gx = -n; gx < n; gx++) {
			// Every cell draws the same numbers whether or not it's used, so tuning one ring's
			// density doesn't reshuffle the others.
			const x = (gx + rng.next()) * STEP;
			const y = (gy + rng.next()) * STEP;
			const roll = rng.next();
			const border = rng.range(-BORDER, BORDER);
			const choice = rng.next();
			const patchSeed = rng.next();
			const r = Math.hypot(x, y);
			if (r > MAP_RADIUS - 1) continue;
			const ring = DECOR_RINGS[ringAt(r + border)];
			// Clumps: meadows and bare patches rather than an even carpet.
			const clump = valueNoise(x * 0.07 + 11, y * 0.07 - 5);
			if (roll > ring.density * (0.3 + 1.4 * clump)) continue;
			const variant = pick(ring.mix, choice);
			const patch = PATCH[variant];
			const sub = new Rng(Math.floor(patchSeed * 4294967296));
			const count = patch ? patch.min + sub.int(patch.max - patch.min + 1) : 1;
			for (let i = 0; i < count; i++) {
				const a = sub.range(0, Math.PI * 2);
				const d = i === 0 || !patch ? 0 : patch.spread * Math.sqrt(sub.next());
				const px = x + Math.cos(a) * d;
				const py = y + Math.sin(a) * d;
				const scale = sub.range(0.75, 1.3);
				const yaw = sub.range(0, Math.PI * 2);
				if (Math.hypot(px, py) > MAP_RADIUS - 1) continue;
				if (rocks.some((k) => Math.hypot(px - k.x, py - k.y) < k.r + CLEARANCE)) continue;
				if (!isClear({ x: px, y: py }, CLEARANCE)) continue;
				out.push({ variant, x: px, y: py, scale, yaw });
			}
		}
	}
	return out;
}

export const DECOR: readonly Decor[] = layoutDecor();
