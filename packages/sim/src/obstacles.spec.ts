import { describe, expect, it } from 'vitest';
import { navigate, newNav } from './nav';
import {
	clearSpot,
	forEachObstacleNear,
	isClear,
	MAP_PROPS,
	moveWithCollision,
	OBSTACLES,
	overlappingObstacle,
	type Obstacle
} from './obstacles';
import { spawnMonster } from './monsters';
import { DT, MAP_RADIUS, type Command, type Unit, type World } from './types';
import { dist, type Vec2 } from './vec';
import { createWorld, equip, spawnFighter, step } from './world';

const EPS = 1e-3;
/** Grid-backed (the grid itself is checked against brute force below). */
const overlaps = (u: { pos: Vec2; radius: number }) => overlappingObstacle(u.pos, u.radius - EPS) !== null;

/** The rock (r ≥ minR) with the most free ground around it. */
function isolatedRock(minR: number): { o: Obstacle; gap: number } {
	let best: { o: Obstacle; gap: number } | null = null;
	for (const o of OBSTACLES) {
		if (o.r < minR || Math.hypot(o.x, o.y) > MAP_RADIUS - 20) continue;
		let gap = Infinity;
		for (const p of OBSTACLES) if (p !== o) gap = Math.min(gap, Math.hypot(p.x - o.x, p.y - o.y) - p.r - o.r);
		if (!best || gap > best.gap) best = { o, gap };
	}
	return best!;
}

function sandbox() {
	const { world, playerId } = createWorld({ seed: 9, fighters: 1, playerName: 'me', sandbox: true });
	const me = world.fighters.find((f) => f.id === playerId)!;
	return { world, me };
}

function assertNoOverlap(world: World) {
	const units: Unit[] = [...world.fighters, ...world.monsters].filter((u) => u.alive);
	const inside = units.filter(overlaps).map((u) => u.id);
	if (inside.length) expect(inside, `inside an obstacle at t=${world.time.toFixed(2)}`).toEqual([]);
}

describe('map obstacles', () => {
	it('come from the fixed prop layout: rocks and trunks block, pebbles do not', () => {
		expect(OBSTACLES.length).toBeGreaterThan(200);
		expect(MAP_PROPS.filter((p) => p.r > 0)).toHaveLength(OBSTACLES.length);
		expect(MAP_PROPS.some((p) => p.kind === 'rock' && p.r === 0)).toBe(true);
		for (const kind of ['rock', 'tree', 'deadTree'] as const) expect(MAP_PROPS.some((p) => p.kind === kind && p.r > 0)).toBe(true);
		// The centre (sandbox / tutorial start) is clear.
		expect(isClear({ x: 0, y: 0 }, 10)).toBe(true);
	});

	it('grid queries see every obstacle a brute-force scan finds', () => {
		for (let i = 0; i < 400; i++) {
			const p = { x: ((i * 37) % 240) - 120, y: ((i * 91) % 240) - 120 };
			const want = OBSTACLES.filter((o) => Math.hypot(p.x - o.x, p.y - o.y) < o.r + 3);
			const got: Obstacle[] = [];
			forEachObstacleNear(p.x, p.y, 3, (o) => got.push(o));
			for (const o of want) expect(got).toContain(o);
			expect(overlappingObstacle(p, 1) !== null).toBe(OBSTACLES.some((o) => Math.hypot(p.x - o.x, p.y - o.y) < o.r + 1));
		}
	});

	it('clearSpot moves a point out of a rock, and leaves free ground alone', () => {
		const { o } = isolatedRock(1);
		const inside = { x: o.x + 0.1, y: o.y };
		const out = clearSpot(inside, 0.7);
		expect(isClear(out, 0.7 - EPS)).toBe(true);
		expect(clearSpot({ x: 0, y: 0 }, 0.7)).toEqual({ x: 0, y: 0 });
	});

	it('a fast move never tunnels through a rock', () => {
		const { o } = isolatedRock(1);
		const from = { x: o.x - o.r - 1, y: o.y + 0.2 };
		const to = moveWithCollision(from, { x: (o.r + 1) * 2, y: 0 }, 0.7);
		expect(to.x).toBeLessThan(o.x + 0.2);
		expect(isClear(to, 0.7 - EPS)).toBe(true);
	});
});

describe('movement against obstacles', () => {
	it('a player walking and dashing into a rock never ends a tick inside it', () => {
		const { world, me } = sandbox();
		const { o } = isolatedRock(1.2);
		me.pos = { x: o.x - o.r - 3, y: o.y };
		const push: Command[] = [{ type: 'move', dir: { x: 1, y: 0 }, run: true }];
		for (let t = 0; t < 60; t++) {
			const cmds = t === 10 || t === 40 ? [...push, { type: 'dash', dir: { x: 1, y: 0 } } as Command] : push;
			step(world, new Map([[me.id, cmds]]));
			assertNoOverlap(world);
		}
		// Head-on with no steering: it is held at the surface, not pushed through.
		expect(me.pos.x).toBeLessThan(o.x);
	});

	it('a player walking into a rock off-centre slides along it and reaches the goal behind', () => {
		const { world, me } = sandbox();
		const { o } = isolatedRock(1.2);
		me.pos = { x: o.x - o.r - 3, y: o.y + o.r * 0.4 };
		const goal = { x: o.x + o.r + 2, y: o.y };
		let reached = -1;
		for (let t = 0; t < 5 / DT && reached < 0; t++) {
			const dir = { x: goal.x - me.pos.x, y: goal.y - me.pos.y };
			step(world, new Map([[me.id, [{ type: 'move', dir, run: true } as Command]]]));
			assertNoOverlap(world);
			if (dist(me.pos, goal) < 0.5) reached = world.time;
		}
		expect(reached).toBeGreaterThan(0);
	});

	it('a monster chasing a target hidden behind a rock goes around it', () => {
		const { world, me } = sandbox();
		const { o } = isolatedRock(1.2);
		me.pos = { x: o.x + o.r + 1.2, y: o.y };
		// Head-on: the target sits dead behind the rock's centre.
		const m = spawnMonster(world, 3, { x: o.x - o.r - 2.5, y: o.y });
		m.targetId = me.id;
		let contact = -1;
		for (let t = 0; t < 4 / DT && contact < 0; t++) {
			me.hp = me.maxHp;
			step(world, new Map([[me.id, [{ type: 'move', dir: null, run: false } as Command]]]));
			assertNoOverlap(world);
			if (dist(m.pos, me.pos) <= m.radius + me.radius + 0.6) contact = world.time;
		}
		expect(contact).toBeGreaterThan(0);
	});

	it('an aggressive bot reaches a target behind a rock', () => {
		const { world, me } = sandbox();
		const { o } = isolatedRock(1.2);
		me.pos = { x: o.x + o.r + 1.2, y: o.y };
		const bot = spawnFighter(world, { name: 'bot', color: '#f00', pos: { x: o.x - o.r - 3, y: o.y }, bot: true, aggressive: true });
		// Melee, so it has to walk up (a ranged bot would just shoot over the rock).
		bot.offer = null;
		bot.pendingDrafts = 0;
		equip(world, bot, 'greatsword');
		let near = -1;
		for (let t = 0; t < 4 / DT && near < 0; t++) {
			me.hp = me.maxHp;
			step(world, new Map([[me.id, [{ type: 'move', dir: null, run: false } as Command]]]));
			assertNoOverlap(world);
			// In sword reach (the bot stops there to swing).
			if (dist(bot.pos, me.pos) <= bot.build.stats.range + me.radius * 0.8 + 0.05) near = world.time;
		}
		expect(near).toBeGreaterThan(0);
	});

	it('stuck detection detours out of a gap too narrow to pass', () => {
		// The tightest pair of big obstacles on the map forms a wall with a unit-sized notch.
		let pair: [Obstacle, Obstacle] | null = null;
		let bestGap = Infinity;
		for (let i = 0; i < OBSTACLES.length; i++) {
			for (let j = i + 1; j < OBSTACLES.length; j++) {
				const a = OBSTACLES[i];
				const b = OBSTACLES[j];
				if (a.r < 0.8 || b.r < 0.8) continue;
				const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
				if (gap > -0.3 && gap < bestGap) {
					bestGap = gap;
					pair = [a, b];
				}
			}
		}
		expect(bestGap).toBeLessThan(1.4);
		const [a, b] = pair!;
		const l = Math.hypot(b.x - a.x, b.y - a.y);
		const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
		// The notch point between the two surfaces.
		const t = (a.r + (l - a.r - b.r) / 2) / l;
		const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		const radius = 0.7;
		for (const s of [1, -1]) {
			let pos = clearSpot({ x: mid.x - n.x * 4 * s, y: mid.y - n.y * 4 * s }, radius);
			const goal = clearSpot({ x: mid.x + n.x * 4 * s, y: mid.y + n.y * 4 * s }, radius);
			for (const id of [1, 2]) {
				const nav = newNav(id, pos);
				let start = pos;
				let reached = false;
				for (let tick = 0; tick < 10 / DT && !reached; tick++) {
					const dir = navigate(nav, start, radius, goal, 6, tick);
					if (dir) start = moveWithCollision(start, { x: dir.x * 6 * DT, y: dir.y * 6 * DT }, radius);
					expect(isClear(start, radius - EPS)).toBe(true);
					reached = dist(start, goal) < 0.6;
				}
				expect(reached, `side ${s}, id ${id}`).toBe(true);
				pos = clearSpot({ x: mid.x - n.x * 4 * s, y: mid.y - n.y * 4 * s }, radius);
			}
		}
	});
});

describe('obstacles in a match', () => {
	it('no monster or fighter ever spawns inside an obstacle', () => {
		for (const seed of [1, 2, 3]) {
			const { world } = createWorld({ seed, fighters: 12 });
			const seen = new Set<number>();
			for (let t = 0; t < 60 / DT && !world.over; t++) {
				for (const m of world.monsters) {
					if (seen.has(m.id)) continue;
					seen.add(m.id);
					if (!isClear(m.home, m.radius)) expect.fail(`monster ${m.id} spawned inside an obstacle`);
				}
				if (world.fighters.some(overlaps)) expect(world.fighters.filter(overlaps).map((f) => f.id)).toEqual([]);
				step(world);
			}
			expect(seen.size).toBeGreaterThan(60);
		}
	});

	it('all-bot matches keep every unit out of obstacles', () => {
		const { world } = createWorld({ seed: 4, fighters: 12 });
		for (let t = 0; t < 120 / DT && !world.over; t++) {
			step(world);
			assertNoOverlap(world);
		}
	});

	it('a roaming bot keeps its goal between thinks instead of rerolling it', () => {
		const { world } = createWorld({ seed: 3, fighters: 0, sandbox: true });
		const bot = spawnFighter(world, { name: 'bot', color: '#f00', pos: { x: 0, y: 0 }, bot: true });
		bot.offer = null;
		bot.pendingDrafts = 0;
		const goals = new Set<string>();
		for (let t = 0; t < 2 / DT; t++) {
			step(world);
			if (bot.bot!.mode === 'roam' && bot.bot!.goal) goals.add(`${bot.bot!.goal.x},${bot.bot!.goal.y}`);
		}
		// Roam goals sit 80+ units out: one goal for the whole 2 s (≥ 5 thinks).
		expect(goals.size).toBe(1);
	});
});
