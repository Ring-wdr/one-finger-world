import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FEEDBACK_SPRING,
	createSpringPoint,
	isThumbPointVisible,
	stepSpringPoint
} from './feedbackPhysics';

describe('feedbackPhysics', () => {
	it('hides the thumb marker when it is effectively the same as the start point', () => {
		expect(isThumbPointVisible({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false);
		expect(isThumbPointVisible({ x: 100, y: 100 }, { x: 104, y: 103 })).toBe(false);
		expect(isThumbPointVisible({ x: 100, y: 100 }, { x: 107, y: 100 })).toBe(true);
	});

	it('moves a spring point toward the target with deterministic damping', () => {
		const point = createSpringPoint(0, 0);

		stepSpringPoint(point, { x: 1, y: 0 }, 0.016, DEFAULT_FEEDBACK_SPRING);

		expect(point.x).toBeCloseTo(0.03072, 5);
		expect(point.y).toBe(0);
		expect(point.vx).toBeCloseTo(1.92, 5);
		expect(point.vy).toBe(0);
	});

	it('ignores non-positive or invalid delta time', () => {
		const point = createSpringPoint(0, 0);

		stepSpringPoint(point, { x: 5, y: 5 }, 0, DEFAULT_FEEDBACK_SPRING);
		stepSpringPoint(point, { x: 5, y: 5 }, Number.NaN, DEFAULT_FEEDBACK_SPRING);

		expect(point).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
	});
});
