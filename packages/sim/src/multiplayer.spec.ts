import { describe, expect, it } from 'vitest';
import { createWorld, newBotBrain, setBotControl, step } from './world';
import { Rng } from './rng';

/** FNV-1a over the JSON form; the baselines were recorded (under Vitest) before the multiplayer change. */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function hashAfter(opts: Parameters<typeof createWorld>[0]) {
	const { world } = createWorld(opts);
	for (let i = 0; i < 600; i++) step(world);
	return fnv1a(JSON.stringify(world));
}

describe('legacy worlds stay bit-identical', () => {
	it('single human via playerName', () => {
		expect(hashAfter({ seed: 42, fighters: 12, playerName: '나', playerRunes: ['rune_power'] })).toBe(2820752138);
	});
	it('all-bot world', () => {
		expect(hashAfter({ seed: 7, fighters: 12 })).toBe(2196213526);
	});
});

describe('createWorld with humans', () => {
	const seats = [
		{ name: 'A', runes: ['rune_vital'] },
		{ name: 'B' },
		{ name: 'C', runes: ['rune_power'] }
	];

	it('seats humans first and leaves the rest to bots', () => {
		const { world, playerId, humanIds } = createWorld({ seed: 1, fighters: 12, humans: seats });
		expect(world.fighters).toHaveLength(12);
		const humans = world.fighters.slice(0, 3);
		expect(humans.map((f) => f.name)).toEqual(['A', 'B', 'C']);
		expect(humans.every((f) => f.bot === null)).toBe(true);
		expect(world.fighters.slice(3).every((f) => f.bot !== null)).toBe(true);
		expect(humanIds).toEqual(humans.map((f) => f.id));
		expect(playerId).toBe(humanIds[0]);
		expect(new Set(humans.map((f) => f.color)).size).toBe(3);
		expect(humans.some((f) => f.color === '#ffffff')).toBe(false);
		expect(humans[0].build.stats.maxHp).toBeGreaterThan(humans[1].build.stats.maxHp);
		expect(humans[2].build.stats.damage).toBeGreaterThan(humans[1].build.stats.damage);
	});

	it('has no player without humans or playerName', () => {
		const r = createWorld({ seed: 1, fighters: 12 });
		expect(r.playerId).toBeNull();
		expect(r.humanIds).toEqual([]);
		expect(createWorld({ seed: 1, fighters: 12, humans: [] }).playerId).toBeNull();
	});

	it('rejects invalid combinations', () => {
		expect(() => createWorld({ seed: 1, fighters: 12, humans: seats, playerName: 'x' })).toThrow(TypeError);
		expect(() => createWorld({ seed: 1, fighters: 2, humans: seats })).toThrow(RangeError);
	});
});

describe('newBotBrain', () => {
	it('draws tags, risk and think timer from the rng in a fixed order', () => {
		const a = new Rng(5);
		const brain = newBotBrain(a, true);
		expect(brain.aggressive).toBe(true);
		expect(brain.prefTags).toHaveLength(2);
		expect(brain.mode).toBe('roam');
		expect(newBotBrain(new Rng(5))).toEqual({ ...brain, aggressive: false });
	});
});

describe('setBotControl', () => {
	const setup = () => {
		const { world, humanIds } = createWorld({ seed: 3, fighters: 12, humans: [{ name: 'A' }, { name: 'B' }] });
		return { world, id: humanIds[0], fighter: world.fighters[0] };
	};

	it('hands a standing human to the AI, which starts moving', () => {
		const { world, id, fighter } = setup();
		setBotControl(world, id, true);
		expect(fighter.bot).not.toBeNull();
		expect(fighter.bot!.thinkTimer).toBe(0);
		let moved = false;
		for (let i = 0; i < 20 && !moved; i++) {
			step(world);
			moved = fighter.moveDir !== null;
		}
		expect(moved).toBe(true);
	});

	it('hands control back and clears queued AI input', () => {
		const { world, id, fighter } = setup();
		setBotControl(world, id, true);
		for (let i = 0; i < 20; i++) step(world);
		fighter.running = true;
		fighter.attackQueued = 1;
		setBotControl(world, id, false);
		expect(fighter.bot).toBeNull();
		expect(fighter.moveDir).toBeNull();
		expect(fighter.running).toBe(false);
		expect(fighter.attackQueued).toBe(0);
	});

	it('is a no-op when already in the requested state', () => {
		const { world, id, fighter } = setup();
		const rngBefore = world.rng.state;
		setBotControl(world, id, false);
		expect(fighter.bot).toBeNull();
		expect(world.rng.state).toBe(rngBefore);
		setBotControl(world, id, true);
		const brain = fighter.bot;
		const rngAfterOn = world.rng.state;
		setBotControl(world, id, true);
		expect(fighter.bot).toBe(brain);
		expect(world.rng.state).toBe(rngAfterOn);
	});

	it('ignores dead and missing fighters', () => {
		const { world, id, fighter } = setup();
		fighter.alive = false;
		const rngBefore = world.rng.state;
		setBotControl(world, id, true);
		expect(fighter.bot).toBeNull();
		setBotControl(world, 9999, true);
		expect(world.rng.state).toBe(rngBefore);
	});
});
