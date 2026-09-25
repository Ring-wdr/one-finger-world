import { dealDamage, registerUnit, unitById } from './combat';
import { isInside } from './zone';
import {
	DT,
	MAP_RADIUS,
	RING,
	ringOf,
	type Fighter,
	type Monster,
	type MonsterTier,
	type RingId,
	type World
} from './types';
import { add, copy, dist, fromAngle, normalize, scale, sub, type Vec2 } from './vec';
import { newStatus } from './status';
import { navigate, newNav } from './nav';
import { clearSpot, isClear, moveWithCollision } from './obstacles';
import { usesRangedBasic } from './build';

interface TierDef {
	hp: number;
	damage: number;
	speed: number;
	xp: number;
	radius: number;
	aggro: number;
}

export const MONSTER_TIERS: Record<MonsterTier, TierDef> = {
	1: { hp: 28, damage: 4, speed: 3.2, xp: 3, radius: 0.6, aggro: 6 },
	2: { hp: 90, damage: 7, speed: 3.8, xp: 11, radius: 0.85, aggro: 7 },
	3: { hp: 260, damage: 13, speed: 4.2, xp: 34, radius: 1.2, aggro: 8 }
};

/** Outer is crowded but weak; center is sparse but rich and contested. */
const RING_CAP: Record<RingId, number> = { outer: 55, mid: 35, center: 16 };
const RING_BAND: Record<RingId, [number, number]> = {
	outer: [RING.mid + 2, MAP_RADIUS - 2],
	mid: [RING.center + 2, RING.mid - 2],
	center: [4, RING.center - 2]
};
const RING_TIERS: Record<RingId, { item: MonsterTier; weight: number }[]> = {
	outer: [{ item: 1, weight: 90 }, { item: 2, weight: 10 }],
	mid: [{ item: 1, weight: 20 }, { item: 2, weight: 70 }, { item: 3, weight: 10 }],
	center: [{ item: 2, weight: 30 }, { item: 3, weight: 70 }]
};

const SPAWN_INTERVAL = 0.4;
const LAST_SPAWN_STAGE = 3;
/** Chasing this far from home breaks the leash and sends the monster home. */
const LEASH = 16;
/** A target this far away is given up on (also a leash reset). */
const LOSE_TARGET = 14;
const ATTACK_COOLDOWN = 1.2;
/** Idle wander points are rolled strictly inside this radius around home... */
const WANDER_RADIUS = 3;
/** ...and an idle monster only resets when pushed beyond this (hysteresis). */
const IDLE_RADIUS = 5;
/** A returning monster stops ignoring the world once this close to home. */
const RETURN_ARRIVE = 1;
/** Fraction of max HP regenerated per second while returning. */
const RETURN_REGEN = 0.2;
const WANDER_TIMEOUT = 8;
/** Matches the melee combo finisher's reach multiplier in combat.ts. */
const MELEE_FINISHER_REACH = 1.15;
const MAX_EXTRA_REACH = 3;
/** Free ground a monster home needs around it (largest monster radius + slack). */
const SPAWN_CLEARANCE = 1.7;

export function spawnMonsters(world: World, force = false) {
	world.spawnTimer -= DT;
	if (!force && world.spawnTimer > 0) return;
	world.spawnTimer = SPAWN_INTERVAL;
	// Endgame belongs to PvP: the final circles stop refilling with monsters.
	if (world.zone.stage >= LAST_SPAWN_STAGE) return;

	const counts: Record<RingId, number> = { outer: 0, mid: 0, center: 0 };
	for (const m of world.monsters) if (m.alive) counts[ringOf(m.home)] += 1;

	for (const ring of Object.keys(RING_CAP) as RingId[]) {
		if (counts[ring] >= RING_CAP[ring]) continue;
		const pos = findSpawnPoint(world, ring);
		if (!pos) continue;
		const tier = world.rng.weighted(RING_TIERS[ring]) ?? 1;
		spawnMonster(world, tier, pos);
	}
}

function findSpawnPoint(world: World, ring: RingId): Vec2 | null {
	const [r0, r1] = RING_BAND[ring];
	for (let attempt = 0; attempt < 8; attempt++) {
		const r = Math.sqrt(world.rng.range(r0 * r0, r1 * r1));
		const p = fromAngle(world.rng.range(0, Math.PI * 2), r);
		if (!isInside(world.zone, p)) continue;
		if (world.fighters.some((f) => f.alive && dist(f.pos, p) < 14)) continue;
		if (!isClear(p, SPAWN_CLEARANCE)) continue;
		return p;
	}
	return null;
}

export interface SpawnMonsterOptions {
	passive?: boolean;
	hp?: number;
	xp?: number;
}

export function spawnMonster(
	world: World,
	tier: MonsterTier,
	pos: Vec2,
	opts: SpawnMonsterOptions = {}
): Monster {
	const def = MONSTER_TIERS[tier];
	const hpScale = 1 + world.time / 200;
	const hp = opts.hp ?? def.hp * hpScale;
	const dmgScale = 1 + world.time / 300;
	const id = world.nextId++;
	// Scripted spawns (tutorial) may ask for a spot inside a rock: take the nearest free one.
	const at = clearSpot(pos, def.radius + 0.1);
	const m: Monster = {
		kind: 'monster',
		id,
		tier,
		pos: copy(at),
		home: copy(at),
		wander: copy(at),
		wanderTimer: 0,
		returning: false,
		radius: def.radius,
		hp,
		maxHp: hp,
		alive: true,
		status: newStatus(),
		targetId: null,
		attackCd: 0,
		damage: def.damage * dmgScale,
		speed: def.speed,
		xp: opts.xp ?? def.xp,
		nav: newNav(id, at),
		passive: opts.passive ?? false
	};
	world.monsters.push(m);
	registerUnit(world, m);
	return m;
}

/** Steers around obstacles (detouring when stuck) and slides along any it touches. */
function moveToward(world: World, m: Monster, goal: Vec2, speed: number) {
	const l = dist(goal, m.pos);
	if (l < 1e-6) return;
	const dir = navigate(m.nav, m.pos, m.radius, goal, speed, world.tick);
	if (!dir) return;
	m.pos = moveWithCollision(m.pos, scale(dir, Math.min(l, speed * DT)), m.radius);
}

export function updateMonster(world: World, m: Monster) {
	if (m.passive) return;
	m.attackCd -= DT;
	const def = MONSTER_TIERS[m.tier];

	if (m.returning) {
		m.targetId = null;
		m.hp = Math.min(m.maxHp, m.hp + m.maxHp * RETURN_REGEN * DT);
		if (dist(m.pos, m.home) <= RETURN_ARRIVE) {
			m.returning = false;
			m.hp = m.maxHp;
			m.wander = copy(m.pos);
			m.wanderTimer = 0;
		} else {
			moveToward(world, m, m.home, m.speed);
		}
		return;
	}

	let target = unitById(world, m.targetId);
	if (!target || !target.alive || target.kind !== 'fighter') {
		target = undefined;
		m.targetId = null;
		let best = def.aggro * def.aggro;
		for (const f of world.fighters) {
			if (!f.alive) continue;
			const d = (f.pos.x - m.pos.x) ** 2 + (f.pos.y - m.pos.y) ** 2;
			if (d < best) {
				best = d;
				target = f;
				m.targetId = f.id;
			}
		}
	}

	if (target && (dist(m.pos, m.home) > LEASH || dist(m.pos, target.pos) > LOSE_TARGET)) {
		startReturn(m);
		return;
	}

	if (target && target.kind === 'fighter') {
		// Close in to body contact, but swing as soon as the target is within
		// reach so a fighter that can hit the monster can always be hit back.
		const reach = attackReach(m, target);
		const d = dist(m.pos, target.pos);
		if (d > m.radius + target.radius + 0.5) moveToward(world, m, target.pos, m.speed);
		if (d <= reach && m.attackCd <= 0) {
			m.attackCd = ATTACK_COOLDOWN;
			world.events.push({
				type: 'attack',
				unit: m.id,
				pos: copy(m.pos),
				facing: normalize(sub(target.pos, m.pos)),
				radius: reach,
				arc: 1.2,
				combo: 1
			});
			dealDamage(world, m, target, m.damage);
		}
		return;
	}

	// Idle. Anything that left it far from home (a chase whose target died,
	// knockback) sends it back through the same leash reset.
	if (dist(m.pos, m.home) > IDLE_RADIUS) {
		startReturn(m);
		return;
	}
	m.wanderTimer -= DT;
	if (m.wanderTimer <= 0 || (dist(m.pos, m.wander) < 0.3 && world.rng.chance(0.02))) {
		m.wander = copy(m.home);
		// Never wander into a rock; a few rerolls, else idle at home.
		for (let attempt = 0; attempt < 4; attempt++) {
			const w = add(m.home, fromAngle(world.rng.range(0, Math.PI * 2), world.rng.range(0, WANDER_RADIUS)));
			if (isClear(w, m.radius + 0.1)) {
				m.wander = w;
				break;
			}
		}
		m.wanderTimer = WANDER_TIMEOUT;
	}
	moveToward(world, m, m.wander, m.speed * 0.3);
}

function startReturn(m: Monster) {
	m.returning = true;
	m.targetId = null;
}

/**
 * Close enough to trade blows with a melee fighter: never shorter than the
 * fighter's own melee reach against this monster (combo finisher included),
 * so there is no band where the fighter can hit but the monster cannot.
 */
export function attackReach(m: Monster, t: Fighter): number {
	const base = m.radius + t.radius + 0.5;
	if (usesRangedBasic(t.build)) return base;
	const theirs = t.build.stats.range * MELEE_FINISHER_REACH + m.radius + 0.1;
	return Math.max(base, Math.min(theirs, base + MAX_EXTRA_REACH));
}
