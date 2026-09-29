import type { Circle, GameEvent, MatchPhase, MonsterTier, Vec2, World } from '@ofa/sim';
import { todo } from './todo';

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

/**
 * Encodes `world` (after a step) for one viewer: header, self block, AOI-filtered entity lists
 * (pickups are global) and the subset of `events` that `eventVisible` allows.
 */
export function encodeSnapshot(world: World, events: readonly GameEvent[], viewer: SnapshotViewer): Uint8Array {
	return todo('T3', world, events, viewer);
}

/** Throws RangeError on a truncated or malformed buffer. */
export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot {
	return todo('T3', data);
}
