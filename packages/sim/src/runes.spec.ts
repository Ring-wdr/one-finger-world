import { describe, expect, it } from 'vitest';
import { summarizeBuild } from './build';
import { ITEMS } from './items';
import { getRune, RUNE_SLOTS, RUNES, runeBudget, sanitizeRunes } from './runes';
import { modBudget } from './stats';
import { TAGS } from './tags';
import { createWorld, START_REROLLS } from './world';

describe('runes', () => {
	it('each rune is a small nudge: about a third of a common item', () => {
		for (const r of RUNES) {
			const b = runeBudget(r);
			expect(b, r.id).toBeGreaterThanOrEqual(0.3);
			expect(b, r.id).toBeLessThanOrEqual(0.45);
			for (const mod of r.mods) expect(mod.value, r.id).toBeGreaterThan(0);
		}
	});

	it('a full loadout is worth at most ~one common stat item', () => {
		const commons = ITEMS.filter((i) => i.rarity === 'common' && i.kind === 'stat').map((i) => modBudget(i.mods).net);
		const avgCommon = commons.reduce((a, b) => a + b, 0) / commons.length;
		const best = RUNE_SLOTS.map((slot) => Math.max(...RUNES.filter((r) => r.slot === slot).map(runeBudget)));
		const total = best.reduce((a, b) => a + b, 0);
		expect(total).toBeLessThanOrEqual(avgCommon * 1.3);
	});

	it('every slot has at least three choices and ids are unique', () => {
		for (const slot of RUNE_SLOTS) expect(RUNES.filter((r) => r.slot === slot).length).toBeGreaterThanOrEqual(3);
		expect(new Set(RUNES.map((r) => r.id)).size).toBe(RUNES.length);
	});

	it('sanitize keeps one rune per slot and drops unknown ids', () => {
		expect(sanitizeRunes(['rune_power', 'rune_haste', 'nope', 'rune_armor'])).toEqual(['rune_power', 'rune_armor']);
	});

	it('runes add stats but never tags', () => {
		const plain = summarizeBuild(['greatsword']);
		const withRunes = summarizeBuild(['greatsword'], ['rune_power', 'rune_vital']);
		expect(withRunes.stats.damage).toBeGreaterThan(plain.stats.damage);
		expect(withRunes.stats.maxHp).toBe(plain.stats.maxHp + 10);
		for (const t of TAGS) expect(withRunes.tagCounts[t]).toBe(plain.tagCounts[t]);
	});

	it('only the player gets the loadout; the insight rune adds a reroll', () => {
		const { world, playerId } = createWorld({
			seed: 7,
			fighters: 6,
			playerName: 'me',
			playerRunes: ['rune_vital', 'rune_insight', 'rune_speed']
		});
		const me = world.fighters.find((f) => f.id === playerId)!;
		expect(me.runes).toEqual(['rune_vital', 'rune_insight']);
		expect(me.maxHp).toBe(110);
		expect(me.hp).toBe(110);
		expect(me.rerolls).toBe(START_REROLLS + getRune('rune_insight')!.rerolls!);
		for (const bot of world.fighters.filter((f) => f.bot)) expect(bot.runes).toEqual([]);
	});

	it('runes do not change the rng stream (same seed, same bots)', () => {
		const a = createWorld({ seed: 11, fighters: 8, playerName: 'me' }).world;
		const b = createWorld({ seed: 11, fighters: 8, playerName: 'me', playerRunes: ['rune_power'] }).world;
		expect(b.fighters.map((f) => f.pos)).toEqual(a.fighters.map((f) => f.pos));
		expect(b.monsters.length).toBe(a.monsters.length);
	});
});
