import { createWorld, step, TAGS, type GameEvent, type MatchPhase, type World } from '@ofa/sim';
import { describe, expect, it } from 'vitest';
import { aoiCenter, inAoi } from './aoi';
import { ITEM_IDS, MsgType, SKILL_IDS, WEAPON_IDS, POS_SCALE } from './constants';
import {
	FIGHTER_RECORD_BYTES,
	MAX_LIST,
	MONSTER_RECORD_BYTES,
	PICKUP_RECORD_BYTES,
	PROJECTILE_RECORD_BYTES,
	SELF_BLOCK_BYTES,
	SNAPSHOT_HEADER_BYTES,
	decodeSnapshot,
	encodeSnapshot,
	type SnapshotViewer
} from './snapshot';

const POS_TOL = 0.5 / POS_SCALE + 1e-9;
const ANGLE_TOL = Math.PI / 256 + 1e-9;

const viewerFor = (id: number | null, extra: Partial<SnapshotViewer> = {}): SnapshotViewer => ({
	focusId: id,
	selfId: id,
	ack: 0,
	sinceAck: 0,
	inputQueue: 0,
	...extra
});

/** Difference of two angles on the circle. */
const angleDiff = (a: number, b: number) => {
	const d = Math.abs(a - b) % (Math.PI * 2);
	return Math.min(d, Math.PI * 2 - d);
};

function matchAfter(ticks: number) {
	const { world, playerId } = createWorld({ seed: 3, fighters: 12, playerName: 'me' });
	const events: GameEvent[] = [];
	for (let i = 0; i < ticks; i++) {
		step(world);
		events.push(...world.events);
	}
	return { world, me: playerId!, events };
}

describe('snapshot round trip on a real match', () => {
	const { world, me, events } = matchAfter(400);
	const viewer = viewerFor(me, { ack: 123456, sinceAck: 2, inputQueue: 1 });
	const bytes = encodeSnapshot(world, world.events, viewer);
	const snap = decodeSnapshot(bytes);
	const center = aoiCenter(world, me)!;

	it('the player is alive so the AOI is meaningful', () => {
		expect(center).not.toBeNull();
		expect(world.monsters.length).toBeGreaterThan(0);
	});

	it('carries the header fields', () => {
		expect(bytes[0]).toBe(MsgType.Snapshot);
		expect(snap.tick).toBe(world.tick);
		expect(snap.ack).toBe(123456);
		expect(snap.sinceAck).toBe(2);
		expect(snap.inputQueue).toBe(1);
		expect(snap.phase).toBe(world.phase);
		expect(snap.alive).toBe(world.fighters.filter((f) => f.alive).length);
		expect(snap.over).toBe(world.over);
		expect(snap.winner).toBeNull();
		expect(snap.focusId).toBe(me);
		const z = world.zone;
		expect(snap.zone.stage).toBe(z.stage);
		expect(snap.zone.dps).toBe(Math.round(z.dps));
		expect(snap.zone.timer).toBeCloseTo(z.timer, 1);
		expect(snap.zone.shrinking).toBe(z.shrinking);
		expect(snap.zone.current.center.x).toBeCloseTo(z.current.center.x, 1);
		expect(snap.zone.current.radius).toBeCloseTo(z.current.radius, 1);
		expect(snap.zone.next.center.y).toBeCloseTo(z.to.center.y, 1);
		expect(snap.zone.next.radius).toBeCloseTo(z.to.radius, 1);
	});

	it('the self block is exact', () => {
		const f = world.fighters.find((u) => u.id === me)!;
		const s = snap.self!;
		expect(s.pos).toEqual(f.pos);
		const rel = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * 1e-6 + 1e-30);
		rel(s.facing.x, f.facing.x);
		rel(s.facing.y, f.facing.y);
		rel(s.dashTime, f.dashTime);
		rel(s.dashCd, f.dashCd);
		rel(s.dashCdMax, f.dashCdMax);
		rel(s.rootTime, f.rootTime);
		rel(s.attackCd, f.attackCd);
		rel(s.attackQueued, f.attackQueued);
		rel(s.hasteBuff, f.hasteBuff);
		rel(s.hp, f.hp);
		rel(s.maxHp, f.maxHp);
		rel(s.shield, f.shield);
		rel(s.xp, f.xp);
		expect(s.level).toBe(f.level);
		expect(s.kills).toBe(f.kills);
		expect(s.running).toBe(f.running);
		expect(s.moveDir === null).toBe(f.moveDir === null);
	});

	it('lists exactly the fighters, monsters and projectiles in the AOI (plus self), in world order', () => {
		const inside = (p: { x: number; y: number }) => Math.hypot(p.x - center.x, p.y - center.y) <= 46;
		const wantF = world.fighters.filter((f) => f.alive && (f.id === me || inside(f.pos))).map((f) => f.id);
		const wantM = world.monsters.filter((m) => m.alive && inside(m.pos)).map((m) => m.id);
		const wantP = world.projectiles.filter((p) => inside(p.pos)).map((p) => p.id);
		expect(snap.fighters.map((f) => f.id)).toEqual(wantF);
		expect(snap.monsters.map((m) => m.id)).toEqual(wantM);
		expect(snap.projectiles.map((p) => p.id)).toEqual(wantP);
		// The scenario must actually cull something, or the test proves little.
		expect(world.fighters.filter((f) => f.alive).length + world.monsters.length).toBeGreaterThan(wantF.length + wantM.length);
	});

	it('quantizes fighters and monsters within tolerance', () => {
		for (const r of snap.fighters) {
			const f = world.fighters.find((u) => u.id === r.id)!;
			expect(Math.abs(r.pos.x - f.pos.x)).toBeLessThanOrEqual(POS_TOL);
			expect(Math.abs(r.pos.y - f.pos.y)).toBeLessThanOrEqual(POS_TOL);
			expect(angleDiff(r.facing, (Math.atan2(f.facing.y, f.facing.x) + Math.PI * 2) % (Math.PI * 2))).toBeLessThanOrEqual(ANGLE_TOL);
			expect(Math.abs(r.hp - f.hp / f.maxHp)).toBeLessThanOrEqual(1 / 255);
			expect(r.hp).toBeGreaterThan(0);
			expect(r.human).toBe(f.bot === null);
			expect(r.weapon).toBe(f.build.weapon);
			expect(r.level).toBe(f.level);
			expect(r.moving).toBe(f.moveDir !== null);
			expect(r.dashing).toBe(f.dashTime > 0);
		}
		for (const r of snap.monsters) {
			const m = world.monsters.find((u) => u.id === r.id)!;
			expect(Math.abs(r.pos.x - m.pos.x)).toBeLessThanOrEqual(POS_TOL);
			expect(r.tier).toBe(m.tier);
			expect(r.passive).toBe(m.passive);
			expect(r.returning).toBe(m.returning);
			expect(r.targetId).toBe(m.targetId);
			expect(Math.abs(r.hp - m.hp / m.maxHp)).toBeLessThanOrEqual(1 / 255);
		}
	});

	it('sends every pickup regardless of distance', () => {
		expect(snap.pickups.length).toBe(world.pickups.length);
		snap.pickups.forEach((p, i) => {
			const w = world.pickups[i]!;
			expect(p.id).toBe(w.id);
			expect(p.itemId).toBe(w.itemId);
			expect(Math.abs(p.pos.x - w.pos.x)).toBeLessThanOrEqual(POS_TOL);
		});
	});

	it('carries only visible events, in order', () => {
		expect(snap.events.length).toBeLessThanOrEqual(world.events.length);
		expect(events.length).toBeGreaterThan(0);
	});

	it('a mid-match snapshot stays small', () => {
		console.log(`mid-match snapshot: ${bytes.length} bytes`);
		expect(bytes.length).toBeLessThan(1500);
		const expected =
			SNAPSHOT_HEADER_BYTES +
			SELF_BLOCK_BYTES +
			4 + // list counts (events counted below)
			snap.fighters.length * FIGHTER_RECORD_BYTES +
			snap.monsters.length * MONSTER_RECORD_BYTES +
			snap.projectiles.length * PROJECTILE_RECORD_BYTES +
			snap.pickups.length * PICKUP_RECORD_BYTES +
			1;
		expect(bytes.length).toBeGreaterThanOrEqual(expected);
	});
});

describe('viewer variants', () => {
	it('a spectator gets no self block and sees the focus fighter', () => {
		const { world } = matchAfter(60);
		const focus = world.fighters[3]!.id;
		const snap = decodeSnapshot(encodeSnapshot(world, [], { focusId: focus, selfId: null, ack: 0, sinceAck: 0, inputQueue: 0 }));
		expect(snap.self).toBeNull();
		expect(snap.focusId).toBe(focus);
		expect(snap.fighters.some((f) => f.id === focus)).toBe(true);
	});

	it('with no focus only the self fighter and global state are sent', () => {
		const { world, me } = matchAfter(60);
		const snap = decodeSnapshot(encodeSnapshot(world, [], { ...viewerFor(me), focusId: null }));
		expect(snap.focusId).toBeNull();
		expect(snap.fighters.map((f) => f.id)).toEqual([me]);
		expect(snap.monsters).toEqual([]);
		expect(snap.projectiles).toEqual([]);
		expect(snap.pickups.length).toBe(world.pickups.length);
	});

	it('drops the self block and the fighter record once the fighter is dead', () => {
		const { world, me } = matchAfter(20);
		world.fighters.find((f) => f.id === me)!.alive = false;
		const focus = world.fighters.find((f) => f.alive)!.id;
		const snap = decodeSnapshot(encodeSnapshot(world, [], { ...viewerFor(me), focusId: focus }));
		expect(snap.self).toBeNull();
		expect(snap.fighters.some((f) => f.id === me)).toBe(false);
	});

	it('reports winner and over, and clamps sinceAck and inputQueue', () => {
		const { world, me } = matchAfter(5);
		world.over = true;
		world.winner = me;
		const snap = decodeSnapshot(encodeSnapshot(world, [], viewerFor(me, { sinceAck: 999, inputQueue: 300 })));
		expect(snap.over).toBe(true);
		expect(snap.winner).toBe(me);
		expect(snap.sinceAck).toBe(255);
		expect(snap.inputQueue).toBe(255);
	});
});

describe('units and statuses', () => {
	it('encodes flags, weapon, shield, projectiles and monster state', () => {
		const { world, me } = matchAfter(10);
		const f = world.fighters.find((u) => u.id === me)!;
		f.status.burnTime = 1;
		f.status.bleedStacks = 2;
		f.dashTime = 0.1;
		f.moveDir = { x: 1, y: 0 };
		f.running = true;
		f.build = { ...f.build, weapon: WEAPON_IDS[1]! };
		f.hp = 0.001;
		f.maxHp = 100;
		f.shield = 500;
		f.level = 999;
		const m = world.monsters[0]!;
		m.pos = { x: f.pos.x + 1, y: f.pos.y + 1 };
		m.alive = true;
		m.returning = true;
		m.passive = true;
		m.status.bleedStacks = 1;
		m.targetId = me;
		world.projectiles.push({
			id: 4000, owner: me, kind: 'fireball', pos: { x: f.pos.x + 2, y: f.pos.y }, sweepFrom: f.pos, vel: { x: 0, y: -20 },
			life: 1, radius: 0.3, damage: 1, pierce: 0, hit: [], aoe: 3, forceBurn: false
		});
		world.projectiles.push({
			id: 4001, owner: me, kind: 'arrow', pos: { x: f.pos.x - 2, y: f.pos.y }, sweepFrom: f.pos, vel: { x: -900, y: 0 },
			life: 1, radius: 0.3, damage: 1, pierce: 0, hit: [], aoe: 0, forceBurn: false
		});
		const snap = decodeSnapshot(encodeSnapshot(world, [], viewerFor(me)));
		const rec = snap.fighters.find((r) => r.id === me)!;
		expect(rec).toMatchObject({ moving: true, running: true, dashing: true, burning: true, bleeding: true, human: true, weapon: WEAPON_IDS[1], level: 255, shield: 1 });
		expect(rec.hp).toBeCloseTo(1 / 255, 6);
		const mr = snap.monsters.find((r) => r.id === m.id)!;
		expect(mr).toMatchObject({ returning: true, passive: true, bleeding: true, burning: false, targetId: me, tier: m.tier });
		const fb = snap.projectiles.find((p) => p.id === 4000)!;
		expect(fb).toMatchObject({ kind: 'fireball', speed: 20 });
		expect(angleDiff(fb.angle, (Math.PI * 3) / 2)).toBeLessThanOrEqual(ANGLE_TOL);
		expect(snap.projectiles.find((p) => p.id === 4001)!).toMatchObject({ kind: 'arrow', speed: 255 });
		expect(snap.self!.moveDir).toEqual({ x: 1, y: 0 });
		expect(snap.self!.running).toBe(true);
	});

	it('encodes a weaponless fighter as null and a standing fighter as not moving', () => {
		const { world, me } = matchAfter(5);
		const f = world.fighters.find((u) => u.id === me)!;
		f.build = { ...f.build, weapon: null };
		f.moveDir = null;
		const snap = decodeSnapshot(encodeSnapshot(world, [], viewerFor(me)));
		expect(snap.fighters.find((r) => r.id === me)!).toMatchObject({ weapon: null, moving: false });
		expect(snap.self!.moveDir).toBeNull();
	});

	it('truncates each list to MAX_LIST', () => {
		const { world, me } = matchAfter(5);
		const f = world.fighters.find((u) => u.id === me)!;
		const template = world.pickups[0] ?? { id: 1, pos: { x: 0, y: 0 }, itemId: ITEM_IDS[0]! };
		world.pickups = Array.from({ length: 300 }, (_, i) => ({ ...template, id: 1000 + i }));
		const events: GameEvent[] = Array.from({ length: 300 }, () => ({ type: 'zone', stage: 1 }));
		world.projectiles = Array.from({ length: 300 }, (_, i) => ({
			id: 2000 + i, owner: me, kind: 'arrow', pos: { ...f.pos }, sweepFrom: f.pos, vel: { x: 1, y: 0 },
			life: 1, radius: 0.3, damage: 1, pierce: 0, hit: [], aoe: 0, forceBurn: false
		}));
		const snap = decodeSnapshot(encodeSnapshot(world, events, viewerFor(me)));
		expect(snap.pickups.length).toBe(MAX_LIST);
		expect(snap.projectiles.length).toBe(MAX_LIST);
		expect(snap.events.length).toBe(MAX_LIST);
	});

	it('throws RangeError for an id that does not fit in u16', () => {
		const { world, me } = matchAfter(5);
		world.monsters[0]!.id = 70000;
		world.monsters[0]!.pos = { ...world.fighters.find((u) => u.id === me)!.pos };
		world.monsters[0]!.alive = true;
		expect(() => encodeSnapshot(world, [], viewerFor(me))).toThrow(RangeError);
	});
});

describe('events', () => {
	const roundTrip = (world: World, e: GameEvent): GameEvent => {
		const snap = decodeSnapshot(encodeSnapshot(world, [e], viewerFor(world.fighters[0]!.id)));
		expect(snap.events).toHaveLength(1);
		return snap.events[0]!;
	};
	const { world } = matchAfter(1);
	const me = world.fighters[0]!.id;
	const p = { x: world.fighters[0]!.pos.x + 3, y: world.fighters[0]!.pos.y - 2 };
	const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
	const nearPos = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		near(a.x, b.x, POS_TOL);
		near(a.y, b.y, POS_TOL);
	};

	it('attack', () => {
		const facing = { x: Math.cos(1), y: Math.sin(1) };
		const out = roundTrip(world, { type: 'attack', unit: me, pos: p, facing, radius: 2.51, arc: 1.2, combo: 3 }) as Extract<GameEvent, { type: 'attack' }>;
		expect(out.type).toBe('attack');
		expect(out.unit).toBe(me);
		nearPos(out.pos, p);
		near(Math.atan2(out.facing.y, out.facing.x), 1, ANGLE_TOL);
		near(out.radius, 2.51, 1 / 32);
		near(out.arc, 1.2, 1 / 80);
		expect(out.combo).toBe(3);
	});

	it('attack with a full-circle arc', () => {
		const out = roundTrip(world, { type: 'attack', unit: me, pos: p, facing: { x: 1, y: 0 }, radius: 3, arc: Math.PI * 2, combo: 1 }) as Extract<GameEvent, { type: 'attack' }>;
		expect(out.arc).toBeCloseTo(Math.PI * 2, 12);
		const nearlyFull = roundTrip(world, { type: 'attack', unit: me, pos: p, facing: { x: 1, y: 0 }, radius: 3, arc: 6.2, combo: 1 }) as Extract<GameEvent, { type: 'attack' }>;
		expect(nearlyFull.arc).toBeLessThan(Math.PI * 2);
	});

	it('hit, with and without a source', () => {
		const a = roundTrip(world, { type: 'hit', target: me, src: 9, amount: 12.34, crit: true, pos: p }) as Extract<GameEvent, { type: 'hit' }>;
		expect(a).toMatchObject({ type: 'hit', target: me, src: 9, crit: true });
		near(a.amount, 12.34, 0.05);
		nearPos(a.pos, p);
		const b = roundTrip(world, { type: 'hit', target: me, src: null, amount: 1e9, crit: false, pos: p }) as Extract<GameEvent, { type: 'hit' }>;
		expect(b.src).toBeNull();
		expect(b.amount).toBeCloseTo(6553.5, 6);
	});

	it('death of a fighter and of a monster', () => {
		expect(roundTrip(world, { type: 'death', unit: me, kind: 'fighter', killer: 5, pos: p })).toMatchObject({ kind: 'fighter', killer: 5 });
		const m = roundTrip(world, { type: 'death', unit: 40, kind: 'monster', killer: null, pos: p }) as Extract<GameEvent, { type: 'death' }>;
		expect(m).toMatchObject({ unit: 40, kind: 'monster', killer: null });
		nearPos(m.pos, p);
	});

	it('levelUp, synergy, pickup', () => {
		const w = world.fighters[0]!;
		expect(roundTrip(world, { type: 'levelUp', unit: me, level: 7 })).toEqual({ type: 'levelUp', unit: me, level: 7 });
		for (const tag of TAGS) {
			expect(roundTrip(world, { type: 'synergy', unit: me, tag, tier: 2 })).toEqual({ type: 'synergy', unit: me, tag, tier: 2 });
		}
		const item = ITEM_IDS[ITEM_IDS.length - 1]!;
		expect(roundTrip(world, { type: 'pickup', unit: w.id, itemId: item })).toEqual({ type: 'pickup', unit: w.id, itemId: item });
	});

	it('dash', () => {
		const to = { x: p.x + 4, y: p.y };
		const out = roundTrip(world, { type: 'dash', unit: me, from: p, to }) as Extract<GameEvent, { type: 'dash' }>;
		nearPos(out.from, p);
		nearPos(out.to, to);
	});

	it('drop and explode', () => {
		const d = roundTrip(world, { type: 'drop', pos: p, itemId: ITEM_IDS[0]!, from: 12 }) as Extract<GameEvent, { type: 'drop' }>;
		expect(d).toMatchObject({ itemId: ITEM_IDS[0], from: 12 });
		nearPos(d.pos, p);
		const x = roundTrip(world, { type: 'explode', pos: p, radius: 3.5, src: 2 }) as Extract<GameEvent, { type: 'explode' }>;
		expect(x).toMatchObject({ radius: 3.5, src: 2 });
	});

	it('skill, for every skill id', () => {
		for (const skill of SKILL_IDS) {
			const out = roundTrip(world, { type: 'skill', unit: me, skill, pos: p, radius: 4 }) as Extract<GameEvent, { type: 'skill' }>;
			expect(out).toMatchObject({ skill, unit: me, radius: 4 });
		}
	});

	it('phase, zone, end', () => {
		for (const phase of [1, 2, 3] as MatchPhase[]) expect(roundTrip(world, { type: 'phase', phase })).toEqual({ type: 'phase', phase });
		expect(roundTrip(world, { type: 'zone', stage: 3 })).toEqual({ type: 'zone', stage: 3 });
		expect(roundTrip(world, { type: 'end', winner: 6 })).toEqual({ type: 'end', winner: 6 });
		expect(roundTrip(world, { type: 'end', winner: null })).toEqual({ type: 'end', winner: null });
	});

	it('clamps event positions to the i16 range and rejects oversized ids', () => {
		const out = roundTrip(world, { type: 'death', unit: me, kind: 'fighter', killer: null, pos: { x: 1e6, y: -1e6 } }) as Extract<GameEvent, { type: 'death' }>;
		expect(out.pos).toEqual({ x: 32767 / POS_SCALE, y: -32768 / POS_SCALE });
		const world2 = matchAfter(1).world;
		expect(() => encodeSnapshot(world2, [{ type: 'end', winner: 70000 }], viewerFor(me))).toThrow(RangeError);
	});

	it('filters events through eventVisible', () => {
		const far = { x: 200, y: 200 };
		const evs: GameEvent[] = [
			{ type: 'explode', pos: far, radius: 1, src: 1 },
			{ type: 'levelUp', unit: me + 1000, level: 2 },
			{ type: 'zone', stage: 2 },
			{ type: 'levelUp', unit: me, level: 3 },
			{ type: 'explode', pos: p, radius: 1, src: 1 }
		];
		const snap = decodeSnapshot(encodeSnapshot(world, evs, viewerFor(me)));
		expect(snap.events.map((e) => e.type)).toEqual(['zone', 'levelUp', 'explode']);
	});
});

describe('malformed buffers', () => {
	const { world, me } = matchAfter(100);
	const good = encodeSnapshot(world, [{ type: 'zone', stage: 1 }, { type: 'pickup', unit: me, itemId: ITEM_IDS[0]! }], viewerFor(me));

	it('the reference buffer decodes', () => {
		expect(() => decodeSnapshot(good)).not.toThrow();
	});

	it('throws on truncation at every length', () => {
		for (let n = 0; n < good.length; n++) expect(() => decodeSnapshot(good.slice(0, n)), `length ${n}`).toThrow(RangeError);
	});

	it('throws on a wrong type byte', () => {
		const b = good.slice();
		b[0] = MsgType.Input;
		expect(() => decodeSnapshot(b)).toThrow(RangeError);
	});

	it('throws on a bad phase', () => {
		const b = good.slice();
		b[11] = 0;
		expect(() => decodeSnapshot(b)).toThrow(RangeError);
		b[11] = 4;
		expect(() => decodeSnapshot(b)).toThrow(RangeError);
	});

	it('throws on an unknown event kind and on a bad item index', () => {
		const b = good.slice();
		// The events end with zone [kind=11, stage] then pickup [kind=6, u16 unit, u8 item].
		const zoneAt = b.length - 6;
		expect(b[zoneAt]).toBe(11);
		const bad = b.slice();
		bad[zoneAt] = 99;
		expect(() => decodeSnapshot(bad)).toThrow(RangeError);
		const badItem = b.slice();
		badItem[badItem.length - 1] = 255;
		expect(() => decodeSnapshot(badItem)).toThrow(RangeError);
	});

	it('throws on a bad pickup, weapon and tag index', () => {
		world.pickups = [{ id: 900, pos: { x: 0, y: 0 }, itemId: ITEM_IDS[0]! }];
		const withPickup = encodeSnapshot(world, [], viewerFor(me));
		const b = withPickup.slice();
		// Last list before the empty event list: the final pickup record's item byte sits just before the event count.
		b[b.length - 2] = 250;
		expect(() => decodeSnapshot(b)).toThrow(RangeError);

		const f = world.fighters.find((u) => u.id === me)!;
		const savedBuild = f.build;
		f.build = { ...savedBuild, weapon: null };
		const noWeapon = encodeSnapshot(world, [], viewerFor(me));
		f.build = savedBuild;
		// Weapon byte of the first fighter record (the player): count, then id, pos, facing, hp, shield, flags.
		const off = SNAPSHOT_HEADER_BYTES + SELF_BLOCK_BYTES + 1 + 2 + 4 + 3 + 1;
		expect(noWeapon[off]).toBe(255);
		const w = noWeapon.slice();
		w[off] = 200;
		expect(() => decodeSnapshot(w)).toThrow(RangeError);

		const tagEvent = encodeSnapshot(world, [{ type: 'synergy', unit: me, tag: 'fire', tier: 1 }], viewerFor(me));
		const t = tagEvent.slice();
		t[t.length - 2] = 99;
		expect(() => decodeSnapshot(t)).toThrow(RangeError);
	});

	it('accepts a Uint8Array view with a byteOffset and a bare ArrayBuffer', () => {
		const padded = new Uint8Array(good.length + 7);
		padded.set(good, 7);
		expect(decodeSnapshot(padded.subarray(7))).toEqual(decodeSnapshot(good));
		expect(decodeSnapshot(good.slice().buffer)).toEqual(decodeSnapshot(good));
	});
});

describe('aoi consistency', () => {
	it('every listed fighter passes inAoi against the same center', () => {
		const { world, me } = matchAfter(200);
		const center = aoiCenter(world, me)!;
		const snap = decodeSnapshot(encodeSnapshot(world, [], viewerFor(me)));
		for (const r of snap.fighters) {
			if (r.id !== me) expect(inAoi(center, world.fighters.find((f) => f.id === r.id)!.pos)).toBe(true);
		}
	});
});
