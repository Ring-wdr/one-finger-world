import {
	decodeSnapshot,
	encodeSnapshot,
	motionFromSelf,
	type RosterEntry,
	type Sample,
	type SelfMessage,
	type Snapshot
} from '@ofa/net';
import { DT, MONSTER_TIERS, WEAPON_IDS, createWorld, equip, getItem, step, type Fighter, type World } from '@ofa/sim';
import { describe, expect, it } from 'vitest';
import { ViewWorldBuilder, type OwnState } from './viewWorld';

const POS_TOL = 0.5 / 128 + 1e-9;

function match(ticks: number) {
	const { world, playerId } = createWorld({ seed: 11, fighters: 12, humans: [{ name: 'me' }] });
	for (let i = 0; i < ticks; i++) step(world);
	return { world, me: playerId! };
}

const rosterOf = (world: World): RosterEntry[] =>
	world.fighters.map((f) => ({ id: f.id, name: f.name, color: f.color, human: f.bot === null }));

const snapOf = (world: World, me: number, ack = 0): Snapshot =>
	decodeSnapshot(encodeSnapshot(world, world.events, { focusId: me, selfId: me, ack, sinceAck: 0, inputQueue: 1 }));

const still = (s: Snapshot): Sample => ({ a: s, b: s, alpha: 1 });

function selfMessage(f: Fighter): SelfMessage {
	return {
		t: 'self',
		items: [...f.items],
		runes: [...f.runes],
		offer: f.offer ? [...f.offer] : null,
		pendingDrafts: f.pendingDrafts,
		rerolls: f.rerolls,
		exchangeTokens: f.exchangeTokens
	};
}

function ownFrom(snap: Snapshot, world: World, me: number, displayPos = { x: 1.5, y: -2.5 }): OwnState {
	const f = world.fighters.find((x) => x.id === me)!;
	return { self: snap.self!, build: selfMessage(f), motion: motionFromSelf(snap.self!), displayPos };
}

function builderFor(world: World): ViewWorldBuilder {
	const b = new ViewWorldBuilder();
	b.setRoster(rosterOf(world));
	return b;
}

/** A living bot near `me`, so it is inside the area of interest. */
function nearbyBot(world: World, me: number): Fighter {
	const m = world.fighters.find((f) => f.id === me)!;
	const bot = world.fighters.find((f) => f.bot !== null && f.alive)!;
	bot.pos = { x: m.pos.x + 4, y: m.pos.y + 1 };
	return bot;
}

describe('ViewWorldBuilder entities', () => {
	it('mirrors the snapshot: entity sets, zone and world scalars', () => {
		const { world, me } = match(200);
		const m = world.fighters.find((f) => f.id === me)!;
		world.projectiles.push({
			id: 9001, owner: me, kind: 'fireball', pos: { x: m.pos.x + 3, y: m.pos.y }, sweepFrom: { ...m.pos }, vel: { x: 0, y: 12 },
			life: 1, radius: 0.3, damage: 1, pierce: 0, hit: [], aoe: 0, forceBurn: false
		});
		world.pickups.push({ id: 9002, pos: { x: 3, y: 4 }, itemId: WEAPON_IDS[0] });
		const snap = snapOf(world, me);
		const { world: v, alpha } = builderFor(world).build(still(snap), me, null);

		expect(alpha).toBe(1);
		expect(v.fighters.map((f) => f.id)).toEqual(snap.fighters.map((f) => f.id));
		expect(v.monsters.map((x) => x.id)).toEqual(snap.monsters.map((x) => x.id));
		expect(v.monsters.length).toBeGreaterThan(0);
		for (const mon of v.monsters) {
			expect(mon.alive).toBe(true);
			expect(mon.radius).toBe(MONSTER_TIERS[mon.tier].radius);
			expect(mon.maxHp).toBe(1);
			expect(mon.hp).toBeGreaterThan(0);
			expect(mon.hp).toBeLessThanOrEqual(1);
		}
		const pr = v.projectiles.find((p) => p.id === 9001)!;
		expect(pr.kind).toBe('fireball');
		expect(pr.vel.x).toBeCloseTo(0, 1);
		expect(pr.vel.y).toBeCloseTo(12, 0);
		expect(v.pickups.find((p) => p.id === 9002)).toMatchObject({ itemId: WEAPON_IDS[0], pos: { x: 3, y: 4 } });

		expect(v.zone.current).toEqual(snap.zone.current);
		expect(v.zone.to).toEqual(snap.zone.next);
		expect(v.zone.from).toEqual(snap.zone.current);
		expect(v.zone).toMatchObject({ stage: snap.zone.stage, dps: snap.zone.dps, timer: snap.zone.timer, shrinking: snap.zone.shrinking });
		expect(v).toMatchObject({ phase: snap.phase, tick: snap.tick, over: snap.over, winner: snap.winner, aliveTotal: snap.alive, events: [] });
		expect(v.time).toBeCloseTo(snap.tick * DT, 9);
		expect(v.roster.get(me)?.name).toBe('me');
	});

	it('draws remote fighters from their records with neutral defaults', () => {
		const { world, me } = match(200);
		const bot = nearbyBot(world, me);
		equip(world, bot, WEAPON_IDS[0]);
		bot.hp = bot.maxHp / 2;
		bot.moveDir = { x: 0, y: 1 };
		bot.running = true;
		bot.status.burnTime = 2;
		const snap = snapOf(world, me);
		const { world: v } = builderFor(world).build(still(snap), me, null);
		const f = v.fighters.find((x) => x.id === bot.id)!;

		expect(f).toMatchObject({ kind: 'fighter', name: bot.name, color: bot.color, alive: true, radius: 0.7, maxHp: 1, running: true, level: bot.level });
		expect(f.hp).toBeCloseTo(0.5, 2);
		expect(Math.hypot(f.facing.x, f.facing.y)).toBeCloseTo(1, 5);
		expect(f.moveDir).not.toBeNull();
		expect(Math.hypot(f.moveDir!.x, f.moveDir!.y)).toBeCloseTo(1, 5);
		expect(f.status.burnTime).toBe(1);
		expect(f.status.bleedStacks).toBe(0);
		expect(f.bot).not.toBeNull();
		expect(f.build.weapon).toBe(WEAPON_IDS[0]);
		expect(f.pos.x).toBeCloseTo(bot.pos.x, 1);
		expect(f.pos.y).toBeCloseTo(bot.pos.y, 1);
		// Human seats are not bots.
		expect(v.fighters.find((x) => x.id === me)!.bot).toBeNull();
	});

	it('shows standing fighters without a move direction or dash', () => {
		const { world, me } = match(200);
		const bot = nearbyBot(world, me);
		bot.moveDir = null;
		bot.dashTime = 0.05;
		const { world: v } = builderFor(world).build(still(snapOf(world, me)), me, null);
		const f = v.fighters.find((x) => x.id === bot.id)!;
		expect(f.moveDir).toBeNull();
		expect(f.dashTime).toBe(0.1);
	});

	it('caches the weapon build per weapon', () => {
		const { world, me } = match(200);
		const bot = nearbyBot(world, me);
		equip(world, bot, WEAPON_IDS[0]);
		const b = builderFor(world);
		const first = b.build(still(snapOf(world, me)), me, null).world.fighters.find((x) => x.id === bot.id)!.build;
		step(world);
		const second = b.build(still(snapOf(world, me)), me, null).world.fighters.find((x) => x.id === bot.id)!.build;
		expect(second).toBe(first);
	});
});

describe('ViewWorldBuilder own fighter', () => {
	it('takes position, motion, vitals and build from the local state', () => {
		const { world, me } = match(200);
		const f = world.fighters.find((x) => x.id === me)!;
		equip(world, f, WEAPON_IDS[0]);
		f.hp = 33.5;
		f.xp = 7;
		f.kills = 2;
		f.dashCd = 0.4;
		f.dashCdMax = 1.2;
		f.moveDir = { x: 1, y: 0 };
		const snap = snapOf(world, me);
		const own = ownFrom(snap, world, me);
		const { world: v, prev } = builderFor(world).build(still(snap), me, own);
		const mine = v.fighters.find((x) => x.id === me)!;

		expect(mine.pos).toEqual(own.displayPos);
		expect(prev.get(me)).toEqual(own.displayPos);
		expect(mine.hp).toBeCloseTo(33.5, 4);
		expect(mine.maxHp).toBeCloseTo(f.maxHp, 4);
		expect(mine).toMatchObject({ xp: 7, kills: 2, level: f.level, pendingDrafts: f.pendingDrafts, rerolls: f.rerolls, exchangeTokens: f.exchangeTokens });
		expect(mine.dashCd).toBeCloseTo(0.4, 5);
		expect(mine.dashCdMax).toBeCloseTo(1.2, 5);
		expect(mine.moveDir).toEqual(own.motion.moveDir);
		expect(mine.facing).toEqual(own.motion.facing);
		expect(mine.items).toEqual(f.items);
		expect(mine.runes).toEqual(f.runes);
		expect(mine.offer).toEqual(f.offer);
		expect(mine.build.weapon).toBe(WEAPON_IDS[0]);
		expect(mine.build.stats.maxHp).toBeCloseTo(f.build.stats.maxHp, 6);
	});

	it('follows the offer while the draft is open', () => {
		const { world, me } = match(5);
		const f = world.fighters.find((x) => x.id === me)!;
		expect(f.offer).not.toBeNull();
		const snap = snapOf(world, me);
		const { world: v } = builderFor(world).build(still(snap), me, ownFrom(snap, world, me));
		expect(v.fighters.find((x) => x.id === me)!.offer).toEqual(f.offer);
	});

	it('recomputes the build only when items or runes change', () => {
		const { world, me } = match(200);
		const f = world.fighters.find((x) => x.id === me)!;
		equip(world, f, WEAPON_IDS[0]);
		const b = builderFor(world);
		const snap = snapOf(world, me);
		const buildOf = (o: OwnState) => b.build(still(snap), me, o).world.fighters.find((x) => x.id === me)!.build;
		const first = buildOf(ownFrom(snap, world, me));
		expect(buildOf(ownFrom(snap, world, me))).toBe(first);
		const other = WEAPON_IDS.find((w) => w !== WEAPON_IDS[0])!;
		equip(world, f, other);
		const changed = buildOf(ownFrom(snap, world, me));
		expect(changed).not.toBe(first);
		expect(changed.weapon).toBe(other);
	});

	it('draws the own fighter from local state even before a snapshot record exists for it', () => {
		const { world, me } = match(200);
		const snap = snapOf(world, me);
		snap.fighters = snap.fighters.filter((r) => r.id !== me);
		const { world: v } = builderFor(world).build(still(snap), me, ownFrom(snap, world, me));
		expect(v.fighters.find((x) => x.id === me)).toMatchObject({ alive: true, pos: { x: 1.5, y: -2.5 } });
	});

	it('leaves the own fighter to its record when no local state is given', () => {
		const { world, me } = match(200);
		const snap = snapOf(world, me);
		const { world: v } = builderFor(world).build(still(snap), me, null);
		const mine = v.fighters.find((x) => x.id === me)!;
		expect(mine.pos.x).toBeCloseTo(world.fighters.find((x) => x.id === me)!.pos.x, 1);
		expect(mine.maxHp).toBe(1);
	});
});

describe('ViewWorldBuilder positions and reuse', () => {
	it('puts positions from the earlier snapshot in prev, only for ids in both', () => {
		const { world, me } = match(200);
		const bot = nearbyBot(world, me);
		const a = snapOf(world, me);
		const survivor = a.fighters.find((r) => r.id === bot.id)!;
		for (let i = 0; i < 10; i++) step(world);
		// A new pickup exists only in b.
		world.pickups.push({ id: 9100, pos: { x: 1, y: 1 }, itemId: WEAPON_IDS[0] });
		const b = snapOf(world, me);
		const { prev, alpha, world: v } = new ViewWorldBuilder().build({ a, b, alpha: 0.25 }, me, null);

		expect(alpha).toBe(0.25);
		expect(prev.get(bot.id)).toEqual(survivor.pos);
		expect(prev.has(9100)).toBe(false);
		for (const f of v.fighters) expect(prev.has(f.id)).toBe(a.fighters.some((r) => r.id === f.id));
		for (const id of prev.keys()) expect(v.fighters.some((f) => f.id === id) || v.monsters.some((m) => m.id === id) || v.projectiles.some((p) => p.id === id) || v.pickups.some((p) => p.id === id)).toBe(true);
	});

	it('reuses the world and entity objects across frames and updates them in place', () => {
		const { world, me } = match(200);
		const bot = nearbyBot(world, me);
		const b = builderFor(world);
		const first = b.build(still(snapOf(world, me)), me, null);
		const botView = first.world.fighters.find((f) => f.id === bot.id)!;
		const monView = first.world.monsters[0];
		const posRef = botView.pos;
		for (let i = 0; i < 6; i++) step(world);
		const snap = snapOf(world, me);
		const second = b.build(still(snap), me, null);

		expect(second.world).toBe(first.world);
		expect(second.prev).toBe(first.prev);
		expect(second.world.fighters.find((f) => f.id === bot.id)).toBe(botView);
		expect(botView.pos).toBe(posRef);
		const rec = snap.fighters.find((r) => r.id === bot.id)!;
		expect(Math.abs(botView.pos.x - rec.pos.x)).toBeLessThan(POS_TOL);
		if (snap.monsters.some((m) => m.id === monView.id)) expect(second.world.monsters.find((m) => m.id === monView.id)).toBe(monView);
		expect(second.world.tick).toBe(snap.tick);
	});

	it('drops entities that vanish and builds fresh ones if the id returns', () => {
		const { world, me } = match(200);
		const b = builderFor(world);
		const full = snapOf(world, me);
		const first = b.build(still(full), me, null).world;
		const gone = first.monsters[0];
		const goneId = gone.id;
		const goneFighter = first.fighters.find((f) => f.id !== me)!;
		const trimmed: Snapshot = {
			...full,
			monsters: full.monsters.filter((m) => m.id !== goneId),
			fighters: full.fighters.filter((f) => f.id !== goneFighter.id),
			pickups: [],
			projectiles: []
		};
		const second = b.build(still(trimmed), me, null).world;
		expect(second.monsters.some((m) => m.id === goneId)).toBe(false);
		expect(second.fighters.some((f) => f.id === goneFighter.id)).toBe(false);
		expect(second.pickups).toEqual([]);

		const third = b.build(still(full), me, null).world;
		expect(third.monsters.find((m) => m.id === goneId)).not.toBe(gone);
		expect(third.fighters.find((f) => f.id === goneFighter.id)).not.toBe(goneFighter);
	});
});

describe('ViewWorldBuilder output shape', () => {
	/** What Renderer.render and Hud.update read, checked as plain values. */
	function assertDrawable(v: ReturnType<ViewWorldBuilder['build']>['world'], me: Fighter | undefined) {
		const finite = (n: number) => expect(Number.isFinite(n)).toBe(true);
		for (const f of v.fighters) {
			expect(f.kind).toBe('fighter');
			expect(f.alive).toBe(true);
			for (const n of [f.pos.x, f.pos.y, f.facing.x, f.facing.y, f.hp, f.maxHp, f.shield, f.radius, f.dashTime, f.level]) finite(n);
			expect(f.maxHp).toBeGreaterThan(0);
			expect(f.hp / f.maxHp).toBeLessThanOrEqual(1.0001);
			expect(typeof f.name).toBe('string');
			expect(f.color).toMatch(/^#/);
			expect(f.status.burnTime).toBeGreaterThanOrEqual(0);
			expect(f.build.tagCounts).toBeDefined();
			expect(Array.isArray(f.items)).toBe(true);
			expect(v.fighters.filter((g) => g.id === f.id)).toHaveLength(1);
		}
		for (const m of v.monsters) for (const n of [m.pos.x, m.pos.y, m.radius, m.hp, m.maxHp, m.tier]) finite(n);
		for (const p of v.projectiles) for (const n of [p.pos.x, p.pos.y, p.vel.x, p.vel.y]) finite(n);
		for (const p of v.pickups) expect(() => getItem(p.itemId)).not.toThrow();
		for (const c of [v.zone.current, v.zone.to]) for (const n of [c.center.x, c.center.y, c.radius]) finite(n);
		if (me) {
			expect(me.items).toBeInstanceOf(Array);
			expect(me.build.weapon === null || typeof me.build.weapon === 'string').toBe(true);
			for (const n of [me.xp, me.kills, me.rerolls, me.exchangeTokens, me.pendingDrafts, me.dashCd, me.dashCdMax]) finite(n);
			expect(me.dashCdMax).toBeGreaterThan(0);
		}
		expect(v.fighters.length).toBeLessThanOrEqual(v.aliveTotal);
	}

	it('gives the renderer and HUD finite, complete data for a whole match', () => {
		const { world, me } = match(0);
		const b = builderFor(world);
		for (let t = 0; t < 400; t++) {
			step(world);
			if (t % 40 !== 0) continue;
			const snap = snapOf(world, me);
			const own = snap.self ? ownFrom(snap, world, me) : null;
			const { world: v } = b.build(still(snap), me, own);
			assertDrawable(v, v.fighters.find((f) => f.id === me));
		}
	});
});
