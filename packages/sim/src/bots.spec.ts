import { describe, expect, it } from 'vitest';
import { botCommands, zoneEnterRadius, zoneExitRadius } from './bot';
import { isOfferable, PHASE_STARTS } from './draft';
import { getItem, MAX_SKILLS, WEAPON_IDS } from './items';
import { spawnMonster } from './monsters';
import { clearSpot } from './obstacles';
import type { Fighter, World } from './types';
import { applyCommand, createWorld, equip, spawnFighter, step } from './world';

function botWorld() {
	const { world } = createWorld({ seed: 5, fighters: 0, sandbox: true });
	const bot = spawnFighter(world, { name: 'b', color: '#fff', pos: { x: 0, y: 0 }, bot: true });
	bot.offer = null;
	bot.pendingDrafts = 0;
	equip(world, bot, 'greatsword');
	bot.bot!.risk = 0;
	return { world, bot };
}

function think(world: World, f: Fighter) {
	f.bot!.thinkTimer = 0;
	botCommands(world, f);
	return f.bot!;
}

describe('bot zone discipline', () => {
	// A free spot so clearSpot leaves the zone centre where it is.
	const C = clearSpot({ x: 60, y: 0 }, 5);
	const R = 30;
	const at = (d: number) => ({ x: C.x + d, y: C.y });

	function setup() {
		const { world, bot } = botWorld();
		const safe = { center: C, radius: R };
		world.zone.current = safe;
		world.zone.to = safe;
		world.zone.shrinking = false;
		world.zone.timer = 100;
		return { world, bot };
	}

	it('ignores monsters outside the safe margin and hunts ones inside', () => {
		const { world, bot } = setup();
		bot.pos = at(zoneExitRadius({ center: C, radius: R }) - 3);
		const outside = spawnMonster(world, 1, at(R - 1));
		expect(think(world, bot).targetId).not.toBe(outside.id);
		const inside = spawnMonster(world, 1, { x: C.x + 15, y: C.y + 3 });
		const b = think(world, bot);
		expect(b.mode).toBe('farm');
		expect(b.targetId).toBe(inside.id);
	});

	it('ignores loot outside the safe margin', () => {
		const { world, bot } = setup();
		bot.pos = at(zoneExitRadius({ center: C, radius: R }) - 3);
		world.pickups.push({ id: 900, pos: at(R - 1), itemId: 'skill_fireball' });
		expect(think(world, bot).mode).not.toBe('loot');
	});

	it('stays in zone mode until comfortably inside (hysteresis)', () => {
		const { world, bot } = setup();
		const safe = { center: C, radius: R };
		const enter = zoneEnterRadius(safe);
		const exit = zoneExitRadius(safe);
		expect(exit).toBeLessThan(enter);
		spawnMonster(world, 1, { x: C.x + 15, y: C.y + 3 });

		bot.pos = at(enter + 1);
		expect(think(world, bot).mode).toBe('zone');
		bot.pos = at((enter + exit) / 2);
		expect(think(world, bot).mode).toBe('zone');
		bot.pos = at(exit - 1);
		expect(think(world, bot).mode).toBe('farm');
		// Back in the band from a non-zone mode: no zone run yet.
		bot.pos = at((enter + exit) / 2);
		expect(think(world, bot).mode).not.toBe('zone');
	});

	it('uses the target circle while the zone is shrinking', () => {
		const { world, bot } = setup();
		world.zone.current = { center: C, radius: 80 };
		world.zone.to = { center: C, radius: R };
		world.zone.shrinking = true;
		bot.pos = at(R + 5);
		expect(think(world, bot).mode).toBe('zone');
	});
});

describe('offers vs items gained outside the draft', () => {
	it('replaces offer entries a pickup made un-draftable, without spending rerolls', () => {
		const { world, bot } = botWorld();
		bot.offer = ['skill_fireball', 'ember_ring', 'serrated'];
		bot.pendingDrafts = 1;
		const rerolls = bot.rerolls;
		equip(world, bot, 'skill_fireball');
		expect(bot.offer).toHaveLength(3);
		expect(bot.offer).toContain('ember_ring');
		expect(bot.offer).toContain('serrated');
		expect(bot.offer).not.toContain('skill_fireball');
		for (const id of bot.offer!) expect(isOfferable(getItem(id), bot.items)).toBe(true);
		expect(bot.rerolls).toBe(rerolls);
	});

	it('rerolls every skill once the skill cap is reached', () => {
		const { world, bot } = botWorld();
		const skills = ['skill_whirl', 'skill_volley', 'skill_thorns', 'skill_pulse'];
		for (const s of skills.slice(0, MAX_SKILLS - 1)) equip(world, bot, s);
		bot.offer = ['skill_fireball', 'skill_flash', skills[MAX_SKILLS]];
		bot.pendingDrafts = 1;
		equip(world, bot, skills[MAX_SKILLS - 1]);
		expect(bot.offer).toHaveLength(3);
		for (const id of bot.offer!) expect(getItem(id).kind).not.toBe('skill');
	});

	it('a bot still drafts after picking up an offered skill from the ground', () => {
		const { world, bot } = botWorld();
		bot.offer = ['skill_fireball', 'ember_ring', 'serrated'];
		bot.pendingDrafts = 1;
		world.pickups.push({ id: 900, pos: { ...bot.pos }, itemId: 'skill_fireball' });
		for (let i = 0; i < 40; i++) step(world);
		expect(bot.items).toContain('skill_fireball');
		expect(bot.pendingDrafts).toBe(0);
	});

	it('the bot never picks a non-offerable entry', () => {
		const { world, bot } = botWorld();
		equip(world, bot, 'skill_fireball');
		// Force a stale offer past revalidation to check the bot's own guard.
		bot.offer = ['skill_fireball', 'ember_ring', 'serrated'];
		bot.pendingDrafts = 1;
		bot.rerolls = 0;
		for (let i = 0; i < 20; i++) step(world);
		expect(bot.pendingDrafts).toBe(0);
		expect(bot.items.filter((x) => x === 'skill_fireball')).toHaveLength(1);
	});
});

describe('phase change', () => {
	it('keeps the opening weapon choice for a fighter who has not picked yet', () => {
		const { world, playerId } = createWorld({ seed: 4, fighters: 4, playerName: 'p' });
		const p = world.fighters.find((f) => f.id === playerId)!;
		while (world.time < PHASE_STARTS[2] + 0.1 && !world.over && p.alive) step(world);
		expect(p.build.weapon).toBeNull();
		expect(p.offer).toEqual(WEAPON_IDS);
		applyCommand(world, p, { type: 'draft', index: 0 });
		expect(p.build.weapon).not.toBeNull();
	});

	it('still rerolls banked offers of armed fighters into the new phase', () => {
		const { world, playerId } = createWorld({ seed: 4, fighters: 4, playerName: 'p' });
		const p = world.fighters.find((f) => f.id === playerId)!;
		applyCommand(world, p, { type: 'draft', index: 0 });
		const banked = ['ember_ring', 'serrated', 'stout_heart'];
		p.offer = [...banked];
		p.pendingDrafts = 1;
		while (world.phase < 2 && p.alive) step(world);
		expect(p.offer).not.toEqual(banked);
	});
});
