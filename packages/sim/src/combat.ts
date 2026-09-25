import { summarizeBuild, usesRangedBasic } from './build';
import { rollOffer } from './draft';
import { getItem, SKILLS, type SkillId } from './items';
import { moveWithCollision } from './obstacles';
import { TAGS } from './tags';
import {
	DT,
	MAP_RADIUS,
	type Fighter,
	type GameEvent,
	type Projectile,
	type Unit,
	type World
} from './types';
import { add, clampToCircle, copy, dist, dist2, dot, normalize, rotate, scale, sub, type Vec2 } from './vec';

export const DASH_TIME = 0.18;
export const DASH_DISTANCE = 6;
export const COMBO_MULT = [1, 1.1, 1.6] as const;
export const COMBO_WINDOW = 1.1;
const MELEE_ARC = 2.4;
const ARROW_SPEED = 24;
const GUARD_REFLECT = 0.15;
/** Ranged basics trade damage for safety. */
const RANGED_MULT = 0.85;

// ── Unit lookup (derived cache, rebuilt each tick; never part of a snapshot)

const unitIndex = new WeakMap<World, Map<number, Unit>>();

export function reindex(world: World) {
	const map = new Map<number, Unit>();
	for (const f of world.fighters) map.set(f.id, f);
	for (const m of world.monsters) map.set(m.id, m);
	unitIndex.set(world, map);
}

export function registerUnit(world: World, unit: Unit) {
	unitIndex.get(world)?.set(unit.id, unit);
}

export function unitById(world: World, id: number | null): Unit | undefined {
	if (id === null) return undefined;
	return unitIndex.get(world)?.get(id);
}

export function enemiesOf(world: World, self: Unit): Unit[] {
	const out: Unit[] = [];
	for (const f of world.fighters) if (f.alive && f !== self) out.push(f);
	if (self.kind === 'fighter') for (const m of world.monsters) if (m.alive) out.push(m);
	return out;
}

export function nearestEnemy(world: World, self: Unit, maxDist: number): Unit | null {
	let best: Unit | null = null;
	let bestD = maxDist * maxDist;
	for (const e of enemiesOf(world, self)) {
		const d = dist2(self.pos, e.pos);
		if (d < bestD) {
			bestD = d;
			best = e;
		}
	}
	return best;
}

// ── Progression

export function xpToNext(level: number) {
	return 10 + (level - 1) * 7;
}

export function ensureOffer(world: World, f: Fighter) {
	if (!f.offer && f.pendingDrafts > 0) f.offer = rollOffer(world.rng, world.phase, f.items);
}

export function gainXp(world: World, f: Fighter, amount: number) {
	if (!f.alive) return;
	f.xp += amount;
	while (f.xp >= xpToNext(f.level)) {
		f.xp -= xpToNext(f.level);
		f.level += 1;
		f.pendingDrafts += 1;
		heal(f, f.maxHp * 0.15);
		world.events.push({ type: 'levelUp', unit: f.id, level: f.level });
	}
	ensureOffer(world, f);
}

export function applyBuild(world: World, f: Fighter) {
	const before = f.build;
	f.build = summarizeBuild(f.items);
	const gained = f.build.stats.maxHp - f.maxHp;
	f.maxHp = f.build.stats.maxHp;
	if (gained > 0) f.hp += gained;
	f.hp = Math.min(f.hp, f.maxHp);
	for (const tag of TAGS) {
		if (f.build.tiers[tag] > before.tiers[tag]) {
			world.events.push({ type: 'synergy', unit: f.id, tag, tier: f.build.tiers[tag] });
		}
	}
}

function heal(u: Unit, amount: number) {
	if (!u.alive || amount <= 0) return;
	u.hp = Math.min(u.maxHp, u.hp + amount);
}

// ── Damage

export interface HitOpts {
	canCrit?: boolean;
	/** Triggers synergy on-hit effects (burn/bleed) from the attacker's build. */
	onHit?: boolean;
	forceBurn?: boolean;
	forceBleed?: boolean;
	/** Damage-over-time: no hit event, no lifesteal, no reflect. */
	dot?: boolean;
	/** Zone damage: ignores armor, shields and dash i-frames. */
	environmental?: boolean;
	reflected?: boolean;
	knock?: Vec2 | null;
}

export function dealDamage(
	world: World,
	src: Unit | null | undefined,
	target: Unit,
	raw: number,
	o: HitOpts = {}
): number {
	if (!target.alive || raw <= 0) return 0;
	const tf = target.kind === 'fighter' ? target : null;
	if (tf && tf.dashTime > 0 && !o.environmental) return 0;
	const sf = src?.kind === 'fighter' ? src : null;

	let amount = raw;
	let crit = false;
	if (sf && o.canCrit && world.rng.chance(sf.build.stats.crit)) {
		amount *= 2;
		crit = true;
	}
	if (sf && sf.build.tiers.bleed >= 2 && target.status.bleedStacks > 0) amount *= 1.2;

	if (tf) {
		if (!o.environmental) {
			amount *= tf.build.stats.damageTaken;
			const absorbed = Math.min(tf.shield, amount);
			tf.shield -= absorbed;
			amount -= absorbed;
		}
		tf.sinceHurt = 0;
		if (sf && sf !== tf) {
			tf.lastAttacker = sf.id;
			tf.lastAttackedAt = world.time;
		}
	}

	target.hp -= amount;
	if (!o.dot) {
		world.events.push({
			type: 'hit',
			target: target.id,
			src: src?.id ?? null,
			amount,
			crit,
			pos: copy(target.pos)
		});
	}

	if (sf && !o.dot) heal(sf, amount * sf.build.stats.lifesteal);
	if (sf) applyStatuses(sf, target, o);
	if (target.kind === 'monster' && sf && !target.returning) target.targetId = sf.id;
	// Obstacles are resolved at the end of the tick (world.step); the map edge is clamped here.
	if (o.knock && target.kind === 'monster') {
		target.pos = clampToCircle(add(target.pos, o.knock), { x: 0, y: 0 }, MAP_RADIUS);
	}

	if (tf && src && src !== tf && !o.dot && !o.reflected && tf.build.tiers.guard >= 2) {
		dealDamage(world, tf, src, raw * GUARD_REFLECT, { reflected: true });
	}

	if (target.hp <= 0) killUnit(world, target, src ?? null);
	return amount;
}

function applyStatuses(sf: Fighter, target: Unit, o: HitOpts) {
	const s = target.status;
	const tiers = sf.build.tiers;
	if ((o.onHit && tiers.fire >= 1) || o.forceBurn) {
		const dps = sf.build.stats.damage * 0.3 * (tiers.fire >= 2 ? 2 : 1);
		// The stronger burn wins and keeps its owner; any hit refreshes the duration.
		if (s.burnTime <= 0 || dps >= s.burnDps) {
			s.burnDps = dps;
			s.burnSrc = sf.id;
		}
		s.burnTime = 3;
	}
	if ((o.onHit && tiers.bleed >= 1) || o.forceBleed) {
		const max = tiers.bleed >= 2 ? 16 : 8;
		s.bleedStacks = Math.min(max, s.bleedStacks + 1);
		s.bleedTime = 4;
		s.bleedPerStack = sf.build.stats.damage * 0.08;
		s.bleedSrc = sf.id;
	}
}

function resolveKiller(world: World, victim: Unit, src: Unit | null): Fighter | null {
	if (src?.kind === 'fighter' && src !== victim) return src;
	if (victim.kind === 'fighter' && victim.lastAttacker !== null) {
		if (world.time - victim.lastAttackedAt <= 8) {
			const k = unitById(world, victim.lastAttacker);
			if (k?.kind === 'fighter') return k;
		}
	}
	return null;
}

export function killUnit(world: World, victim: Unit, src: Unit | null) {
	if (!victim.alive) return;
	victim.alive = false;
	victim.hp = 0;
	const killer = resolveKiller(world, victim, src);
	const event: GameEvent = {
		type: 'death',
		unit: victim.id,
		kind: victim.kind,
		killer: killer?.id ?? null,
		pos: copy(victim.pos)
	};
	world.events.push(event);
	// A dead fighter's in-flight projectiles and DoTs can still finish a kill: the death event
	// keeps crediting them (accurate kill feed), but they gain no kills, xp or on-kill effects.
	const rewarded = killer?.alive ? killer : null;

	if (victim.kind === 'monster') {
		if (rewarded) {
			gainXp(world, rewarded, victim.xp);
			if (rewarded.build.tiers.fire >= 2 && victim.status.burnTime > 0) {
				explode(world, rewarded, victim.pos, 3, rewarded.build.stats.damage * 0.6);
			}
		}
		return;
	}

	victim.placement = world.fighters.filter((f) => f.alive).length + 1;
	victim.moveDir = null;
	if (rewarded) {
		rewarded.kills += 1;
		gainXp(world, rewarded, 25 + victim.level * 4);
	}
	// Exactly one random piece of the victim's build drops, never the whole thing (and never the weapon).
	const droppable = victim.items.filter((id) => getItem(id).kind !== 'weapon');
	if (droppable.length > 0) {
		const itemId = world.rng.pick(droppable);
		world.pickups.push({ id: world.nextId++, pos: copy(victim.pos), itemId });
		world.events.push({ type: 'drop', pos: copy(victim.pos), itemId, from: victim.id });
	}
}

function explode(world: World, src: Fighter, at: Vec2, radius: number, amount: number, o: HitOpts = {}) {
	world.events.push({ type: 'explode', pos: copy(at), radius, src: src.id });
	for (const e of enemiesOf(world, src)) {
		if (dist(e.pos, at) <= radius + e.radius) dealDamage(world, src, e, amount, o);
	}
}

// ── Fighter actions

export function startDash(world: World, f: Fighter, dir: Vec2) {
	if (f.dashCd > 0 || f.dashTime > 0 || f.rootTime > 0) return;
	const d = normalize(dir);
	f.dashDir = d.x === 0 && d.y === 0 ? copy(f.facing) : d;
	f.facing = copy(f.dashDir);
	f.dashTime = DASH_TIME;
	f.dashHit = [];
	f.attackQueued = 0;
	f.dashCd = 3 * (f.build.tiers.speed >= 1 ? 0.6 : 1) * (1 - f.build.stats.cdr);
	world.events.push({
		type: 'dash',
		unit: f.id,
		from: copy(f.pos),
		to: add(f.pos, scale(f.dashDir, DASH_DISTANCE))
	});
}

export function updateDash(world: World, f: Fighter) {
	// DASH_TIME isn't a whole number of ticks: the last tick only covers what's left, so the
	// total is exactly DASH_DISTANCE. Dashes slide along obstacles but never steer around them.
	const speed = DASH_DISTANCE / DASH_TIME;
	const step = speed * Math.min(DT, Math.max(0, f.dashTime));
	f.pos = moveWithCollision(f.pos, scale(f.dashDir, step), f.radius);
	if (f.build.skills.includes('flashStep')) {
		for (const e of enemiesOf(world, f)) {
			if (f.dashHit.includes(e.id) || dist(e.pos, f.pos) > 1.8 + e.radius) continue;
			f.dashHit.push(e.id);
			dealDamage(world, f, e, f.build.stats.damage * 1.5, { canCrit: true, onHit: true });
		}
	}
	f.dashTime -= DT;
	if (f.dashTime <= 0 && f.build.tiers.speed >= 2) f.hasteBuff = 2;
}

export function performAttack(world: World, f: Fighter) {
	const s = f.build.stats;
	const ranged = usesRangedBasic(f.build);
	const target = nearestEnemy(world, f, ranged ? s.range * 4 : s.range + 2.5);
	if (target) {
		const d = normalize(sub(target.pos, f.pos));
		if (d.x !== 0 || d.y !== 0) f.facing = d;
	}

	f.combo = f.comboTimer > 0 ? (((f.combo % 3) + 1) as 1 | 2 | 3) : 1;
	f.comboTimer = COMBO_WINDOW;
	const amount = s.damage * COMBO_MULT[f.combo - 1];

	if (ranged) {
		const count = f.build.tiers.ranged >= 2 ? 3 : 1;
		const pierce = f.build.tiers.ranged >= 1 ? 2 : 0;
		for (let i = 0; i < count; i++) {
			const dir = rotate(f.facing, (i - (count - 1) / 2) * 0.21);
			spawnProjectile(world, f, f.build.projectile, dir, ARROW_SPEED, (s.range * 4) / ARROW_SPEED, amount * RANGED_MULT, pierce);
		}
		world.events.push({ type: 'attack', unit: f.id, pos: copy(f.pos), facing: copy(f.facing), radius: 0, arc: 0, combo: f.combo });
	} else {
		const full = f.build.tiers.melee >= 2 || (f.combo === 3 && f.build.tiers.melee >= 1);
		const arc = full ? Math.PI * 2 : MELEE_ARC;
		const radius = s.range * (f.combo === 3 ? 1.15 : 1);
		const minDot = Math.cos(arc / 2);
		for (const e of enemiesOf(world, f)) {
			const to = sub(e.pos, f.pos);
			const d = Math.hypot(to.x, to.y);
			if (d - e.radius > radius) continue;
			if (!full && d > 0.3 && dot(scale(to, 1 / d), f.facing) < minDot) continue;
			const knock = f.build.tiers.melee >= 2 && d > 0 ? scale(to, 0.9 / d) : null;
			dealDamage(world, f, e, amount, { canCrit: true, onHit: true, knock });
		}
		world.events.push({ type: 'attack', unit: f.id, pos: copy(f.pos), facing: copy(f.facing), radius, arc, combo: f.combo });
	}

	f.attackCd = 1 / (s.attackRate * (f.hasteBuff > 0 ? 1.4 : 1));
	f.attackQueued = 0;
	f.rootTime = 0.12;
}

export function spawnProjectile(
	world: World,
	owner: Fighter,
	kind: Projectile['kind'],
	dir: Vec2,
	speed: number,
	life: number,
	damage: number,
	pierce: number,
	aoe = 0,
	forceBurn = false
) {
	world.projectiles.push({
		id: world.nextId++,
		owner: owner.id,
		kind,
		pos: add(owner.pos, scale(dir, owner.radius + 0.2)),
		// The first sweep starts inside the shooter so point-blank targets can't be skipped.
		sweepFrom: copy(owner.pos),
		vel: scale(dir, speed),
		life,
		radius: kind === 'fireball' ? 0.45 : 0.25,
		damage,
		pierce,
		hit: [],
		aoe,
		forceBurn
	});
}

export function castSkills(world: World, f: Fighter) {
	for (const skill of f.build.skills) {
		const def = SKILLS[skill];
		if (def.cooldown <= 0) continue;
		if ((f.skillCds[skill] ?? 0) > 0) continue;
		if (castSkill(world, f, skill)) {
			f.skillCds[skill] = def.cooldown * (1 - f.build.stats.cdr);
		}
	}
}

function castSkill(world: World, f: Fighter, skill: SkillId): boolean {
	const s = f.build.stats;
	const emit = (radius: number) =>
		world.events.push({ type: 'skill', unit: f.id, skill, pos: copy(f.pos), radius });

	switch (skill) {
		case 'fireball': {
			const t = nearestEnemy(world, f, 14);
			if (!t) return false;
			spawnProjectile(world, f, 'fireball', normalize(sub(t.pos, f.pos)), 16, 1.2, s.damage * 1.6, 0, 2.2, true);
			emit(0);
			return true;
		}
		case 'volley': {
			const t = nearestEnemy(world, f, 12);
			if (!t) return false;
			const aim = normalize(sub(t.pos, f.pos));
			for (let i = -1; i <= 1; i++) {
				spawnProjectile(world, f, 'arrow', rotate(aim, i * 0.26), ARROW_SPEED, 0.6, s.damage * 0.7, 1);
			}
			emit(0);
			return true;
		}
		case 'whirl': {
			const radius = 3.5;
			const hits = enemiesOf(world, f).filter((e) => dist(e.pos, f.pos) <= radius + e.radius);
			if (hits.length === 0) return false;
			for (const e of hits) dealDamage(world, f, e, s.damage * 1.2, { canCrit: true, onHit: true, forceBleed: true });
			emit(radius);
			return true;
		}
		case 'thornShell': {
			if (!nearestEnemy(world, f, 10)) return false;
			f.shield = Math.min(f.maxHp * 0.4, f.shield + f.maxHp * 0.2);
			emit(1.5);
			return true;
		}
		case 'bloodPulse': {
			const radius = 7;
			const hits = enemiesOf(world, f).filter(
				(e) => e.status.bleedStacks > 0 && dist(e.pos, f.pos) <= radius + e.radius
			);
			if (hits.length === 0) return false;
			for (const e of hits) {
				const burst = e.status.bleedStacks * e.status.bleedPerStack * 4 + s.damage * 0.3;
				e.status.bleedStacks = 0;
				dealDamage(world, f, e, burst, { canCrit: true });
			}
			emit(radius);
			return true;
		}
		case 'flashStep':
			return false;
	}
}

// ── Projectiles & statuses

/**
 * Earliest t in [0, 1] at which a circle of radius `r` moving from `a` by `d` touches the
 * point `c`, or -1 if it never does.
 */
export function sweepCircle(a: Vec2, d: Vec2, c: Vec2, r: number): number {
	const fx = a.x - c.x;
	const fy = a.y - c.y;
	const cc = fx * fx + fy * fy - r * r;
	if (cc <= 0) return 0;
	const aa = d.x * d.x + d.y * d.y;
	if (aa <= 1e-12) return -1;
	const bb = 2 * (fx * d.x + fy * d.y);
	if (bb >= 0) return -1; // moving away
	const disc = bb * bb - 4 * aa * cc;
	if (disc < 0) return -1;
	const t = (-bb - Math.sqrt(disc)) / (2 * aa);
	return t <= 1 ? t : -1;
}

export function updateProjectiles(world: World) {
	for (const p of world.projectiles) {
		// Swept test over this tick's whole path, so fast shots can't tunnel or skip
		// point-blank targets.
		const from = p.sweepFrom;
		p.pos = add(p.pos, scale(p.vel, DT));
		p.sweepFrom = copy(p.pos);
		p.life -= DT;
		if (p.life <= 0) continue;
		const owner = unitById(world, p.owner);
		if (!owner || owner.kind !== 'fighter') {
			p.life = 0;
			continue;
		}
		const path = sub(p.pos, from);
		const hits: { e: Unit; t: number }[] = [];
		// enemiesOf excludes the owner, so a shot can never hit its shooter.
		for (const e of enemiesOf(world, owner)) {
			if (p.hit.includes(e.id)) continue;
			const t = sweepCircle(from, path, e.pos, e.radius + p.radius);
			if (t >= 0) hits.push({ e, t });
		}
		hits.sort((a, b) => a.t - b.t); // stable: ties keep enemiesOf order
		for (const { e, t } of hits) {
			if (!e.alive) continue;
			if (p.aoe > 0) {
				const at = add(from, scale(path, t));
				p.pos = at;
				explode(world, owner, at, p.aoe, p.damage, { canCrit: true, onHit: true, forceBurn: p.forceBurn });
				p.life = 0;
				break;
			}
			p.hit.push(e.id);
			dealDamage(world, owner, e, p.damage, { canCrit: true, onHit: true, forceBurn: p.forceBurn });
			if (--p.pierce < 0) {
				p.pos = add(from, scale(path, t));
				p.life = 0;
				break;
			}
		}
	}
	world.projectiles = world.projectiles.filter((p) => p.life > 0);
}

export function tickStatuses(world: World, u: Unit) {
	const s = u.status;
	if (s.burnTime > 0) {
		s.burnTime -= DT;
		dealDamage(world, unitById(world, s.burnSrc), u, s.burnDps * DT, { dot: true });
	}
	if (s.bleedStacks > 0) {
		s.bleedTime -= DT;
		dealDamage(world, unitById(world, s.bleedSrc), u, s.bleedStacks * s.bleedPerStack * DT, { dot: true });
		if (s.bleedTime <= 0) s.bleedStacks = 0;
	}
}
