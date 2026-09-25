import { usesRangedBasic } from './build';
import { unitById } from './combat';
import { isOfferable } from './draft';
import { getItem, WEAPON_IDS } from './items';
import { navigate } from './nav';
import { clearSpot } from './obstacles';
import { SYNERGY_THRESHOLDS } from './tags';
import type { Circle } from './zone';
import { DT, RING, MAP_RADIUS, type Command, type Fighter, type Unit, type World } from './types';
import { add, clampToCircle, dist, fromAngle, normalize, scale, sub, type Vec2 } from './vec';

/** Rough "who wins a trade" estimate: sustained damage × effective HP. */
export function powerScore(f: Fighter) {
	const s = f.build.stats;
	const dps = s.damage * s.attackRate * (1 + s.crit) * (1 + f.build.skills.length * 0.25);
	const ehp = (f.hp + f.shield) / s.damageTaken;
	return dps * ehp;
}

export function scoreItem(f: Fighter, itemId: string) {
	const item = getItem(itemId);
	const counts = f.build.tagCounts;
	const pref = f.bot?.prefTags ?? [];
	if (item.kind === 'weapon') {
		// Opening pick is spread evenly across weapons so balance runs compare them fairly.
		if (!f.build.weapon) return WEAPON_IDS.indexOf(item.id) === f.id % WEAPON_IDS.length ? 10 : 0;
		// Mid-match swaps throw away the attack style the build grew around.
		return item.tags.some((t) => pref.includes(t)) ? 1.5 : 0;
	}
	let score = 0;
	for (const tag of item.tags) {
		score += 1 + counts[tag] * 0.5 + (pref.includes(tag) ? 1.2 : 0);
		if (SYNERGY_THRESHOLDS.includes((counts[tag] + 1) as 3 | 5)) score += 2;
	}
	if (item.rarity === 'rare') score += 0.5;
	if (item.kind === 'skill') score += 1;
	if (item.bridge) score += 1 + counts[item.bridge.from] * 0.4;
	return score;
}

function draftCommand(world: World, f: Fighter): Command | null {
	if (!f.offer) return null;
	let best = 0;
	let bestScore = -Infinity;
	f.offer.forEach((id, i) => {
		const s = scoreItem(f, id);
		if (s > bestScore) {
			bestScore = s;
			best = i;
		}
	});
	if (bestScore < 3 && f.rerolls > 0 && f.build.weapon && world.rng.chance(0.5)) return { type: 'reroll' };
	return { type: 'draft', index: best };
}

/** Divers enter richer rings up to two levels earlier than cautious bots. */
function preferredBand(f: Fighter): [number, number] {
	const lvl = f.level + Math.round(f.bot!.risk * 2);
	if (lvl >= 9) return [4, RING.center];
	if (lvl >= 5) return [RING.center, RING.mid];
	return [RING.mid, MAP_RADIUS - 4];
}

/** A roam goal is given up on after this long, reached or not. */
const ROAM_TIMEOUT = 10;
/** ...or after this many consecutive stuck windows (0.5 s each) on the way. */
const ROAM_GIVE_UP_STUCK = 4;

/**
 * Re-evaluates the bot's mode. Goals are recomputed from the situation, except a roam goal,
 * which is kept until reached, blocked or timed out so roaming bots walk somewhere instead
 * of zig-zagging between fresh random points.
 */
function think(world: World, f: Fighter) {
	const b = f.bot!;
	const zone = world.zone;
	const safe = zone.shrinking || zone.timer < 12 ? zone.to : zone.current;
	const keptRoam = b.mode === 'roam' ? b.goal : null;

	b.targetId = null;
	b.goal = null;

	if (b.aggressive) {
		let nearest: Fighter | null = null;
		for (const o of world.fighters) {
			if (o.alive && o !== f && (!nearest || dist(o.pos, f.pos) < dist(nearest.pos, f.pos))) nearest = o;
		}
		if (nearest) {
			b.mode = 'fight';
			b.targetId = nearest.id;
			return;
		}
	}

	// The zone centre may sit in a rock: head for the nearest free spot instead.
	const safeCenter = clearSpot(safe.center, f.radius + 0.2);
	if (dist(f.pos, safeCenter) > Math.max(2, safe.radius - 3)) {
		b.mode = 'zone';
		b.goal = safeCenter;
		return;
	}

	const hpFrac = f.hp / f.maxHp;
	if (hpFrac < 0.4) {
		let threat: Unit | null = null;
		let threatD = 9;
		for (const m of world.monsters) {
			const d = dist(m.pos, f.pos);
			if (m.alive && d < threatD && (m.targetId === f.id || d < 5)) {
				threatD = d;
				threat = m;
			}
		}
		if (threat) {
			b.mode = 'flee';
			b.goal = fleeGoal(f, threat.pos, safe);
			return;
		}
	}
	if (hpFrac < 0.6 && f.sinceHurt > 1) {
		b.mode = 'rest';
		return;
	}

	let enemy: Fighter | null = null;
	let enemyD = 12;
	for (const o of world.fighters) {
		if (!o.alive || o === f) continue;
		const d = dist(o.pos, f.pos);
		if (d < enemyD) {
			enemyD = d;
			enemy = o;
		}
	}
	if (enemy) {
		const ratio = powerScore(f) / Math.max(1, powerScore(enemy));
		// Early builds are thin; picking fights before skills arrive mostly feeds the zone.
		const phaseCaution = world.phase === 1 ? 0.4 : world.phase === 2 ? 0.3 : 0;
		const bravery = 1.25 - b.risk * 0.5 + phaseCaution;
		const provoked = f.lastAttacker === enemy.id && world.time - f.lastAttackedAt < 3;
		const willing = world.phase > 1 || provoked || ratio >= 2;
		if (willing && ratio >= bravery && hpFrac > 0.6) {
			b.mode = 'fight';
			b.targetId = enemy.id;
			return;
		}
		if (enemyD < 8) {
			b.mode = 'flee';
			b.goal = fleeGoal(f, enemy.pos, safe);
			return;
		}
	}

	const loot = world.pickups.find((p) => dist(p.pos, f.pos) < 18 && isOfferable(getItem(p.itemId), f.items));
	if (loot) {
		b.mode = 'loot';
		b.goal = copyVec(loot.pos);
		return;
	}

	const [bandIn, bandOut] = preferredBand(f);
	const maxTier = bandIn < RING.center ? 3 : bandIn < RING.mid ? 2 : 1;
	let prey: Unit | null = null;
	let preyD = 28;
	for (const m of world.monsters) {
		if (!m.alive || m.tier > maxTier) continue;
		const d = dist(m.pos, f.pos);
		if (d < preyD) {
			preyD = d;
			prey = m;
		}
	}
	if (prey) {
		b.mode = 'farm';
		b.targetId = prey.id;
		return;
	}

	b.mode = 'roam';
	if (keptRoam && b.goalTimer > 0 && dist(keptRoam, safe.center) <= safe.radius * 0.8 + 1e-6) {
		b.goal = keptRoam;
		return;
	}
	const p = fromAngle(world.rng.range(0, Math.PI * 2), world.rng.range(bandIn, bandOut));
	b.goal = clearSpot(clampToCircle(p, safe.center, safe.radius * 0.8), f.radius + 0.2);
	b.goalTimer = ROAM_TIMEOUT;
}

/** Run away, but bend toward the bot's own (safer) ring instead of into the dangerous center. */
function fleeGoal(f: Fighter, from: Vec2, safe: Circle): Vec2 {
	const away = normalize(sub(f.pos, from));
	const [bandIn, bandOut] = preferredBand(f);
	const r = Math.hypot(f.pos.x, f.pos.y);
	const radial = normalize(f.pos);
	const bias = r < bandIn ? scale(radial, 0.8) : r > bandOut ? scale(radial, -0.8) : { x: 0, y: 0 };
	const goal = add(f.pos, scale(normalize(add(away, bias)), 12));
	return clearSpot(clampToCircle(goal, safe.center, safe.radius * 0.9), f.radius + 0.2);
}

function copyVec(v: Vec2): Vec2 {
	return { x: v.x, y: v.y };
}

/** Steered direction toward `goal` (null when there): obstacle-aware, with stuck detours. */
function steerTo(world: World, f: Fighter, goal: Vec2): Vec2 | null {
	const speed = f.rootTime > 0 || f.dashTime > 0 ? 0 : f.build.stats.moveSpeed;
	return navigate(f.nav, f.pos, f.radius, goal, speed, world.tick);
}

/** Bots speak the same Command language as humans, so the server never special-cases them. */
export function botCommands(world: World, f: Fighter): Command[] {
	const b = f.bot!;
	const cmds: Command[] = [];

	const draft = draftCommand(world, f);
	if (draft) cmds.push(draft);

	b.thinkTimer -= DT;
	b.goalTimer -= DT;
	const target = unitById(world, b.targetId);
	if (b.thinkTimer <= 0 || (b.targetId !== null && !target?.alive)) {
		b.thinkTimer = 0.3 + world.rng.next() * 0.1;
		think(world, f);
	}

	const t = unitById(world, b.targetId);
	if (t && t.alive) {
		const s = f.build.stats;
		const reach = usesRangedBasic(f.build) ? s.range * 3.2 : s.range + t.radius * 0.8;
		const d = dist(t.pos, f.pos);
		if (d <= reach) {
			cmds.push({ type: 'move', dir: null, run: true });
			if (f.attackCd <= 0) cmds.push({ type: 'attack' });
		} else {
			const dir = normalize(sub(t.pos, f.pos));
			cmds.push({ type: 'move', dir: steerTo(world, f, t.pos) ?? dir, run: true });
			// Dashes go straight (they slide along obstacles but don't steer).
			if (b.mode === 'fight' && d > 4 && d < 8 && f.dashCd <= 0 && world.rng.chance(0.03)) {
				cmds.push({ type: 'dash', dir });
			}
		}
		return cmds;
	}

	if (b.goal && b.mode === 'roam' && f.nav.stuckCount >= ROAM_GIVE_UP_STUCK) {
		// Blocked for good: drop it and roll a new one at the next think.
		b.goal = null;
		f.nav.stuckCount = 0;
	}
	if (b.goal) {
		if (dist(b.goal, f.pos) < 1.5) {
			b.goal = null;
			cmds.push({ type: 'move', dir: null, run: true });
		} else {
			const dir = normalize(sub(b.goal, f.pos));
			cmds.push({ type: 'move', dir: steerTo(world, f, b.goal) ?? dir, run: true });
			if (b.mode === 'flee' && f.dashCd <= 0) cmds.push({ type: 'dash', dir });
		}
		return cmds;
	}

	cmds.push({ type: 'move', dir: null, run: true });
	return cmds;
}
