import type { BuildSummary } from './build';
import type { MatchPhase } from './draft';
import type { SkillId } from './items';
import type { Rng } from './rng';
import type { Tag, SynergyTier } from './tags';
import type { Vec2 } from './vec';
import type { ZoneState } from './zone';

export const TICK_RATE = 20;
export const DT = 1 / TICK_RATE;

export const MAP_RADIUS = 120;
/** PvE rings: outer = safe/low yield, center = dangerous/high yield. */
export const RING = { center: 40, mid: 80 } as const;
export type RingId = 'outer' | 'mid' | 'center';

export function ringOf(p: Vec2): RingId {
	const r = Math.hypot(p.x, p.y);
	return r < RING.center ? 'center' : r < RING.mid ? 'mid' : 'outer';
}

export type Command =
	| { type: 'move'; dir: Vec2 | null; run: boolean }
	| { type: 'attack' }
	| { type: 'dash'; dir: Vec2 }
	| { type: 'draft'; index: number }
	| { type: 'reroll' }
	| { type: 'exchange'; itemIndex: number };

export interface Status {
	burnTime: number;
	burnDps: number;
	burnSrc: number;
	bleedStacks: number;
	bleedTime: number;
	bleedPerStack: number;
	bleedSrc: number;
}

export interface UnitBase {
	id: number;
	pos: Vec2;
	radius: number;
	hp: number;
	maxHp: number;
	alive: boolean;
	status: Status;
}

export interface BotBrain {
	prefTags: Tag[];
	/** 0 = hugs the safe outer ring, 1 = dives the center. */
	risk: number;
	thinkTimer: number;
	targetId: number | null;
	goal: Vec2 | null;
	mode: 'farm' | 'fight' | 'flee' | 'zone' | 'loot' | 'roam' | 'rest';
	/** Always engages the nearest fighter (tutorial sparring partner). */
	aggressive: boolean;
}

export interface Fighter extends UnitBase {
	kind: 'fighter';
	name: string;
	color: string;
	bot: BotBrain | null;
	facing: Vec2;
	moveDir: Vec2 | null;
	running: boolean;
	level: number;
	xp: number;
	items: string[];
	build: BuildSummary;
	shield: number;
	sinceHurt: number;
	attackCd: number;
	attackQueued: number;
	rootTime: number;
	combo: 1 | 2 | 3;
	comboTimer: number;
	dashCd: number;
	dashTime: number;
	dashDir: Vec2;
	dashHit: number[];
	hasteBuff: number;
	skillCds: Partial<Record<SkillId, number>>;
	pendingDrafts: number;
	offer: string[] | null;
	rerolls: number;
	exchangeTokens: number;
	kills: number;
	placement: number | null;
	lastAttacker: number | null;
	lastAttackedAt: number;
}

export type MonsterTier = 1 | 2 | 3;

export interface Monster extends UnitBase {
	kind: 'monster';
	tier: MonsterTier;
	home: Vec2;
	targetId: number | null;
	attackCd: number;
	damage: number;
	speed: number;
	xp: number;
	wander: Vec2;
	/** Seconds left before the idle wander point is rerolled even if unreached. */
	wanderTimer: number;
	/**
	 * Leash reset: set when the monster loses its chase far from home. While
	 * returning it ignores aggro and hits, walks home and regenerates.
	 */
	returning: boolean;
	/** Training dummy: never moves, attacks or heals. */
	passive: boolean;
}

export type Unit = Fighter | Monster;

export interface Projectile {
	id: number;
	owner: number;
	kind: 'arrow' | 'fireball';
	pos: Vec2;
	vel: Vec2;
	life: number;
	radius: number;
	damage: number;
	pierce: number;
	hit: number[];
	/** AoE radius on first impact (fireball). */
	aoe: number;
	forceBurn: boolean;
}

export interface Pickup {
	id: number;
	pos: Vec2;
	itemId: string;
}

export type GameEvent =
	| { type: 'attack'; unit: number; pos: Vec2; facing: Vec2; radius: number; arc: number; combo: number }
	| { type: 'hit'; target: number; src: number | null; amount: number; crit: boolean; pos: Vec2 }
	| { type: 'death'; unit: number; kind: 'fighter' | 'monster'; killer: number | null; pos: Vec2 }
	| { type: 'levelUp'; unit: number; level: number }
	| { type: 'synergy'; unit: number; tag: Tag; tier: SynergyTier }
	| { type: 'dash'; unit: number; from: Vec2; to: Vec2 }
	| { type: 'pickup'; unit: number; itemId: string }
	| { type: 'drop'; pos: Vec2; itemId: string; from: number }
	| { type: 'skill'; unit: number; skill: SkillId; pos: Vec2; radius: number }
	| { type: 'explode'; pos: Vec2; radius: number; src: number }
	| { type: 'phase'; phase: MatchPhase }
	| { type: 'zone'; stage: number }
	| { type: 'end'; winner: number | null };

/** Automatic match systems. A sandbox (tutorial) turns them off and scripts the world instead. */
export interface WorldRules {
	spawnMonsters: boolean;
	zone: boolean;
	phases: boolean;
	endWhenOneLeft: boolean;
}

export interface World {
	seed: number;
	rules: WorldRules;
	time: number;
	tick: number;
	rng: Rng;
	nextId: number;
	phase: MatchPhase;
	fighters: Fighter[];
	monsters: Monster[];
	projectiles: Projectile[];
	pickups: Pickup[];
	zone: ZoneState;
	events: GameEvent[];
	spawnTimer: number;
	over: boolean;
	winner: number | null;
}
