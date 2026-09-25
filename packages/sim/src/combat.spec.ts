import { describe, expect, it } from 'vitest';
import { DASH_DISTANCE, dealDamage, killUnit, spawnProjectile, sweepCircle } from './combat';
import { spawnMonster } from './monsters';
import { isClear } from './obstacles';
import { MAP_RADIUS, type Command, type GameEvent } from './types';
import { dist } from './vec';
import { createWorld, equip, spawnFighter, step } from './world';

function sandbox() {
	const { world, playerId } = createWorld({ seed: 9, fighters: 1, playerName: 'me', sandbox: true });
	const me = world.fighters.find((f) => f.id === playerId)!;
	me.offer = null;
	me.pendingDrafts = 0;
	return { world, me };
}

function human(world: ReturnType<typeof sandbox>['world'], name: string, pos: { x: number; y: number }) {
	const f = spawnFighter(world, { name, color: '#f00', pos, bot: false });
	f.offer = null;
	f.pendingDrafts = 0;
	return f;
}

const cmds = (id: number, c: Command[]) => new Map([[id, c]]);

describe('sweepCircle', () => {
	it('finds the first contact along the segment', () => {
		expect(sweepCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, 1)).toBeCloseTo(0.4);
		expect(sweepCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0.5, y: 0 }, 1)).toBe(0);
		expect(sweepCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 2 }, 1)).toBe(-1);
		expect(sweepCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 0 }, 1)).toBe(-1);
	});
});

describe('projectiles', () => {
	for (const weapon of ['hunting_bow', 'fire_staff']) {
		for (const gap of [0.3, 0.8, 1.2]) {
			it(`${weapon} hits a target ${gap} units away on the first tick`, () => {
				const { world, me } = sandbox();
				equip(world, me, weapon);
				const m = spawnMonster(world, 1, { x: me.pos.x + gap, y: me.pos.y }, { hp: 1e6, passive: true });
				// Sandbox origin must be clear so the monster sits exactly where asked.
				expect(dist(m.pos, me.pos)).toBeCloseTo(gap);
				step(world, cmds(me.id, [{ type: 'attack' }]));
				expect(m.hp).toBeLessThan(m.maxHp);
			});
		}
	}

	it('a glancing shot cannot tunnel past a small monster between ticks', () => {
		const { world, me } = sandbox();
		me.pos = { x: 0, y: 0 };
		// Tick ends at x≈2.1 and x≈3.3; both endpoints are 0.85 from the monster, the path 0.6.
		const m = spawnMonster(world, 1, { x: 2.7, y: 0.6 }, { hp: 1e6, passive: true });
		m.pos = { x: 2.7, y: 0.6 };
		m.radius = 0.5;
		spawnProjectile(world, me, 'arrow', { x: 1, y: 0 }, 24, 1, 10, 0);
		step(world);
		expect(m.hp).toBe(m.maxHp);
		step(world);
		expect(m.hp).toBeLessThan(m.maxHp);
	});

	it('never hits its own shooter', () => {
		const { world, me } = sandbox();
		spawnProjectile(world, me, 'arrow', { x: 1, y: 0 }, 24, 1, 10, 0);
		spawnProjectile(world, me, 'fireball', { x: -1, y: 0 }, 16, 1, 10, 0, 2.2, true);
		for (let i = 0; i < 5; i++) step(world);
		expect(me.hp).toBe(me.maxHp);
	});

	it('a non-piercing shot stops at the nearest of two targets in its path', () => {
		const { world, me } = sandbox();
		me.pos = { x: 0, y: 0 };
		// Spawned far one first so enemiesOf order doesn't decide it.
		const far = spawnMonster(world, 1, { x: 1.9, y: 0 }, { hp: 1e6, passive: true });
		const near = spawnMonster(world, 1, { x: 1.2, y: 0.2 }, { hp: 1e6, passive: true });
		far.pos = { x: 1.9, y: 0 };
		near.pos = { x: 1.2, y: 0.2 };
		spawnProjectile(world, me, 'arrow', { x: 1, y: 0 }, 24, 1, 10, 0);
		step(world);
		expect(near.hp).toBeLessThan(near.maxHp);
		expect(far.hp).toBe(far.maxHp);
	});
});

describe('dash', () => {
	it('travels exactly the designed distance', () => {
		const { world, me } = sandbox();
		// Find an obstacle-free lane so the dash never slides.
		let start = { x: 0, y: 0 };
		for (let x = 0; x < 100; x += 3) {
			const ok = [0, 1, 2, 3, 4, 5, 6, 7].every((d) => isClear({ x: x + d, y: 0 }, me.radius + 0.05));
			if (ok) {
				start = { x, y: 0 };
				break;
			}
		}
		me.pos = { ...start };
		step(world, cmds(me.id, [{ type: 'dash', dir: { x: 1, y: 0 } }]));
		const ev = world.events.find((e) => e.type === 'dash') as Extract<GameEvent, { type: 'dash' }>;
		for (let i = 0; i < 10; i++) step(world);
		expect(me.dashTime).toBeLessThanOrEqual(0);
		expect(dist(me.pos, start)).toBeCloseTo(DASH_DISTANCE, 6);
		expect(ev.to.x).toBeCloseTo(me.pos.x, 6);
		expect(ev.to.y).toBeCloseTo(me.pos.y, 6);
	});
});

describe('dead fighters', () => {
	it('a fighter killed by guard reflect mid-attack casts nothing afterwards', () => {
		const { world, me } = sandbox();
		equip(world, me, 'greatsword');
		equip(world, me, 'skill_fireball');
		const wall = human(world, 'wall', { x: me.pos.x + 1.5, y: me.pos.y });
		for (let i = 0; i < 5; i++) equip(world, wall, 'stout_heart');
		expect(wall.build.tiers.guard).toBeGreaterThanOrEqual(2);
		me.hp = 0.01;
		me.facing = { x: 1, y: 0 };
		step(world, cmds(me.id, [{ type: 'attack' }]));
		expect(me.alive).toBe(false);
		expect(world.events.some((e) => e.type === 'skill' && e.unit === me.id)).toBe(false);
		expect(world.projectiles.some((p) => p.owner === me.id)).toBe(false);
	});

	it("a dead fighter's arrow still kills, but credits no kills or xp", () => {
		const { world, me } = sandbox();
		const victim = human(world, 'victim', { x: me.pos.x + 5, y: me.pos.y });
		equip(world, victim, 'stout_heart');
		victim.hp = 1;
		const m = spawnMonster(world, 1, { x: me.pos.x, y: me.pos.y + 5 }, { hp: 1, passive: true });
		spawnProjectile(world, me, 'arrow', { x: 1, y: 0 }, 24, 1, 50, 0);
		spawnProjectile(world, me, 'arrow', { x: 0, y: 1 }, 24, 1, 50, 0);
		killUnit(world, me, null);
		const deaths: GameEvent[] = [];
		for (let i = 0; i < 10; i++) {
			step(world);
			deaths.push(...world.events.filter((e) => e.type === 'death'));
		}
		expect(victim.alive).toBe(false);
		expect(m.alive).toBe(false);
		// Kill feed still names the shooter...
		for (const d of deaths) expect(d.type === 'death' && d.killer).toBe(me.id);
		// ...but a dead fighter gains nothing.
		expect(me.kills).toBe(0);
		expect(me.xp).toBe(0);
		expect(me.level).toBe(1);
		// The victim's item still drops.
		expect(world.pickups.some((p) => p.itemId === 'stout_heart')).toBe(true);
	});

	it('a living shooter still gets the kill', () => {
		const { world, me } = sandbox();
		const victim = human(world, 'victim', { x: me.pos.x + 5, y: me.pos.y });
		victim.hp = 1;
		spawnProjectile(world, me, 'arrow', { x: 1, y: 0 }, 24, 1, 50, 0);
		for (let i = 0; i < 10; i++) step(world);
		expect(victim.alive).toBe(false);
		expect(me.kills).toBe(1);
	});
});

describe('burn', () => {
	it('keeps the stronger burn together with its owner', () => {
		const { world, me } = sandbox();
		const weak = human(world, 'weak', { x: me.pos.x - 5, y: me.pos.y });
		for (let i = 0; i < 5; i++) equip(world, me, 'ember_ring');
		const m = spawnMonster(world, 3, { x: me.pos.x + 5, y: me.pos.y }, { hp: 1e6, passive: true });
		dealDamage(world, me, m, 1, { forceBurn: true });
		const strong = m.status.burnDps;
		dealDamage(world, weak, m, 1, { forceBurn: true });
		expect(m.status.burnDps).toBe(strong);
		expect(m.status.burnSrc).toBe(me.id);
	});
});

describe('knockback', () => {
	it('never pushes a monster off the map', () => {
		const { world, me } = sandbox();
		const m = spawnMonster(world, 1, { x: MAP_RADIUS - 0.5, y: 0 }, { hp: 1e6, passive: true });
		m.pos = { x: MAP_RADIUS - 0.5, y: 0 };
		dealDamage(world, me, m, 1, { knock: { x: 2, y: 0 } });
		expect(Math.hypot(m.pos.x, m.pos.y)).toBeLessThanOrEqual(MAP_RADIUS + 1e-9);
	});
});
