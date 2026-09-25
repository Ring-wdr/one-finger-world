import { dealDamage, registerUnit, unitById } from './combat';
import { isInside } from './zone';
import {
	DT,
	MAP_RADIUS,
	RING,
	ringOf,
	type Monster,
	type MonsterTier,
	type RingId,
	type World
} from './types';
import { add, copy, dist, fromAngle, normalize, scale, sub, type Vec2 } from './vec';
import { newStatus } from './status';

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
const LEASH = 16;
const ATTACK_COOLDOWN = 1.2;

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
	const m: Monster = {
		kind: 'monster',
		id: world.nextId++,
		tier,
		pos: copy(pos),
		home: copy(pos),
		wander: copy(pos),
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
		passive: opts.passive ?? false
	};
	world.monsters.push(m);
	registerUnit(world, m);
	return m;
}

function moveToward(m: Monster, goal: Vec2, speed: number) {
	const d = sub(goal, m.pos);
	const l = Math.hypot(d.x, d.y);
	if (l < 1e-6) return;
	m.pos = add(m.pos, scale(d, Math.min(l, speed * DT) / l));
}

export function updateMonster(world: World, m: Monster) {
	if (m.passive) return;
	m.attackCd -= DT;
	const def = MONSTER_TIERS[m.tier];
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

	if (target && (dist(m.pos, m.home) > LEASH || dist(m.pos, target.pos) > 14)) {
		target = undefined;
		m.targetId = null;
	}

	if (target) {
		const reach = m.radius + target.radius + 0.5;
		if (dist(m.pos, target.pos) > reach) {
			moveToward(m, target.pos, m.speed);
		} else if (m.attackCd <= 0) {
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

	if (dist(m.pos, m.home) > 2) {
		moveToward(m, m.home, m.speed);
		m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.2 * DT);
		return;
	}
	if (dist(m.pos, m.wander) < 0.3 && world.rng.chance(0.02)) {
		m.wander = add(m.home, fromAngle(world.rng.range(0, Math.PI * 2), world.rng.range(0, 4)));
	}
	moveToward(m, m.wander, m.speed * 0.3);
}
