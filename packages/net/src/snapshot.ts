import type { Circle, GameEvent, MatchPhase, MonsterTier, Vec2, World } from '@ofa/sim';
import { aoiCenter, eventVisible, inAoi } from './aoi';
import { ITEM_IDS, MsgType, POS_SCALE, SKILL_IDS, TAG_IDS, WEAPON_IDS, itemIndex, skillIndex, tagIndex, weaponIndex } from './constants';
import {
	Reader,
	Writer,
	angleFromWire,
	angleToWire,
	arcFromWire,
	arcToWire,
	clamp,
	effectRadiusFromWire,
	effectRadiusToWire,
	fractionFromWire,
	hpToWire,
	idFromWire,
	idToWire,
	posFromWire,
	posToWire,
	radiusToWire,
	shieldToWire
} from './wire';

/**
 * Server → client snapshots (docs/multiplayer-server-design.md §10.4). One per client per tick,
 * holding the entities in that client's area of interest, its own exact state and its events.
 */

export const SNAPSHOT_HEADER_BYTES = 34;
export const SELF_BLOCK_BYTES = 87;
export const FIGHTER_RECORD_BYTES = 12;
export const MONSTER_RECORD_BYTES = 10;
export const PROJECTILE_RECORD_BYTES = 9;
export const PICKUP_RECORD_BYTES = 7;
/** Each entity list and the event list are capped at this many entries. */
export const MAX_LIST = 255;

export const SnapshotFlag = { Over: 1, ZoneShrinking: 2, HasSelf: 4 } as const;
export const SelfFlag = { Moving: 1, Running: 2 } as const;
export const FighterFlag = { Moving: 1, Running: 2, Dashing: 4, Burning: 8, Bleeding: 16, Human: 32 } as const;
/** Bits 0–1 of the monster byte hold the tier (1–3). */
export const MonsterFlag = { Passive: 4, Burning: 8, Bleeding: 16, Returning: 32 } as const;
export const NO_WEAPON = 255;
/** Arc byte value meaning a full circle. */
export const FULL_ARC = 255;

export const EventKind = {
	Attack: 0,
	Hit: 1,
	Death: 2,
	LevelUp: 3,
	Synergy: 4,
	Dash: 5,
	Pickup: 6,
	Drop: 7,
	Skill: 8,
	Explode: 9,
	Phase: 10,
	Zone: 11,
	End: 12
} as const;

export interface ZoneView {
	stage: number;
	/** Damage per second outside the circle (integer on the wire). */
	dps: number;
	/** Seconds until the next change (0.1 s on the wire). */
	timer: number;
	shrinking: boolean;
	current: Circle;
	next: Circle;
}

/** The receiver's own fighter, exact enough to be the base of movement prediction. */
export interface SelfState {
	pos: Vec2;
	facing: Vec2;
	moveDir: Vec2 | null;
	running: boolean;
	dashTime: number;
	dashDir: Vec2;
	dashCd: number;
	dashCdMax: number;
	rootTime: number;
	attackCd: number;
	attackQueued: number;
	hasteBuff: number;
	hp: number;
	maxHp: number;
	shield: number;
	xp: number;
	level: number;
	kills: number;
}

export interface FighterRecord {
	id: number;
	pos: Vec2;
	/** Radians, 256 steps. */
	facing: number;
	/** Fractions of max HP, 0–1. */
	hp: number;
	shield: number;
	moving: boolean;
	running: boolean;
	dashing: boolean;
	burning: boolean;
	bleeding: boolean;
	human: boolean;
	weapon: string | null;
	level: number;
}

export interface MonsterRecord {
	id: number;
	pos: Vec2;
	tier: MonsterTier;
	passive: boolean;
	hp: number;
	burning: boolean;
	bleeding: boolean;
	returning: boolean;
	targetId: number | null;
}

export interface ProjectileRecord {
	id: number;
	pos: Vec2;
	kind: 'arrow' | 'fireball';
	/** Direction of travel in radians. */
	angle: number;
	/** World units per second. */
	speed: number;
}

export interface PickupRecord {
	id: number;
	pos: Vec2;
	itemId: string;
}

export interface Snapshot {
	tick: number;
	/** Last input seq the server applied for this client (0 = none yet). */
	ack: number;
	/** Server ticks run since that input was applied, capped at 255. */
	sinceAck: number;
	/** Input frames still buffered on the server after this tick. */
	inputQueue: number;
	phase: MatchPhase;
	/** Fighters alive in the whole match. */
	alive: number;
	over: boolean;
	winner: number | null;
	/** The fighter the area of interest follows. */
	focusId: number | null;
	zone: ZoneView;
	self: SelfState | null;
	fighters: FighterRecord[];
	monsters: MonsterRecord[];
	projectiles: ProjectileRecord[];
	pickups: PickupRecord[];
	/** Decoded into the sim's own event shapes, so the renderer and HUD consume them unchanged. */
	events: GameEvent[];
}

/** Who a snapshot is for. */
export interface SnapshotViewer {
	/** AOI center fighter (see pickFocus); null sends only global state. */
	focusId: number | null;
	/** The receiver's fighter; its self block is included while it is alive. */
	selfId: number | null;
	ack: number;
	sinceAck: number;
	inputQueue: number;
}

const u8 = (v: number): number => clamp(Math.round(v), 0, 255);

function lookup<T>(table: readonly T[], i: number, what: string): T {
	const v = table[i];
	if (v === undefined) throw new RangeError(`${what} index ${i} out of range`);
	return v;
}

function writePos(w: Writer, p: Vec2): void {
	w.i16(posToWire(p.x));
	w.i16(posToWire(p.y));
}

const readPos = (r: Reader): Vec2 => ({ x: posFromWire(r.i16()), y: posFromWire(r.i16()) });

function writeCircle(w: Writer, c: Circle): void {
	writePos(w, c.center);
	w.u16(radiusToWire(c.radius));
}

function readCircle(r: Reader): Circle {
	const center = readPos(r);
	return { center, radius: r.u16() / POS_SCALE };
}

function writeEvent(w: Writer, e: GameEvent): void {
	switch (e.type) {
		case 'attack':
			w.u8(EventKind.Attack);
			w.u16(idToWire(e.unit));
			writePos(w, e.pos);
			w.u8(angleToWire(e.facing.x, e.facing.y));
			w.u8(effectRadiusToWire(e.radius));
			w.u8(arcToWire(e.arc));
			w.u8(u8(e.combo));
			break;
		case 'hit':
			w.u8(EventKind.Hit);
			w.u16(idToWire(e.target));
			w.u16(idToWire(e.src));
			w.u16(clamp(Math.round(e.amount * 10), 0, 65535));
			w.u8(e.crit ? 1 : 0);
			writePos(w, e.pos);
			break;
		case 'death':
			w.u8(EventKind.Death);
			w.u16(idToWire(e.unit));
			w.u8(e.kind === 'monster' ? 1 : 0);
			w.u16(idToWire(e.killer));
			writePos(w, e.pos);
			break;
		case 'levelUp':
			w.u8(EventKind.LevelUp);
			w.u16(idToWire(e.unit));
			w.u8(u8(e.level));
			break;
		case 'synergy':
			w.u8(EventKind.Synergy);
			w.u16(idToWire(e.unit));
			w.u8(tagIndex(e.tag));
			w.u8(e.tier);
			break;
		case 'dash':
			w.u8(EventKind.Dash);
			w.u16(idToWire(e.unit));
			writePos(w, e.from);
			writePos(w, e.to);
			break;
		case 'pickup':
			w.u8(EventKind.Pickup);
			w.u16(idToWire(e.unit));
			w.u8(itemIndex(e.itemId));
			break;
		case 'drop':
			w.u8(EventKind.Drop);
			writePos(w, e.pos);
			w.u8(itemIndex(e.itemId));
			w.u16(idToWire(e.from));
			break;
		case 'skill':
			w.u8(EventKind.Skill);
			w.u16(idToWire(e.unit));
			w.u8(skillIndex(e.skill));
			writePos(w, e.pos);
			w.u8(effectRadiusToWire(e.radius));
			break;
		case 'explode':
			w.u8(EventKind.Explode);
			writePos(w, e.pos);
			w.u8(effectRadiusToWire(e.radius));
			w.u16(idToWire(e.src));
			break;
		case 'phase':
			w.u8(EventKind.Phase);
			w.u8(e.phase);
			break;
		case 'zone':
			w.u8(EventKind.Zone);
			w.u8(u8(e.stage));
			break;
		case 'end':
			w.u8(EventKind.End);
			w.u16(idToWire(e.winner));
			break;
	}
}

function readEvent(r: Reader): GameEvent {
	const kind = r.u8();
	switch (kind) {
		case EventKind.Attack: {
			const unit = r.u16();
			const pos = readPos(r);
			const a = angleFromWire(r.u8());
			const radius = effectRadiusFromWire(r.u8());
			const arc = arcFromWire(r.u8());
			return { type: 'attack', unit, pos, facing: { x: Math.cos(a), y: Math.sin(a) }, radius, arc, combo: r.u8() };
		}
		case EventKind.Hit: {
			const target = r.u16();
			const src = idFromWire(r.u16());
			const amount = r.u16() / 10;
			const crit = r.u8() !== 0;
			return { type: 'hit', target, src, amount, crit, pos: readPos(r) };
		}
		case EventKind.Death: {
			const unit = r.u16();
			const monster = r.u8() !== 0;
			const killer = idFromWire(r.u16());
			return { type: 'death', unit, kind: monster ? 'monster' : 'fighter', killer, pos: readPos(r) };
		}
		case EventKind.LevelUp:
			return { type: 'levelUp', unit: r.u16(), level: r.u8() };
		case EventKind.Synergy: {
			const unit = r.u16();
			const tag = lookup(TAG_IDS, r.u8(), 'tag');
			return { type: 'synergy', unit, tag, tier: r.u8() as 0 | 1 | 2 };
		}
		case EventKind.Dash: {
			const unit = r.u16();
			const from = readPos(r);
			return { type: 'dash', unit, from, to: readPos(r) };
		}
		case EventKind.Pickup: {
			const unit = r.u16();
			return { type: 'pickup', unit, itemId: lookup(ITEM_IDS, r.u8(), 'item') };
		}
		case EventKind.Drop: {
			const pos = readPos(r);
			const itemId = lookup(ITEM_IDS, r.u8(), 'item');
			return { type: 'drop', pos, itemId, from: r.u16() };
		}
		case EventKind.Skill: {
			const unit = r.u16();
			const skill = lookup(SKILL_IDS, r.u8(), 'skill');
			const pos = readPos(r);
			return { type: 'skill', unit, skill, pos, radius: effectRadiusFromWire(r.u8()) };
		}
		case EventKind.Explode: {
			const pos = readPos(r);
			const radius = effectRadiusFromWire(r.u8());
			return { type: 'explode', pos, radius, src: r.u16() };
		}
		case EventKind.Phase:
			return { type: 'phase', phase: readPhase(r) };
		case EventKind.Zone:
			return { type: 'zone', stage: r.u8() };
		case EventKind.End:
			return { type: 'end', winner: idFromWire(r.u16()) };
		default:
			throw new RangeError(`unknown event kind ${kind}`);
	}
}

function readPhase(r: Reader): MatchPhase {
	const p = r.u8();
	if (p < 1 || p > 3) throw new RangeError(`phase ${p} out of range`);
	return p as MatchPhase;
}

/**
 * Encodes `world` (after a step) for one viewer: header, self block, AOI-filtered entity lists
 * (pickups are global) and the subset of `events` that `eventVisible` allows.
 */
export function encodeSnapshot(world: World, events: readonly GameEvent[], viewer: SnapshotViewer): Uint8Array {
	const center = aoiCenter(world, viewer.focusId);
	const visible = (p: Vec2) => center !== null && inAoi(center, p);
	const self = viewer.selfId === null ? undefined : world.fighters.find((f) => f.id === viewer.selfId && f.alive);
	const fighters = world.fighters.filter((f) => f.alive && (f.id === viewer.selfId || visible(f.pos))).slice(0, MAX_LIST);
	const monsters = world.monsters.filter((m) => m.alive && visible(m.pos)).slice(0, MAX_LIST);
	const projectiles = world.projectiles.filter((p) => visible(p.pos)).slice(0, MAX_LIST);
	const pickups = world.pickups.slice(0, MAX_LIST);
	const shown = events.filter((e) => eventVisible(e, center, viewer.selfId)).slice(0, MAX_LIST);
	const z = world.zone;

	const w = new Writer();
	w.u8(MsgType.Snapshot);
	w.u32(world.tick);
	w.u32(viewer.ack);
	w.u8(u8(viewer.sinceAck));
	w.u8(u8(viewer.inputQueue));
	w.u8(world.phase);
	w.u8(u8(world.fighters.reduce((n, f) => n + (f.alive ? 1 : 0), 0)));
	w.u8((world.over ? SnapshotFlag.Over : 0) | (z.shrinking ? SnapshotFlag.ZoneShrinking : 0) | (self ? SnapshotFlag.HasSelf : 0));
	w.u16(idToWire(viewer.focusId));
	w.u16(idToWire(world.winner));
	w.u8(u8(z.stage));
	w.u8(u8(z.dps));
	w.u16(clamp(Math.round(z.timer * 10), 0, 65535));
	writeCircle(w, z.current);
	writeCircle(w, z.to);

	if (self) {
		w.f64(self.pos.x);
		w.f64(self.pos.y);
		w.f32(self.facing.x);
		w.f32(self.facing.y);
		w.f32(self.moveDir?.x ?? 0);
		w.f32(self.moveDir?.y ?? 0);
		w.f32(self.dashTime);
		w.f32(self.dashDir.x);
		w.f32(self.dashDir.y);
		w.f32(self.dashCd);
		w.f32(self.dashCdMax);
		w.f32(self.rootTime);
		w.f32(self.attackCd);
		w.f32(self.attackQueued);
		w.f32(self.hasteBuff);
		w.f32(self.hp);
		w.f32(self.maxHp);
		w.f32(self.shield);
		w.f32(self.xp);
		w.u8(u8(self.level));
		w.u8(u8(self.kills));
		w.u8((self.moveDir ? SelfFlag.Moving : 0) | (self.running ? SelfFlag.Running : 0));
	}

	w.u8(fighters.length);
	for (const f of fighters) {
		w.u16(idToWire(f.id));
		writePos(w, f.pos);
		w.u8(angleToWire(f.facing.x, f.facing.y));
		w.u8(hpToWire(f.hp, f.maxHp));
		w.u8(shieldToWire(f.shield, f.maxHp));
		w.u8(
			(f.moveDir ? FighterFlag.Moving : 0) |
				(f.running ? FighterFlag.Running : 0) |
				(f.dashTime > 0 ? FighterFlag.Dashing : 0) |
				(f.status.burnTime > 0 ? FighterFlag.Burning : 0) |
				(f.status.bleedStacks > 0 ? FighterFlag.Bleeding : 0) |
				(f.bot === null ? FighterFlag.Human : 0)
		);
		w.u8(f.build.weapon === null ? NO_WEAPON : weaponIndex(f.build.weapon));
		w.u8(u8(f.level));
	}

	w.u8(monsters.length);
	for (const m of monsters) {
		w.u16(idToWire(m.id));
		writePos(w, m.pos);
		w.u8(
			m.tier |
				(m.passive ? MonsterFlag.Passive : 0) |
				(m.status.burnTime > 0 ? MonsterFlag.Burning : 0) |
				(m.status.bleedStacks > 0 ? MonsterFlag.Bleeding : 0) |
				(m.returning ? MonsterFlag.Returning : 0)
		);
		w.u8(hpToWire(m.hp, m.maxHp));
		w.u16(idToWire(m.targetId));
	}

	w.u8(projectiles.length);
	for (const p of projectiles) {
		w.u16(idToWire(p.id));
		writePos(w, p.pos);
		w.u8(p.kind === 'fireball' ? 1 : 0);
		w.u8(angleToWire(p.vel.x, p.vel.y));
		w.u8(u8(Math.hypot(p.vel.x, p.vel.y)));
	}

	w.u8(pickups.length);
	for (const p of pickups) {
		w.u16(idToWire(p.id));
		writePos(w, p.pos);
		w.u8(itemIndex(p.itemId));
	}

	w.u8(shown.length);
	for (const e of shown) writeEvent(w, e);
	return w.finish();
}

/** Throws RangeError on a truncated or malformed buffer. */
export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot {
	const r = new Reader(data);
	const type = r.u8();
	if (type !== MsgType.Snapshot) throw new RangeError(`not a snapshot (type ${type})`);
	const tick = r.u32();
	const ack = r.u32();
	const sinceAck = r.u8();
	const inputQueue = r.u8();
	const phase = readPhase(r);
	const alive = r.u8();
	const flags = r.u8();
	const focusId = idFromWire(r.u16());
	const winner = idFromWire(r.u16());
	const stage = r.u8();
	const dps = r.u8();
	const timer = r.u16() / 10;
	const current = readCircle(r);
	const next = readCircle(r);

	let self: SelfState | null = null;
	if (flags & SnapshotFlag.HasSelf) {
		const pos = { x: r.f64(), y: r.f64() };
		const facing = { x: r.f32(), y: r.f32() };
		const moveXY = { x: r.f32(), y: r.f32() };
		const dashTime = r.f32();
		const dashDir = { x: r.f32(), y: r.f32() };
		const dashCd = r.f32();
		const dashCdMax = r.f32();
		const rootTime = r.f32();
		const attackCd = r.f32();
		const attackQueued = r.f32();
		const hasteBuff = r.f32();
		const hp = r.f32();
		const maxHp = r.f32();
		const shield = r.f32();
		const xp = r.f32();
		const level = r.u8();
		const kills = r.u8();
		const selfFlags = r.u8();
		self = {
			pos,
			facing,
			moveDir: selfFlags & SelfFlag.Moving ? moveXY : null,
			running: (selfFlags & SelfFlag.Running) !== 0,
			dashTime,
			dashDir,
			dashCd,
			dashCdMax,
			rootTime,
			attackCd,
			attackQueued,
			hasteBuff,
			hp,
			maxHp,
			shield,
			xp,
			level,
			kills
		};
	}

	const fighters: FighterRecord[] = [];
	for (let n = r.u8(); n > 0; n--) {
		const id = r.u16();
		const pos = readPos(r);
		const facing = angleFromWire(r.u8());
		const hp = fractionFromWire(r.u8());
		const shield = fractionFromWire(r.u8());
		const f = r.u8();
		const weapon = r.u8();
		fighters.push({
			id,
			pos,
			facing,
			hp,
			shield,
			moving: (f & FighterFlag.Moving) !== 0,
			running: (f & FighterFlag.Running) !== 0,
			dashing: (f & FighterFlag.Dashing) !== 0,
			burning: (f & FighterFlag.Burning) !== 0,
			bleeding: (f & FighterFlag.Bleeding) !== 0,
			human: (f & FighterFlag.Human) !== 0,
			weapon: weapon === NO_WEAPON ? null : lookup(WEAPON_IDS, weapon, 'weapon'),
			level: r.u8()
		});
	}

	const monsters: MonsterRecord[] = [];
	for (let n = r.u8(); n > 0; n--) {
		const id = r.u16();
		const pos = readPos(r);
		const f = r.u8();
		const tier = f & 3;
		if (tier < 1) throw new RangeError(`monster tier ${tier} out of range`);
		monsters.push({
			id,
			pos,
			tier: tier as MonsterTier,
			passive: (f & MonsterFlag.Passive) !== 0,
			burning: (f & MonsterFlag.Burning) !== 0,
			bleeding: (f & MonsterFlag.Bleeding) !== 0,
			returning: (f & MonsterFlag.Returning) !== 0,
			hp: fractionFromWire(r.u8()),
			targetId: idFromWire(r.u16())
		});
	}

	const projectiles: ProjectileRecord[] = [];
	for (let n = r.u8(); n > 0; n--) {
		const id = r.u16();
		const pos = readPos(r);
		const kind = r.u8() === 1 ? 'fireball' : 'arrow';
		projectiles.push({ id, pos, kind, angle: angleFromWire(r.u8()), speed: r.u8() });
	}

	const pickups: PickupRecord[] = [];
	for (let n = r.u8(); n > 0; n--) {
		const id = r.u16();
		const pos = readPos(r);
		pickups.push({ id, pos, itemId: lookup(ITEM_IDS, r.u8(), 'item') });
	}

	const events: GameEvent[] = [];
	for (let n = r.u8(); n > 0; n--) events.push(readEvent(r));

	return {
		tick,
		ack,
		sinceAck,
		inputQueue,
		phase,
		alive,
		over: (flags & SnapshotFlag.Over) !== 0,
		winner,
		focusId,
		zone: { stage, dps, timer, shrinking: (flags & SnapshotFlag.ZoneShrinking) !== 0, current, next },
		self,
		fighters,
		monsters,
		projectiles,
		pickups,
		events
	};
}
