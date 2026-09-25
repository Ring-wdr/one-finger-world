import type { Rng } from './rng';
import { add, fromAngle, lerp, type Vec2 } from './vec';

export interface Circle {
	center: Vec2;
	radius: number;
}

export interface ZoneStage {
	/** Seconds the circle holds before shrinking. */
	wait: number;
	shrink: number;
	radius: number;
	/** Damage per second outside the circle during this stage. */
	dps: number;
}

/** ~5.5 min match. Zone timing is independent of the PvE rings on purpose. */
export const ZONE_STAGES: ZoneStage[] = [
	{ wait: 60, shrink: 30, radius: 90, dps: 2 },
	{ wait: 45, shrink: 30, radius: 60, dps: 4 },
	{ wait: 40, shrink: 25, radius: 35, dps: 7 },
	{ wait: 30, shrink: 25, radius: 15, dps: 12 },
	{ wait: 20, shrink: 20, radius: 0, dps: 25 }
];

export interface ZoneState {
	stage: number;
	stageStart: number;
	from: Circle;
	to: Circle;
	current: Circle;
	dps: number;
	shrinking: boolean;
	/** Seconds until the next state change (shrink start or stop). */
	timer: number;
}

function nextCircle(rng: Rng, from: Circle, radius: number): Circle {
	const slack = Math.max(0, from.radius - radius);
	const offset = fromAngle(rng.range(0, Math.PI * 2), Math.sqrt(rng.next()) * slack);
	return { center: add(from.center, offset), radius };
}

export function createZone(rng: Rng, mapRadius: number): ZoneState {
	const from: Circle = { center: { x: 0, y: 0 }, radius: mapRadius + 10 };
	const to = nextCircle(rng, from, ZONE_STAGES[0].radius);
	return {
		stage: 0,
		stageStart: 0,
		from,
		to,
		current: { center: { ...from.center }, radius: from.radius },
		dps: ZONE_STAGES[0].dps,
		shrinking: false,
		timer: ZONE_STAGES[0].wait
	};
}

/** Returns true when a new stage began this call. */
export function updateZone(zone: ZoneState, time: number, rng: Rng): boolean {
	const stage = ZONE_STAGES[zone.stage];
	if (!stage) {
		zone.current = { center: { ...zone.to.center }, radius: zone.to.radius };
		zone.shrinking = false;
		zone.timer = 0;
		return false;
	}

	const t = time - zone.stageStart;
	zone.dps = stage.dps;
	if (t < stage.wait) {
		zone.shrinking = false;
		zone.timer = stage.wait - t;
		zone.current = { center: { ...zone.from.center }, radius: zone.from.radius };
		return false;
	}
	if (t < stage.wait + stage.shrink) {
		const k = (t - stage.wait) / stage.shrink;
		zone.shrinking = true;
		zone.timer = stage.wait + stage.shrink - t;
		zone.current = {
			center: lerp(zone.from.center, zone.to.center, k),
			radius: zone.from.radius + (zone.to.radius - zone.from.radius) * k
		};
		return false;
	}

	zone.stage += 1;
	zone.stageStart = zone.stageStart + stage.wait + stage.shrink;
	zone.from = zone.to;
	zone.current = { center: { ...zone.from.center }, radius: zone.from.radius };
	const next = ZONE_STAGES[zone.stage];
	if (next) zone.to = nextCircle(rng, zone.from, next.radius);
	zone.shrinking = false;
	zone.timer = next?.wait ?? 0;
	return true;
}

export function isInside(zone: ZoneState, p: Vec2) {
	const dx = p.x - zone.current.center.x;
	const dy = p.y - zone.current.center.y;
	return dx * dx + dy * dy <= zone.current.radius * zone.current.radius;
}
