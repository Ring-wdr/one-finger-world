import type { GameEvent, Vec2, World } from '@ofa/sim';
import { AOI_NORTH_OFFSET, AOI_RADIUS, EVENT_MARGIN } from './constants';

/** Interest management (docs/multiplayer-server-design.md §10.5). */

/** The AOI circle's center for a focus fighter, or null when that fighter is gone or dead. */
export function aoiCenter(world: World, focusId: number | null): Vec2 | null {
	const f = focusId === null ? undefined : world.fighters.find((u) => u.id === focusId);
	if (!f || !f.alive) return null;
	return { x: f.pos.x, y: f.pos.y + AOI_NORTH_OFFSET };
}

/** Whether `p` lies within AOI_RADIUS + margin of `center`. */
export function inAoi(center: Vec2, p: Vec2, margin = 0): boolean {
	const r = AOI_RADIUS + margin;
	return (p.x - center.x) ** 2 + (p.y - center.y) ** 2 <= r * r;
}

/**
 * The fighter a viewer's AOI follows: its own fighter while alive, else the requested spectate
 * target if alive, else whoever last hit it if alive, else the lowest-id living fighter.
 */
export function pickFocus(world: World, selfId: number | null, spectateId: number | null): number | null {
	const living = (id: number | null) => (id === null ? undefined : world.fighters.find((f) => f.id === id && f.alive));
	const self = world.fighters.find((f) => f.id === selfId);
	const pick = (self?.alive ? self : undefined) ?? living(spectateId) ?? living(self?.lastAttacker ?? null);
	if (pick) return pick.id;
	let lowest: number | null = null;
	for (const f of world.fighters) if (f.alive && (lowest === null || f.id < lowest)) lowest = f.id;
	return lowest;
}

/** Whether a viewer (AOI `center`, own fighter `selfId`) should receive `e`. */
export function eventVisible(e: GameEvent, center: Vec2 | null, selfId: number | null): boolean {
	const near = (p: Vec2) => center !== null && inAoi(center, p, EVENT_MARGIN);
	switch (e.type) {
		case 'phase':
		case 'zone':
		case 'end':
			return true;
		case 'death':
			return e.kind === 'fighter' || near(e.pos);
		case 'levelUp':
		case 'synergy':
		case 'pickup':
			return e.unit === selfId;
		case 'hit':
			return (selfId !== null && (e.target === selfId || e.src === selfId)) || near(e.pos);
		case 'attack':
		case 'skill':
			return e.unit === selfId || near(e.pos);
		case 'dash':
			return e.unit === selfId || near(e.from) || near(e.to);
		case 'drop':
		case 'explode':
			return near(e.pos);
	}
}
