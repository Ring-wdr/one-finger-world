import type { World } from './types';

/**
 * A structured-clone- and JSON-safe copy of a World, for Durable Object storage: the RNG travels
 * as its state, per-tick events are dropped and derived caches are rebuilt on restore.
 */
export interface WorldCheckpoint {
	v: 1;
	tick: number;
	world: unknown;
}

export function checkpointWorld(world: World): WorldCheckpoint {
	void world;
	throw new Error('not implemented yet (T1)');
}

/** A World that continues exactly as the checkpointed one would have, given the same inputs. */
export function restoreWorld(cp: WorldCheckpoint): World {
	void cp;
	throw new Error('not implemented yet (T1)');
}
