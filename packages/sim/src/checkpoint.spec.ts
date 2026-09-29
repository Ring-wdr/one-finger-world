import { describe, expect, it } from 'vitest';
import { checkpointWorld, restoreWorld, type WorldCheckpoint } from './checkpoint';
import { Rng } from './rng';
import type { Command, World } from './types';
import { createWorld, step } from './world';

/** Seeded pseudo-random inputs for the human seats, so both worlds see the same commands. */
function commandsFor(rng: Rng, ids: readonly number[]): Map<number, Command[]> {
	const out = new Map<number, Command[]>();
	for (const id of ids) {
		const cmds: Command[] = [];
		if (rng.chance(0.2)) {
			const a = rng.range(0, Math.PI * 2);
			cmds.push({ type: 'move', dir: rng.chance(0.1) ? null : { x: Math.cos(a), y: Math.sin(a) }, run: rng.chance(0.5) });
		}
		if (rng.chance(0.1)) cmds.push({ type: 'attack' });
		if (rng.chance(0.03)) cmds.push({ type: 'dash', dir: { x: 1, y: 0 } });
		if (rng.chance(0.05)) cmds.push({ type: 'draft', index: rng.int(3) });
		out.set(id, cmds);
	}
	return out;
}

function setup() {
	const { world, humanIds } = createWorld({
		seed: 11,
		fighters: 12,
		humans: [{ name: 'A', runes: ['rune_power'] }, { name: 'B' }]
	});
	const inputs = new Rng(99);
	for (let i = 0; i < 300; i++) step(world, commandsFor(inputs, humanIds));
	return { world, humanIds, inputs };
}

describe('checkpoints', () => {
	it('a restored world continues identically to the original', () => {
		const { world: a, humanIds, inputs } = setup();
		const b = restoreWorld(checkpointWorld(a));
		expect(b.rng.state).toBe(a.rng.state);
		const inputsB = new Rng(inputs.state);
		for (let i = 0; i < 900; i++) {
			step(a, commandsFor(inputs, humanIds));
			step(b, commandsFor(inputsB, humanIds));
		}
		expect(JSON.stringify(b)).toBe(JSON.stringify(a));
		expect(b.rng.state).toBe(a.rng.state);
	});

	it('does not alias the live world and drops events', () => {
		const { world } = setup();
		world.events.push({ type: 'x' } as never);
		const cp = checkpointWorld(world);
		expect(cp.v).toBe(1);
		expect(cp.tick).toBe(world.tick);
		const snapshot = JSON.stringify(cp);
		world.fighters[0].hp = -5;
		world.fighters[0].pos.x += 100;
		world.rng.next();
		expect(JSON.stringify(cp)).toBe(snapshot);
		expect((cp.world as World).events).toEqual([]);
	});

	it('can be restored twice into independent worlds', () => {
		const { world } = setup();
		const cp = checkpointWorld(world);
		const w1 = restoreWorld(cp);
		const w2 = restoreWorld(cp);
		w1.fighters[0].hp = 1;
		step(w1);
		expect(w2.fighters[0].hp).toBe(world.fighters[0].hp);
		expect(w2.tick).toBe(world.tick);
	});

	it('survives structuredClone and keeps -0, NaN and Infinity', () => {
		const { world } = setup();
		world.fighters[0].pos.x = -0;
		world.fighters[0].hp = NaN;
		world.fighters[0].shield = Infinity;
		const cp = structuredClone(checkpointWorld(world));
		const restored = restoreWorld(cp);
		expect(Object.is(restored.fighters[0].pos.x, -0)).toBe(true);
		expect(restored.fighters[0].hp).toBeNaN();
		expect(restored.fighters[0].shield).toBe(Infinity);
	});

	it('rejects unknown versions', () => {
		const { world } = setup();
		const cp = { ...checkpointWorld(world), v: 2 } as unknown as WorldCheckpoint;
		expect(() => restoreWorld(cp)).toThrow(TypeError);
	});
});
