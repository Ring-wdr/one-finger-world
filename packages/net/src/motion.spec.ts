import { OBSTACLES, Rng, createWorld, equip, step, type Fighter, type Vec2 } from '@ofa/sim';
import { describe, expect, it } from 'vitest';
import { emptyFrame, frameToCommands, quantizeDir, type InputFrame } from './input';
import { motionFromFighter, motionFromSelf, motionStats, stepMotion, type MotionState } from './motion';
import type { SelfState } from './snapshot';

const vecEq = (a: Vec2 | null, b: Vec2 | null) => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y);

function expectSame(f: Fighter, s: MotionState, label: string) {
	const m = motionFromFighter(f);
	const keys = ['running', 'dashTime', 'dashCd', 'dashCdMax', 'rootTime', 'attackCd', 'attackQueued', 'hasteBuff'] as const;
	for (const k of keys) expect(s[k], `${label} ${k}`).toBe(m[k]);
	for (const k of ['pos', 'facing', 'dashDir', 'moveDir'] as const) expect(vecEq(s[k], m[k]), `${label} ${k}`).toBe(true);
}

interface Scenario {
	name: string;
	items: string[];
	start: Vec2;
	/** Point the joystick mostly heads for, to reach walls and rocks. */
	aim: Vec2 | null;
	tier: number;
}

const rock = OBSTACLES[0];
const SCENARIOS: Scenario[] = [
	{ name: 'base build', items: [], start: { x: 0, y: 0 }, aim: null, tier: 0 },
	{ name: 'speed tier 1', items: ['light_boots', 'wind_cloak', 'skill_flash'], start: { x: 0, y: 0 }, aim: null, tier: 1 },
	{
		name: 'speed tier 2',
		items: ['light_boots', 'wind_cloak', 'skill_flash', 'charging_plate', 'razor_wind'],
		start: { x: 0, y: 0 },
		aim: null,
		tier: 2
	},
	{ name: 'map edge', items: [], start: { x: 118, y: 0 }, aim: { x: 200, y: 0 }, tier: 0 },
	{ name: 'next to a rock', items: [], start: { x: rock.x - rock.r - 2, y: rock.y + 0.3 }, aim: { x: rock.x, y: rock.y }, tier: 0 }
];

function randomFrame(rng: Rng, seq: number, from: Vec2, aim: Vec2 | null): InputFrame | null {
	if (rng.next() < 0.1) return null;
	const f = emptyFrame(seq);
	if (rng.next() < 0.85) {
		const toward = aim && rng.next() < 0.7;
		const raw = toward ? { x: aim.x - from.x, y: aim.y - from.y } : { x: rng.range(-1, 1), y: rng.range(-1, 1) };
		const len = Math.hypot(raw.x, raw.y) || 1;
		f.move = quantizeDir({ x: raw.x / len, y: raw.y / len });
	}
	f.run = rng.next() < 0.6;
	f.attack = rng.next() < 0.15;
	if (rng.next() < 0.04) {
		f.dash = rng.next() < 0.1 ? { x: 0, y: 0 } : quantizeDir({ x: rng.range(-1, 1), y: rng.range(-1, 1) });
		f.dashTouch = rng.next() < 0.5;
	}
	return f;
}

describe('stepMotion equivalence with sim step()', () => {
	for (const sc of SCENARIOS) {
		it(`matches the sim for 2000 ticks: ${sc.name}`, () => {
			const { world, playerId } = createWorld({ seed: 7, fighters: 1, playerName: 'me', sandbox: true });
			const f = world.fighters.find((x) => x.id === playerId)!;
			for (const id of sc.items) equip(world, f, id);
			f.offer = null;
			f.pendingDrafts = 0;
			f.pos = { ...sc.start };
			expect(f.build.tiers.speed).toBe(sc.tier);
			const stats = motionStats(f.build, f.radius);
			const state = motionFromFighter(f);
			const rng = new Rng(1234);
			let dashes = 0;
			let attacks = 0;
			for (let tick = 1; tick <= 2000; tick++) {
				const frame = randomFrame(rng, tick, f.pos, sc.aim);
				const before = f.dashTime;
				step(world, new Map(frame ? [[f.id, frameToCommands(frame)]] : []));
				stepMotion(state, frame, stats);
				if (f.dashTime > before) dashes++;
				if (f.rootTime > 0.09) attacks++;
				expectSame(f, state, `tick ${tick}`);
			}
			// The run has to actually exercise dashes and attacks, not just walking.
			expect(dashes).toBeGreaterThan(10);
			expect(attacks).toBeGreaterThan(10);
		});
	}
});

describe('motion helpers', () => {
	it('motionStats reads the build numbers', () => {
		const { world, playerId } = createWorld({ seed: 1, fighters: 1, playerName: 'me', sandbox: true });
		const f = world.fighters.find((x) => x.id === playerId)!;
		expect(motionStats(f.build, 0.7)).toEqual({
			moveSpeed: f.build.stats.moveSpeed,
			attackRate: f.build.stats.attackRate,
			cdr: f.build.stats.cdr,
			speedTier: f.build.tiers.speed,
			radius: 0.7
		});
	});

	it('copies never share vectors with the source', () => {
		const { world, playerId } = createWorld({ seed: 1, fighters: 1, playerName: 'me', sandbox: true });
		const f = world.fighters.find((x) => x.id === playerId)!;
		f.moveDir = { x: 1, y: 0 };
		const m = motionFromFighter(f);
		expect(m.pos).not.toBe(f.pos);
		expect(m.facing).not.toBe(f.facing);
		expect(m.dashDir).not.toBe(f.dashDir);
		expect(m.moveDir).not.toBe(f.moveDir);
		expect(m.moveDir).toEqual({ x: 1, y: 0 });

		const self: SelfState = {
			...m,
			hp: 1,
			maxHp: 1,
			shield: 0,
			xp: 0,
			level: 1,
			kills: 0
		};
		const c = motionFromSelf(self);
		expect(c.pos).toEqual(self.pos);
		expect(c.pos).not.toBe(self.pos);
		expect(c.moveDir).not.toBe(self.moveDir);
		expect('hp' in c).toBe(false);
	});
});
