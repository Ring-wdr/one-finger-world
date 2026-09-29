import type { GameEvent, Vec2, World } from '@ofa/sim';
import { todo } from './todo';

/** Interest management (docs/multiplayer-server-design.md §10.5). */

/** The AOI circle's center for a focus fighter, or null when that fighter is gone or dead. */
export function aoiCenter(world: World, focusId: number | null): Vec2 | null {
	return todo('T3', world, focusId);
}

/** Whether `p` lies within AOI_RADIUS + margin of `center`. */
export function inAoi(center: Vec2, p: Vec2, margin = 0): boolean {
	return todo('T3', center, p, margin);
}

/**
 * The fighter a viewer's AOI follows: its own fighter while alive, else the requested spectate
 * target if alive, else whoever last hit it if alive, else the lowest-id living fighter.
 */
export function pickFocus(world: World, selfId: number | null, spectateId: number | null): number | null {
	return todo('T3', world, selfId, spectateId);
}

/** Whether a viewer (AOI `center`, own fighter `selfId`) should receive `e`. */
export function eventVisible(e: GameEvent, center: Vec2 | null, selfId: number | null): boolean {
	return todo('T3', e, center, selfId);
}
