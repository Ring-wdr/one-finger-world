import { describe, expect, it } from 'vitest';
import { getRune, RUNES } from '@ofa/sim';
import { INPUT_THRESHOLD_STORAGE_KEY } from '../input/inputThresholdOptions';
import { buyRune, defaultProfile, equippedRunes, grantReward, parseProfile, toggleRune, type Profile } from './profile';
import { scoreMatch } from './rewards';
import { defaultSettings, loadSettings, parseSettings, sfxGain } from './settings';

function memoryStorage(init: Record<string, string> = {}): Storage {
	const data = new Map(Object.entries(init));
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => data.get(k) ?? null,
		key: (i) => [...data.keys()][i] ?? null,
		removeItem: (k) => void data.delete(k),
		setItem: (k, v) => void data.set(k, v)
	};
}

describe('match rewards', () => {
	const base = { fighters: 12, kills: 0, level: 1, time: 0 };

	it('placement dominates: a win pays more than any mid finish with kills', () => {
		const win = scoreMatch({ ...base, placement: 1, kills: 1, level: 8, time: 300 });
		const mid = scoreMatch({ ...base, placement: 6, kills: 3, level: 10, time: 200 });
		expect(win.coins).toBeGreaterThan(mid.coins);
	});

	it('is monotonic in placement, kills and level', () => {
		const at = (o: Partial<typeof base & { placement: number }>) => scoreMatch({ ...base, placement: 6, ...o }).score;
		expect(at({ placement: 5 })).toBeGreaterThan(at({ placement: 6 }));
		expect(at({ kills: 2 })).toBeGreaterThan(at({ kills: 1 }));
		expect(at({ level: 5 })).toBeGreaterThan(at({ level: 4 }));
	});

	it('caps survival points so hiding does not beat fighting', () => {
		const hide = scoreMatch({ ...base, placement: 8, time: 10_000 });
		const fight = scoreMatch({ ...base, placement: 8, time: 300, kills: 3 });
		expect(fight.score).toBeGreaterThan(hide.score);
	});

	it('an early death still pays a little; a typical good game buys a rune in ~2 matches', () => {
		expect(scoreMatch({ ...base, placement: 12, level: 2, time: 40 }).coins).toBeGreaterThan(0);
		const good = scoreMatch({ ...base, placement: 3, kills: 2, level: 10, time: 260 }).coins;
		const cheapest = Math.min(...RUNES.map((r) => r.cost));
		expect(good * 2).toBeGreaterThanOrEqual(cheapest);
		expect(good).toBeLessThan(cheapest);
	});

	it('breakdown adds up to the score', () => {
		const r = scoreMatch({ ...base, placement: 2, kills: 4, level: 9, time: 280 });
		expect(r.breakdown.reduce((a, b) => a + b.points, 0)).toBe(r.score);
	});
});

describe('profile & shop', () => {
	const rich = (): Profile => ({ ...defaultProfile(), coins: 1000 });

	it('buying spends coins, owns the rune and fills an empty slot', () => {
		const p = buyRune(rich(), 'rune_power') as Profile;
		expect(p.coins).toBe(1000 - getRune('rune_power')!.cost);
		expect(p.owned).toEqual(['rune_power']);
		expect(p.equipped.offense).toBe('rune_power');
	});

	it('a second rune for a filled slot is owned but not auto-equipped', () => {
		const p = buyRune(buyRune(rich(), 'rune_power') as Profile, 'rune_haste') as Profile;
		expect(p.equipped.offense).toBe('rune_power');
		expect(toggleRune(p, 'rune_haste').equipped.offense).toBe('rune_haste');
	});

	it('refuses unknown, owned and unaffordable runes', () => {
		expect(buyRune(rich(), 'nope')).toBe('unknown');
		expect(buyRune(buyRune(rich(), 'rune_power') as Profile, 'rune_power')).toBe('owned');
		expect(buyRune(defaultProfile(), 'rune_power')).toBe('coins');
	});

	it('toggle unequips, and ignores runes you do not own', () => {
		const p = buyRune(rich(), 'rune_vital') as Profile;
		expect(toggleRune(p, 'rune_vital').equipped.defense).toBeNull();
		expect(toggleRune(p, 'rune_armor')).toBe(p);
	});

	it('equippedRunes lists one per filled slot', () => {
		let p = buyRune(rich(), 'rune_power') as Profile;
		p = buyRune(p, 'rune_speed') as Profile;
		expect(equippedRunes(p)).toEqual(['rune_power', 'rune_speed']);
	});

	it('parse drops tampered data: unknown runes, unowned or wrong-slot equips, bad numbers', () => {
		const p = parseProfile({
			coins: -50,
			owned: ['rune_power', 'fake', 'rune_power'],
			equipped: { offense: 'rune_power', defense: 'rune_armor', utility: 'rune_power' },
			best: 'x'
		});
		expect(p.coins).toBe(0);
		expect(p.owned).toEqual(['rune_power']);
		expect(p.equipped).toEqual({ offense: 'rune_power', defense: null, utility: null });
		expect(p.best).toBe(0);
	});

	it('grantReward adds coins, tracks best score and match count', () => {
		const p = grantReward(grantReward(defaultProfile(), 50, 500), 20, 200);
		expect(p).toMatchObject({ coins: 70, best: 500, matches: 2 });
	});
});

describe('settings', () => {
	it('clamps volume and input thresholds', () => {
		const s = parseSettings({ volume: 3, muted: 'yes', input: { tapMs: 9999 } });
		expect(s.volume).toBe(1);
		expect(s.muted).toBe(false);
		expect(s.input.tapMs).toBe(280);
	});

	it('mute silences sound effects', () => {
		expect(sfxGain({ ...defaultSettings(), volume: 0.5 })).toBe(0.5);
		expect(sfxGain({ ...defaultSettings(), volume: 0.5, muted: true })).toBe(0);
	});

	it('carries over the sensitivity saved by the old start screen', () => {
		const storage = memoryStorage({
			[INPUT_THRESHOLD_STORAGE_KEY]: JSON.stringify({ tapMs: 240, dragStartPx: 20, fastDragPxPerMs: 0.7 })
		});
		expect(loadSettings(storage).input).toEqual({ tapMs: 240, dragStartPx: 20, fastDragPxPerMs: 0.7 });
	});

	it('falls back to defaults on broken storage', () => {
		expect(loadSettings(memoryStorage({ 'ofa.settings.v1': '{oops' }))).toEqual(defaultSettings());
	});
});
