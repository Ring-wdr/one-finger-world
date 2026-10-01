import { reindex } from './combat';
import { Rng } from './rng';
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
	return {
		v: 1,
		tick: world.tick,
		world: structuredClone({ ...world, rng: { state: world.rng.state }, events: [] })
	};
}

/** A World that continues exactly as the checkpointed one would have, given the same inputs. */
export function restoreWorld(cp: WorldCheckpoint): World {
	if (cp.v !== 1) throw new TypeError(`restoreWorld: unsupported checkpoint version ${String(cp.v)}`);
	// Copy again so the same checkpoint can be restored more than once.
	const saved = structuredClone(cp.world) as Omit<World, 'rng'> & { rng: { state: number } };
	const rng = new Rng(0);
	rng.state = saved.rng.state;
	const world: World = { ...saved, rng };
	reindex(world);
	return world;
}
