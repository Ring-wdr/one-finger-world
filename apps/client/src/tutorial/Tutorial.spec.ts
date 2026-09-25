import { describe, expect, it } from 'vitest';
import { dist, normalize, step, sub, WEAPON_IDS, type Command } from '@ofa/sim';
import { Tutorial } from './Tutorial';

/** Plays the tutorial the way an attentive player would, using only normal Commands. */
function autopilot(t: Tutorial): Command[] {
	const me = t.me;
	if (t.stepId === 'build') {
		t.signal('buildOpened');
		return [];
	}
	if (me.offer) return [{ type: 'draft', index: 0 }];

	if (t.marker) {
		const d = dist(me.pos, t.marker.pos);
		const dir = normalize(sub(t.marker.pos, me.pos));
		if (d < 0.5) return [{ type: 'move', dir: null, run: false }];
		const cmds: Command[] = [{ type: 'move', dir, run: true }];
		if (t.stepId === 'dash' && me.dashCd <= 0 && d > 3) cmds.push({ type: 'dash', dir });
		return cmds;
	}

	const foes = [...t.world.monsters, ...t.world.fighters.filter((f) => f.id !== me.id)].filter((u) => u.alive);
	foes.sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos));
	const foe = foes[0];
	if (!foe) return [{ type: 'move', dir: null, run: false }];
	const reach = me.build.attack === 'ranged' ? me.build.stats.range * 3 : me.build.stats.range + foe.radius * 0.8;
	if (dist(foe.pos, me.pos) <= reach) return [{ type: 'move', dir: null, run: false }, { type: 'attack' }];
	return [{ type: 'move', dir: normalize(sub(foe.pos, me.pos)), run: true }];
}

function playThrough(t: Tutorial, maxSeconds = 300) {
	const seen: string[] = [t.stepId];
	for (let tick = 0; tick < maxSeconds * 20 && !t.finished; tick++) {
		step(t.world, new Map([[t.playerId, autopilot(t)]]));
		if (t.afterStep(t.world.events)) seen.push(t.stepId);
	}
	return seen;
}

describe('Tutorial', () => {
	it('can be completed start to finish with normal inputs', () => {
		const t = new Tutorial(3);
		const seen = playThrough(t);
		expect(t.finished).toBe(true);
		expect(seen).toEqual([
			'walk', 'run', 'weapon', 'attack', 'combo', 'dash', 'hunt',
			'synergy', 'swap', 'zone', 'duel', 'loot', 'build', 'done'
		]);
	});

	it('never lets the player die', () => {
		const t = new Tutorial(5);
		playThrough(t);
		expect(t.me.alive).toBe(true);
		expect(t.world.over).toBe(false);
	});

	it('switches attack style in the weapon-swap step', () => {
		const t = new Tutorial(8);
		while (!t.finished && t.stepId !== 'swap') {
			step(t.world, new Map([[t.playerId, autopilot(t)]]));
			t.afterStep(t.world.events);
		}
		const before = t.me.build.attack;
		expect(t.me.offer?.every((id) => WEAPON_IDS.includes(id))).toBe(true);
		step(t.world, new Map([[t.playerId, [{ type: 'draft', index: 0 }]]]));
		t.afterStep(t.world.events);
		expect(t.me.build.attack).not.toBe(before);
		expect(t.stepId).toBe('zone');
	});

	it('skip moves on even when the goal is not met', () => {
		const t = new Tutorial(1);
		t.skip();
		expect(t.stepId).toBe('run');
	});

	it('skipping every step still ends cleanly with a weapon and no stray offer', () => {
		const t = new Tutorial(2);
		while (!t.finished) {
			t.skip();
			step(t.world, new Map());
			t.afterStep(t.world.events);
		}
		expect(t.me.build.weapon).not.toBeNull();
		expect(t.me.offer).toBeNull();
		expect(t.world.monsters).toHaveLength(0);
		expect(t.world.fighters.filter((f) => f.alive)).toHaveLength(1);
	});
});
