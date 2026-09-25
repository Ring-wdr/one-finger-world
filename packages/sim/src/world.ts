import { botCommands } from './bot';
import { summarizeBuild } from './build';
import {
	applyBuild,
	castSkills,
	dealDamage,
	ensureOffer,
	performAttack,
	registerUnit,
	reindex,
	startDash,
	tickStatuses,
	updateDash,
	updateProjectiles
} from './combat';
import { isOfferable, phaseAt, rollOffer } from './draft';
import { getItem, WEAPON_IDS } from './items';
import { spawnMonsters, updateMonster } from './monsters';
import { Rng } from './rng';
import { newStatus } from './status';
import { TAGS } from './tags';
import {
	DT,
	MAP_RADIUS,
	type Command,
	type Fighter,
	type World
} from './types';
import { add, clampToCircle, copy, dist, fromAngle, normalize, scale } from './vec';
import { createZone, isInside, updateZone } from './zone';

const BOT_NAMES = [
	'잿빛늑대', '붉은망치', '푸른화살', '그림자', '쇠방패', '들불', '칼날비', '돌풍',
	'핏빛달', '서리꽃', '천둥새', '모래폭풍', '은빛여우', '검은곰', '황금매', '안개', '불곰', '빗방울', '먹구름'
];
const COLORS = [
	'#4fc3f7', '#ef5350', '#ab47bc', '#66bb6a', '#ffa726', '#26c6da', '#ec407a', '#d4e157',
	'#8d6e63', '#78909c', '#5c6bc0', '#ffee58', '#26a69a', '#ff7043', '#9ccc65', '#7e57c2', '#bdbdbd', '#f06292', '#29b6f6', '#aed581'
];

export const START_REROLLS = 2;
/** Out-of-combat recovery: lets players reset between fights without potions. */
const OOC_DELAY = 5;
const OOC_REGEN_FRAC = 0.04;

export interface WorldOptions {
	seed: number;
	/** Total fighters, 10–20 recommended. */
	fighters: number;
	/** Name for the human player (id is returned as `playerId`). Omit for an all-bot match. */
	playerName?: string;
	/** No spawns, zone, phases or win check — the caller scripts the world (tutorial). */
	sandbox?: boolean;
}

export function createWorld(opts: WorldOptions): { world: World; playerId: number | null } {
	const rng = new Rng(opts.seed);
	const world: World = {
		seed: opts.seed,
		rules: {
			spawnMonsters: !opts.sandbox,
			zone: !opts.sandbox,
			phases: !opts.sandbox,
			endWhenOneLeft: !opts.sandbox
		},
		time: 0,
		tick: 0,
		rng,
		nextId: 1,
		phase: 1,
		fighters: [],
		monsters: [],
		projectiles: [],
		pickups: [],
		zone: createZone(rng, MAP_RADIUS),
		events: [],
		spawnTimer: 0,
		over: false,
		winner: null
	};

	const names = rng.shuffle([...BOT_NAMES]);
	const offset = rng.range(0, Math.PI * 2);
	let playerId: number | null = null;
	for (let i = 0; i < opts.fighters; i++) {
		const isPlayer = i === 0 && opts.playerName !== undefined;
		const angle = offset + (i / opts.fighters) * Math.PI * 2;
		const pos = opts.sandbox ? { x: 0, y: 0 } : fromAngle(angle, 100 + rng.range(-6, 6));
		const f = spawnFighter(world, {
			name: isPlayer ? opts.playerName! : names[i % names.length],
			color: isPlayer ? '#ffffff' : COLORS[i % COLORS.length],
			pos,
			bot: !isPlayer
		});
		if (isPlayer) playerId = f.id;
	}

	reindex(world);
	// Seed the map so the first seconds aren't empty.
	if (world.rules.spawnMonsters) for (let i = 0; i < 60; i++) spawnMonsters(world, true);
	return { world, playerId };
}

export interface SpawnFighterOptions {
	name: string;
	color: string;
	pos: { x: number; y: number };
	bot: boolean;
	aggressive?: boolean;
}

export function spawnFighter(world: World, o: SpawnFighterOptions): Fighter {
	const build = summarizeBuild([]);
	const rng = world.rng;
	const f: Fighter = {
		kind: 'fighter',
		id: world.nextId++,
		name: o.name,
		color: o.color,
		bot: o.bot
			? {
					prefTags: rng.shuffle([...TAGS]).slice(0, 2),
					risk: rng.next(),
					thinkTimer: rng.next() * 0.3,
					targetId: null,
					goal: null,
					mode: 'roam',
					aggressive: o.aggressive ?? false
				}
			: null,
		pos: copy(o.pos),
		radius: 0.7,
		hp: build.stats.maxHp,
		maxHp: build.stats.maxHp,
		alive: true,
		status: newStatus(),
		facing: normalize({ x: -o.pos.x, y: -o.pos.y }),
		moveDir: null,
		running: false,
		level: 1,
		xp: 0,
		items: [],
		build,
		shield: 0,
		sinceHurt: 0,
		attackCd: 0,
		attackQueued: 0,
		rootTime: 0,
		combo: 1,
		comboTimer: 0,
		dashCd: 0,
		dashTime: 0,
		dashDir: { x: 0, y: 1 },
		dashHit: [],
		hasteBuff: 0,
		skillCds: {},
		// The opening pick is always the weapon: it decides melee vs ranged.
		pendingDrafts: 1,
		offer: [...WEAPON_IDS],
		rerolls: START_REROLLS,
		exchangeTokens: 0,
		kills: 0,
		placement: null,
		lastAttacker: null,
		lastAttackedAt: -999
	};
	world.fighters.push(f);
	registerUnit(world, f);
	return f;
}

export function applyCommand(world: World, f: Fighter, cmd: Command) {
	switch (cmd.type) {
		case 'move':
			f.moveDir = cmd.dir ? normalize(cmd.dir) : null;
			if (f.moveDir && f.moveDir.x === 0 && f.moveDir.y === 0) f.moveDir = null;
			f.running = cmd.run;
			return;
		case 'attack':
			f.attackQueued = 0.25;
			return;
		case 'dash':
			startDash(world, f, cmd.dir);
			return;
		case 'draft': {
			const id = f.offer?.[cmd.index];
			if (!id || !isOfferable(getItem(id), f.items)) return;
			f.pendingDrafts -= 1;
			f.offer = null;
			equip(world, f, id);
			ensureOffer(world, f);
			return;
		}
		case 'reroll':
			// The starting weapon choice can't be rerolled away.
			if (!f.offer || f.rerolls <= 0 || !f.build.weapon) return;
			f.rerolls -= 1;
			f.offer = rollOffer(world.rng, world.phase, f.items);
			return;
		case 'exchange':
			if (f.exchangeTokens <= 0 || !f.items[cmd.itemIndex]) return;
			if (getItem(f.items[cmd.itemIndex]).kind === 'weapon') return;
			f.items.splice(cmd.itemIndex, 1);
			f.exchangeTokens -= 1;
			f.pendingDrafts += 1;
			applyBuild(world, f);
			ensureOffer(world, f);
			return;
	}
}

/** Adds an item; a weapon replaces the currently equipped one. */
export function equip(world: World, f: Fighter, id: string) {
	if (getItem(id).kind === 'weapon') f.items = f.items.filter((x) => getItem(x).kind !== 'weapon');
	f.items.push(id);
	applyBuild(world, f);
}

function updateFighter(world: World, f: Fighter) {
	const s = f.build.stats;
	f.attackCd -= DT;
	f.dashCd -= DT;
	f.rootTime -= DT;
	f.comboTimer -= DT;
	f.attackQueued -= DT;
	f.hasteBuff -= DT;
	f.sinceHurt += DT;
	for (const k of Object.keys(f.skillCds) as (keyof typeof f.skillCds)[]) f.skillCds[k]! -= DT;

	const outOfCombat = f.sinceHurt >= OOC_DELAY ? OOC_REGEN_FRAC * f.maxHp : 0;
	f.hp = Math.min(f.maxHp, f.hp + (s.regen + outOfCombat) * DT);
	if (f.build.tiers.guard >= 1 && f.sinceHurt >= 4) {
		const cap = f.maxHp * 0.15;
		if (f.shield < cap) f.shield = Math.min(cap, f.shield + f.maxHp * 0.15 * DT);
	}

	if (f.dashTime > 0) {
		updateDash(world, f);
	} else {
		if (f.moveDir && f.rootTime <= 0) {
			const speed = s.moveSpeed * (f.running ? 1 : 0.55);
			f.pos = add(f.pos, scale(f.moveDir, speed * DT));
			f.facing = copy(f.moveDir);
		}
		if (f.attackQueued > 0 && f.attackCd <= 0) performAttack(world, f);
	}
	f.pos = clampToCircle(f.pos, { x: 0, y: 0 }, MAP_RADIUS);
	castSkills(world, f);
}

function collectPickups(world: World) {
	if (world.pickups.length === 0) return;
	world.pickups = world.pickups.filter((p) => {
		for (const f of world.fighters) {
			if (!f.alive || dist(f.pos, p.pos) > 1.6) continue;
			if (!isOfferable(getItem(p.itemId), f.items)) continue;
			equip(world, f, p.itemId);
			world.events.push({ type: 'pickup', unit: f.id, itemId: p.itemId });
			return false;
		}
		return true;
	});
}

function onPhaseChange(world: World) {
	world.events.push({ type: 'phase', phase: world.phase });
	for (const f of world.fighters) {
		if (!f.alive) continue;
		f.rerolls += 1;
		f.exchangeTokens += 1;
		// Banked drafts re-roll into the new phase's resource type.
		if (f.offer) f.offer = rollOffer(world.rng, world.phase, f.items);
	}
}

/**
 * Advance one fixed tick. `commands` are this tick's inputs from non-bot fighters.
 * Pure function of (world, commands) → deterministic given the same seed and inputs.
 */
export function step(world: World, commands?: ReadonlyMap<number, readonly Command[]>) {
	if (world.over) return;
	world.events = [];
	reindex(world);
	world.time += DT;
	world.tick += 1;

	const phase = phaseAt(world.time);
	if (world.rules.phases && phase !== world.phase) {
		world.phase = phase;
		onPhaseChange(world);
	}
	if (world.rules.zone && updateZone(world.zone, world.time, world.rng)) {
		world.events.push({ type: 'zone', stage: world.zone.stage });
	}

	for (const f of world.fighters) {
		if (!f.alive) continue;
		const cmds = f.bot ? botCommands(world, f) : (commands?.get(f.id) ?? []);
		for (const c of cmds) applyCommand(world, f, c);
	}
	for (const f of world.fighters) if (f.alive) updateFighter(world, f);

	if (world.rules.spawnMonsters) spawnMonsters(world);
	for (const m of world.monsters) if (m.alive) updateMonster(world, m);

	updateProjectiles(world);
	for (const f of world.fighters) if (f.alive) tickStatuses(world, f);
	for (const m of world.monsters) if (m.alive) tickStatuses(world, m);

	const dps = world.zone.dps;
	for (const f of world.fighters) {
		if (f.alive && !isInside(world.zone, f.pos)) {
			dealDamage(world, null, f, dps * DT, { dot: true, environmental: true });
		}
	}
	for (const m of world.monsters) {
		if (m.alive && !isInside(world.zone, m.pos)) {
			dealDamage(world, null, m, dps * 3 * DT, { dot: true, environmental: true });
		}
	}

	collectPickups(world);
	world.monsters = world.monsters.filter((m) => m.alive);

	const alive = world.fighters.filter((f) => f.alive);
	if (world.rules.endWhenOneLeft && alive.length <= 1) {
		world.over = true;
		world.winner = alive[0]?.id ?? null;
		if (alive[0]) alive[0].placement = 1;
		world.events.push({ type: 'end', winner: world.winner });
	}
}

export function runHeadless(world: World, maxSeconds = 600) {
	const maxTicks = Math.ceil(maxSeconds / DT);
	while (!world.over && world.tick < maxTicks) step(world);
	return world;
}
