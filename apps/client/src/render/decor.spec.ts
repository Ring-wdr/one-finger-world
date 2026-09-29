import { isClear, MAP_PROPS, MAP_RADIUS, PROP_VARIANTS, RING } from '@ofa/sim';
import { describe, expect, it } from 'vitest';
import { DECOR, DECOR_RINGS, DECOR_VARIANTS, layoutDecor } from './decor';

describe('ground decoration', () => {
	it('is the same layout every time', () => {
		expect(layoutDecor()).toEqual(DECOR);
	});

	it('dresses the whole map without carpeting it', () => {
		expect(DECOR.length).toBeGreaterThan(3000);
		expect(DECOR.length).toBeLessThan(7000);
		for (const variant of DECOR_VARIANTS) expect(DECOR.some((d) => d.variant === variant)).toBe(true);
	});

	it('stays on the map and clear of every rock and blocking prop', () => {
		const rocks = MAP_PROPS.filter((p) => p.kind === 'rock');
		const bad = DECOR.filter(
			(d) =>
				Math.hypot(d.x, d.y) >= MAP_RADIUS ||
				!isClear(d, 0.3) ||
				rocks.some((r) => Math.hypot(d.x - r.x, d.y - r.y) <= PROP_VARIANTS.rock[r.variant].footprint * r.scale)
		);
		expect(bad).toEqual([]);
	});

	it('follows the rings, blending only near their borders', () => {
		const allowed = (ring: keyof typeof DECOR_RINGS) => new Set(DECOR_RINGS[ring].mix.map(([v]) => v));
		for (const d of DECOR) {
			const r = Math.hypot(d.x, d.y);
			// Well inside a ring (past the blend and a patch's spread), only that ring's kinds appear.
			if (r < RING.center - 6) expect(allowed('center').has(d.variant)).toBe(true);
			else if (r > RING.center + 6 && r < RING.mid - 6) expect(allowed('mid').has(d.variant)).toBe(true);
			else if (r > RING.mid + 6) expect(allowed('outer').has(d.variant)).toBe(true);
		}
		// No embers out on the grass, no flowers in the scorched centre.
		expect(DECOR.some((d) => d.variant === 'embers' && Math.hypot(d.x, d.y) > RING.mid)).toBe(false);
		expect(DECOR.some((d) => d.variant === 'flowers' && Math.hypot(d.x, d.y) < RING.center)).toBe(false);
	});
});
