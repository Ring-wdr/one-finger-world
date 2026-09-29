import { createWorld, type GameEvent, type Vec2, type World } from '@ofa/sim';
import { describe, expect, it } from 'vitest';
import { AOI_NORTH_OFFSET, AOI_RADIUS, EVENT_MARGIN } from './constants';
import { aoiCenter, eventVisible, inAoi, pickFocus } from './aoi';

function makeWorld() {
	const { world, playerId } = createWorld({ seed: 5, fighters: 5, playerName: 'me' });
	return { world, me: playerId! };
}

const fighter = (world: World, id: number) => world.fighters.find((f) => f.id === id)!;

describe('aoiCenter / inAoi', () => {
	it('offsets the center north of the focus fighter', () => {
		const { world, me } = makeWorld();
		const p = fighter(world, me).pos;
		expect(aoiCenter(world, me)).toEqual({ x: p.x, y: p.y + AOI_NORTH_OFFSET });
	});

	it('is null for a missing, dead or null focus', () => {
		const { world, me } = makeWorld();
		expect(aoiCenter(world, null)).toBeNull();
		expect(aoiCenter(world, 9999)).toBeNull();
		fighter(world, me).alive = false;
		expect(aoiCenter(world, me)).toBeNull();
	});

	it('includes points just inside the radius and excludes points just outside', () => {
		const c: Vec2 = { x: 10, y: -20 };
		const inside = { x: c.x + AOI_RADIUS - 1e-6, y: c.y };
		const edge = { x: c.x, y: c.y - AOI_RADIUS };
		const outside = { x: c.x + AOI_RADIUS + 1e-6, y: c.y };
		expect(inAoi(c, c)).toBe(true);
		expect(inAoi(c, inside)).toBe(true);
		expect(inAoi(c, edge)).toBe(true);
		expect(inAoi(c, outside)).toBe(false);
		expect(inAoi(c, outside, 1)).toBe(true);
		expect(inAoi(c, { x: c.x + AOI_RADIUS + 1.01, y: c.y }, 1)).toBe(false);
	});

	it('is a circle, not a square', () => {
		const c = { x: 0, y: 0 };
		const corner = AOI_RADIUS * Math.SQRT1_2;
		expect(inAoi(c, { x: corner - 0.01, y: corner - 0.01 })).toBe(true);
		expect(inAoi(c, { x: corner + 0.01, y: corner + 0.01 })).toBe(false);
	});

	it('the offset shifts which units are visible: further north is in, further south is out', () => {
		const { world, me } = makeWorld();
		const p = fighter(world, me).pos;
		const c = aoiCenter(world, me)!;
		const north = { x: p.x, y: p.y + AOI_NORTH_OFFSET + AOI_RADIUS - 0.1 };
		const south = { x: p.x, y: p.y - AOI_RADIUS - 0.1 };
		expect(inAoi(c, north)).toBe(true);
		expect(inAoi(c, south)).toBe(false);
	});
});

describe('pickFocus', () => {
	it('falls back in order: self, spectate target, last attacker, lowest living id, null', () => {
		const { world, me } = makeWorld();
		const others = world.fighters.filter((f) => f.id !== me).map((f) => f.id);
		const [a, b, c] = others as [number, number, number];
		const me_ = fighter(world, me);
		me_.lastAttacker = c;

		expect(pickFocus(world, me, a)).toBe(me);

		me_.alive = false;
		expect(pickFocus(world, me, a)).toBe(a);
		expect(pickFocus(world, me, null)).toBe(c);

		fighter(world, a).alive = false;
		expect(pickFocus(world, me, a)).toBe(c);

		fighter(world, c).alive = false;
		const lowest = Math.min(...world.fighters.filter((f) => f.alive).map((f) => f.id));
		expect(pickFocus(world, me, a)).toBe(lowest);
		expect(lowest).toBeLessThanOrEqual(b);

		for (const f of world.fighters) f.alive = false;
		expect(pickFocus(world, me, a)).toBeNull();
	});

	it('handles a spectator with no fighter of its own', () => {
		const { world } = makeWorld();
		const first = world.fighters[0]!;
		expect(pickFocus(world, null, null)).toBe(Math.min(...world.fighters.map((f) => f.id)));
		expect(pickFocus(world, null, first.id)).toBe(first.id);
	});
});

describe('eventVisible', () => {
	const center: Vec2 = { x: 0, y: 0 };
	const near: Vec2 = { x: AOI_RADIUS + EVENT_MARGIN - 0.5, y: 0 };
	const far: Vec2 = { x: AOI_RADIUS + EVENT_MARGIN + 0.5, y: 0 };
	const SELF = 7;
	const OTHER = 8;
	const v = (e: GameEvent, c: Vec2 | null = center) => eventVisible(e, c, SELF);

	it('always shows phase, zone, end and fighter deaths, even with no center', () => {
		const always: GameEvent[] = [
			{ type: 'phase', phase: 2 },
			{ type: 'zone', stage: 1 },
			{ type: 'end', winner: null },
			{ type: 'death', unit: OTHER, kind: 'fighter', killer: null, pos: far }
		];
		for (const e of always) {
			expect(v(e)).toBe(true);
			expect(v(e, null)).toBe(true);
		}
	});

	it('shows levelUp, synergy and pickup only for the viewer', () => {
		const mk = (unit: number): GameEvent[] => [
			{ type: 'levelUp', unit, level: 2 },
			{ type: 'synergy', unit, tag: 'fire', tier: 1 },
			{ type: 'pickup', unit, itemId: 'x' }
		];
		for (const e of mk(SELF)) expect(v(e, null)).toBe(true);
		for (const e of mk(OTHER)) expect(v(e)).toBe(false);
		expect(eventVisible({ type: 'levelUp', unit: OTHER, level: 2 }, center, null)).toBe(false);
	});

	it('shows a hit when the viewer is attacker or victim, otherwise by position', () => {
		const hit = (target: number, src: number | null, pos: Vec2): GameEvent => ({ type: 'hit', target, src, amount: 1, crit: false, pos });
		expect(v(hit(SELF, OTHER, far))).toBe(true);
		expect(v(hit(OTHER, SELF, far), null)).toBe(true);
		expect(v(hit(OTHER, null, near))).toBe(true);
		expect(v(hit(OTHER, SELF + 1, far))).toBe(false);
		expect(v(hit(OTHER, null, near), null)).toBe(false);
		// A null attacker must not match a null selfId.
		expect(eventVisible(hit(OTHER, null, far), center, null)).toBe(false);
	});

	it('shows attack and skill for the viewer, otherwise by position', () => {
		const attack = (unit: number, pos: Vec2): GameEvent => ({ type: 'attack', unit, pos, facing: { x: 1, y: 0 }, radius: 2, arc: 1, combo: 1 });
		const skill = (unit: number, pos: Vec2): GameEvent => ({ type: 'skill', unit, skill: 'whirl', pos, radius: 3 });
		for (const mk of [attack, skill]) {
			expect(v(mk(SELF, far), null)).toBe(true);
			expect(v(mk(OTHER, near))).toBe(true);
			expect(v(mk(OTHER, far))).toBe(false);
			expect(v(mk(OTHER, near), null)).toBe(false);
		}
	});

	it('shows a dash when either end is in range', () => {
		const dash = (unit: number, from: Vec2, to: Vec2): GameEvent => ({ type: 'dash', unit, from, to });
		expect(v(dash(SELF, far, far), null)).toBe(true);
		expect(v(dash(OTHER, far, near))).toBe(true);
		expect(v(dash(OTHER, near, far))).toBe(true);
		expect(v(dash(OTHER, far, far))).toBe(false);
		expect(v(dash(OTHER, near, near), null)).toBe(false);
	});

	it('shows monster death, drop and explode by position only', () => {
		const evs = (pos: Vec2): GameEvent[] => [
			{ type: 'death', unit: SELF, kind: 'monster', killer: SELF, pos },
			{ type: 'drop', pos, itemId: 'x', from: SELF },
			{ type: 'explode', pos, radius: 3, src: SELF }
		];
		for (const e of evs(near)) expect(v(e)).toBe(true);
		for (const e of evs(far)) expect(v(e)).toBe(false);
		for (const e of evs(near)) expect(v(e, null)).toBe(false);
	});
});
