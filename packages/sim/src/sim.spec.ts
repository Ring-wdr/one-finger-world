import { describe, expect, it } from 'vitest';
import { summarizeBuild, usesRangedBasic } from './build';
import { rollOffer } from './draft';
import { ITEMS, MAX_SKILLS, WEAPON_IDS, getItem } from './items';
import { Rng } from './rng';
import { deriveStats, modBudget, softCap } from './stats';
import { createWorld, runHeadless, spawnFighter, step } from './world';
import { spawnMonster } from './monsters';
import { createZone, updateZone, ZONE_STAGES } from './zone';
import { DT, type Command } from './types';
import { dealDamage } from './combat';
import { dist } from './vec';

describe('soft cap', () => {
	it('is linear below the knee and diminishing above it', () => {
		expect(softCap(0.3, 0.6)).toBeCloseTo(0.3);
		const a = softCap(0.9, 0.6) - softCap(0.6, 0.6);
		const b = softCap(1.2, 0.6) - softCap(0.9, 0.6);
		expect(a).toBeLessThan(0.3);
		expect(b).toBeLessThan(a);
		expect(softCap(5, 0.6)).toBeGreaterThan(softCap(4, 0.6));
	});

	it('makes a second stat axis worth more than over-stacking one', () => {
		const stacked = deriveStats(Array(8).fill({ stat: 'power', value: 0.1 }));
		const split = deriveStats([
			...Array(4).fill({ stat: 'power', value: 0.1 }),
			...Array(4).fill({ stat: 'haste', value: 0.12 })
		]);
		const dps = (s: typeof stacked) => s.damage * s.attackRate;
		expect(dps(split)).toBeGreaterThan(dps(stacked));
	});
});

describe('item design rules', () => {
	it('every strong item carries a trade-off', () => {
		for (const item of ITEMS) {
			const { positive, negative } = modBudget(item.mods);
			if (item.rarity !== 'common' || positive > 1.3) {
				expect(negative, `${item.id} needs a trade-off`).toBeGreaterThanOrEqual(0.3);
			}
		}
	});

	it('keeps net stat budget flat across rarities (rarity buys synergy width, not numbers)', () => {
		for (const item of ITEMS) {
			const { net } = modBudget(item.mods);
			if (item.kind === 'weapon') {
				expect(Math.abs(net), item.id).toBeLessThanOrEqual(1);
				continue;
			}
			if (item.kind === 'skill') expect(net, item.id).toBeLessThanOrEqual(0);
			else if (item.rarity === 'common') expect(net, item.id).toBeGreaterThanOrEqual(0.8);
			if (item.rarity === 'common') expect(net, item.id).toBeLessThanOrEqual(1.3);
			if (item.rarity === 'rare' && item.kind === 'stat') expect(net, item.id).toBeLessThanOrEqual(2);
			if (item.rarity === 'legendary') expect(net, item.id).toBeLessThanOrEqual(1);
		}
	});

	it('legendaries are bridges between two of their own tags', () => {
		for (const item of ITEMS.filter((i) => i.rarity === 'legendary')) {
			expect(item.bridge, item.id).toBeDefined();
			expect(item.tags).toContain(item.bridge!.from);
			expect(item.tags).toContain(item.bridge!.to);
		}
	});
});

describe('build synergies', () => {
	it('activates tiers at the thresholds', () => {
		expect(summarizeBuild(['ember_ring', 'cinder_gloves']).tiers.fire).toBe(0);
		expect(summarizeBuild(['ember_ring', 'cinder_gloves', 'burning_edge']).tiers.fire).toBe(1);
	});

	it('bridges feed half of one tag into another', () => {
		const bleedy = ['serrated', 'blood_charm', 'serrated', 'blood_charm'];
		const without = summarizeBuild(bleedy);
		const withBridge = summarizeBuild([...bleedy, 'purgatory']);
		expect(without.tagCounts.fire).toBe(0);
		// 5 bleed (4 + bridge's own) → +2 fire, plus bridge's own fire tag.
		expect(withBridge.tagCounts.fire).toBe(1 + Math.floor(5 / 2));
	});
});

describe('draft', () => {
	it('offers phase-appropriate resources', () => {
		const rng = new Rng(7);
		for (let i = 0; i < 50; i++) {
			for (const id of rollOffer(rng, 1, [])) expect(['stat', 'weapon']).toContain(getItem(id).kind);
		}
		const late = Array.from({ length: 80 }, () => rollOffer(rng, 3, [])).flat();
		expect(late.some((id) => getItem(id).kind === 'bridge')).toBe(true);
	});

	it('never offers a skill when skill slots are full', () => {
		const rng = new Rng(3);
		const owned = ITEMS.filter((i) => i.kind === 'skill').slice(0, MAX_SKILLS).map((i) => i.id);
		for (let i = 0; i < 100; i++) {
			for (const id of rollOffer(rng, 2, owned)) expect(getItem(id).kind).not.toBe('skill');
		}
	});
});

describe('zone', () => {
	it('each next circle sits inside the previous one', () => {
		const rng = new Rng(11);
		const zone = createZone(rng, 120);
		let t = 0;
		let last = zone.from;
		while (zone.stage < ZONE_STAGES.length) {
			t += 0.5;
			if (updateZone(zone, t, rng)) {
				expect(dist(zone.from.center, last.center) + zone.from.radius).toBeLessThanOrEqual(last.radius + 1e-6);
				last = zone.from;
			}
		}
	});
});

describe('match', () => {
	it('is deterministic for a seed', () => {
		const a = runHeadless(createWorld({ seed: 42, fighters: 12 }).world);
		const b = runHeadless(createWorld({ seed: 42, fighters: 12 }).world);
		expect(a.winner).toBe(b.winner);
		expect(a.tick).toBe(b.tick);
	});

	it('finishes with a single winner and drops only one item per death', () => {
		const { world } = createWorld({ seed: 5, fighters: 12 });
		let drops = 0;
		let fighterDeaths = 0;
		while (!world.over && world.time < 600) {
			step(world);
			for (const e of world.events) {
				if (e.type === 'drop') drops++;
				if (e.type === 'death' && e.kind === 'fighter') fighterDeaths++;
			}
		}
		expect(world.over).toBe(true);
		expect(world.fighters.filter((f) => f.alive).length).toBeLessThanOrEqual(1);
		expect(drops).toBeLessThanOrEqual(fighterDeaths);
		expect(world.time).toBeLessThan(ZONE_STAGES.reduce((s, z) => s + z.wait + z.shrink, 0) + 60);
	});

	it('lets a human-controlled fighter draft through commands', () => {
		const { world, playerId } = createWorld({ seed: 1, fighters: 10, playerName: 'me' });
		const me = world.fighters.find((f) => f.id === playerId)!;
		expect(me.offer).toEqual(WEAPON_IDS);
		const pick = me.offer![0];
		step(world, new Map([[me.id, [{ type: 'draft', index: 0 }]]]));
		expect(me.items).toEqual([pick]);
		expect(world.time).toBeCloseTo(DT);
	});
});

describe('weapons', () => {
	it('the weapon alone decides melee vs ranged basics', () => {
		expect(usesRangedBasic(summarizeBuild([]))).toBe(false);
		expect(usesRangedBasic(summarizeBuild(['hunting_bow']))).toBe(true);
		expect(usesRangedBasic(summarizeBuild(['greatsword', 'scope', 'scope', 'scope']))).toBe(false);
	});

	it('drafting a weapon card swaps out the old weapon', () => {
		const { world, playerId } = createWorld({ seed: 2, fighters: 10, playerName: 'me' });
		const me = world.fighters.find((f) => f.id === playerId)!;
		step(world, new Map([[me.id, [{ type: 'draft', index: WEAPON_IDS.indexOf('greatsword') }]]]));
		expect(me.build.weapon).toBe('greatsword');
		me.pendingDrafts = 1;
		me.offer = ['hunting_bow', 'ember_ring', 'scope'];
		step(world, new Map([[me.id, [{ type: 'draft', index: 0 }]]]));
		expect(me.build.weapon).toBe('hunting_bow');
		expect(me.items.filter((id) => getItem(id).kind === 'weapon')).toEqual(['hunting_bow']);
	});

	it('cannot reroll away the starting weapon pick', () => {
		const { world, playerId } = createWorld({ seed: 4, fighters: 10, playerName: 'me' });
		const me = world.fighters.find((f) => f.id === playerId)!;
		step(world, new Map([[me.id, [{ type: 'reroll' }]]]));
		expect(me.offer).toEqual(WEAPON_IDS);
	});

	it('kill drops never include the weapon', () => {
		for (let seed = 1; seed <= 3; seed++) {
			const { world } = createWorld({ seed, fighters: 12 });
			while (!world.over && world.time < 600) {
				step(world);
				for (const e of world.events) if (e.type === 'drop') expect(getItem(e.itemId).kind).not.toBe('weapon');
			}
		}
	});
});

describe('sandbox', () => {
	it('keeps a lone fighter alive in an empty, static world', () => {
		const { world, playerId } = createWorld({ seed: 9, fighters: 1, playerName: 'me', sandbox: true });
		const zoneBefore = { ...world.zone.current };
		for (let i = 0; i < 20 * 120; i++) step(world);
		expect(world.over).toBe(false);
		expect(world.monsters).toHaveLength(0);
		expect(world.phase).toBe(1);
		expect(world.zone.current.radius).toBe(zoneBefore.radius);
		expect(world.fighters.find((f) => f.id === playerId)!.alive).toBe(true);
	});

	it('training dummies never fight back', () => {
		const { world, playerId } = createWorld({ seed: 9, fighters: 1, playerName: 'me', sandbox: true });
		const me = world.fighters.find((f) => f.id === playerId)!;
		const dummy = spawnMonster(world, 3, { x: 1, y: 0 }, { passive: true });
		for (let i = 0; i < 100; i++) step(world);
		expect(me.hp).toBe(me.maxHp);
		expect(dummy.pos).toEqual({ x: 1, y: 0 });
	});

	it('an aggressive bot hunts the player', () => {
		const { world, playerId } = createWorld({ seed: 9, fighters: 1, playerName: 'me', sandbox: true });
		const me = world.fighters.find((f) => f.id === playerId)!;
		const bot = spawnFighter(world, { name: 'b', color: '#f00', pos: { x: 15, y: 0 }, bot: true, aggressive: true });
		bot.offer = null;
		bot.pendingDrafts = 0;
		for (let i = 0; i < 20 * 5; i++) step(world);
		expect(me.hp).toBeLessThan(me.maxHp);
	});
});

describe('monster AI', () => {
	function sandbox() {
		const { world, playerId } = createWorld({ seed: 9, fighters: 1, playerName: 'me', sandbox: true });
		const me = world.fighters.find((f) => f.id === playerId)!;
		me.offer = null;
		me.pendingDrafts = 0;
		return { world, me };
	}
	type W = ReturnType<typeof sandbox>['world'];
	type F = ReturnType<typeof sandbox>['me'];

	/** Steps the world, counting how often the monster's target flips set/unset. */
	function run(world: W, m: { targetId: number | null }, ticks: number, cmds: () => Command[] = () => []) {
		let toggles = 0;
		let had = m.targetId !== null;
		for (let i = 0; i < ticks; i++) {
			step(world, new Map([[world.fighters[0].id, cmds()]]));
			const has = m.targetId !== null;
			if (has !== had) toggles++;
			had = has;
		}
		return toggles;
	}

	/** Walk west to x=0 (dragging the monster behind), then stand and swing. */
	const lure = (me: F) => (): Command[] =>
		me.pos.x > 0 ? [{ type: 'move', dir: { x: -1, y: 0 }, run: false }] : [{ type: 'move', dir: null, run: false }, { type: 'attack' }];

	it('a monster lured to the leash edge hits a player it can be hit by', () => {
		const { world, me } = sandbox();
		me.pos = { x: 13, y: 0 };
		const m = spawnMonster(world, 1, { x: 17.5, y: 0 }, { hp: 1e6 });
		const toggles = run(world, m, 20 * 15, lure(me));
		expect(me.pos.x).toBeLessThanOrEqual(0);
		expect(m.targetId).toBe(me.id);
		expect(toggles).toBe(1); // acquired once, never dropped
		expect(me.hp).toBeLessThan(me.maxHp);
		expect(m.hp).toBeLessThan(m.maxHp);
		expect(m.returning).toBe(false);
	});

	it('breaking the leash resets the monster home without flip-flopping', () => {
		const { world, me } = sandbox();
		me.pos = { x: 16, y: 0 };
		const m = spawnMonster(world, 1, { x: 20, y: 0 }, { hp: 1e6 });
		const toggles = run(world, m, 20 * 20, lure(me));
		expect(toggles).toBe(2); // acquired once, dropped once at the leash
		expect(m.returning).toBe(false);
		expect(m.targetId).toBeNull();
		expect(dist(m.pos, m.home)).toBeLessThan(4);
		expect(m.hp).toBe(m.maxHp);
	});

	it('keeps chasing a ranged fighter instead of oscillating', () => {
		const { world, me } = sandbox();
		me.build = summarizeBuild(['hunting_bow']);
		me.pos = { x: 4, y: 0 };
		const m = spawnMonster(world, 1, { x: 8, y: 0 }, { hp: 1e6 });
		const toggles = run(world, m, 20 * 5);
		expect(toggles).toBe(1);
		expect(me.hp).toBeLessThan(me.maxHp);
	});

	it('an idle monster stays near home and never regenerates', () => {
		const { world, me } = sandbox();
		me.pos = { x: -60, y: 0 };
		const m = spawnMonster(world, 2, { x: 30, y: 0 });
		m.hp = m.maxHp * 0.5;
		let moved = 0;
		for (let i = 0; i < 20 * 60; i++) {
			step(world);
			expect(m.returning).toBe(false);
			expect(dist(m.pos, m.home)).toBeLessThanOrEqual(3 + 1e-6);
			moved = Math.max(moved, dist(m.pos, m.home));
		}
		expect(m.hp).toBe(m.maxHp * 0.5);
		expect(moved).toBeGreaterThan(0.5);
	});

	it('a returning monster regenerates and ignores hits', () => {
		const { world, me } = sandbox();
		me.pos = { x: 22, y: 0 };
		const m = spawnMonster(world, 1, { x: 0, y: 0 }, { hp: 1000 });
		m.pos = { x: 20, y: 0 };
		m.hp = 100;
		m.returning = true;
		step(world);
		dealDamage(world, me, m, 10);
		expect(m.targetId).toBeNull();
		const hpAfterHit = m.hp;
		for (let i = 0; i < 20; i++) step(world);
		expect(m.returning).toBe(true);
		expect(m.targetId).toBeNull();
		expect(m.hp).toBeGreaterThan(hpAfterHit);
		expect(me.hp).toBe(me.maxHp);
		for (let i = 0; i < 20 * 10; i++) step(world);
		expect(m.returning).toBe(false);
		expect(m.hp).toBe(m.maxHp);
	});
});
