import type { ScreenPoint } from '$lib/game/types';

export interface SpringPoint {
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface SpringConfig {
	stiffness: number;
	damping: number;
}

export const SAME_POINT_EPSILON_PX = 6;

export const DEFAULT_FEEDBACK_SPRING: SpringConfig = {
	stiffness: 120,
	damping: 18
};

export function createSpringPoint(x = 0, y = 0): SpringPoint {
	return { x, y, vx: 0, vy: 0 };
}

export function isThumbPointVisible(
	start: ScreenPoint,
	thumb: ScreenPoint,
	epsilonPx = SAME_POINT_EPSILON_PX
) {
	return Math.hypot(thumb.x - start.x, thumb.y - start.y) >= epsilonPx;
}

export function stepSpringPoint(
	point: SpringPoint,
	target: ScreenPoint,
	deltaSeconds: number,
	config: SpringConfig
) {
	if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return point;

	const ax = (target.x - point.x) * config.stiffness - point.vx * config.damping;
	const ay = (target.y - point.y) * config.stiffness - point.vy * config.damping;

	point.vx += ax * deltaSeconds;
	point.vy += ay * deltaSeconds;
	point.x += point.vx * deltaSeconds;
	point.y += point.vy * deltaSeconds;

	return point;
}
