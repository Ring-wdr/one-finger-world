import { STAT_INFO, type StatMod } from './stats';

/**
 * Pre-match runes (bought in the shop, one per slot). Sized like League's rune shards:
 * noticeable, never decisive. One rune ≈ a third of a common item's budget, so a full
 * loadout is worth about one common item — and a match hands out ten or more.
 */
export type RuneSlot = 'offense' | 'defense' | 'utility';
export const RUNE_SLOTS: readonly RuneSlot[] = ['offense', 'defense', 'utility'];

export const RUNE_SLOT_INFO: Record<RuneSlot, { label: string; icon: string }> = {
	offense: { label: '공격', icon: '⚔' },
	defense: { label: '방어', icon: '🛡' },
	utility: { label: '유틸', icon: '✦' }
};

export interface RuneDef {
	id: string;
	name: string;
	slot: RuneSlot;
	mods: StatMod[];
	/** Extra rerolls at spawn (the one non-stat perk). */
	rerolls?: number;
	/** Shop price in coins. */
	cost: number;
}

/** Budget points a reroll is treated as worth (for the rune budget test). */
export const REROLL_BUDGET = 0.35;

const m = (stat: StatMod['stat'], value: number): StatMod => ({ stat, value });

export const RUNES: RuneDef[] = [
	{ id: 'rune_power', name: '맹공', slot: 'offense', mods: [m('power', 0.04)], cost: 150 },
	{ id: 'rune_haste', name: '속공', slot: 'offense', mods: [m('haste', 0.05)], cost: 150 },
	{ id: 'rune_crit', name: '예리함', slot: 'offense', mods: [m('crit', 0.025)], cost: 200 },
	{ id: 'rune_vital', name: '강인함', slot: 'defense', mods: [m('maxHp', 10)], cost: 150 },
	{ id: 'rune_armor', name: '철갑', slot: 'defense', mods: [m('armor', 3)], cost: 150 },
	{ id: 'rune_regen', name: '회복력', slot: 'defense', mods: [m('regen', 0.4)], cost: 200 },
	{ id: 'rune_speed', name: '경쾌', slot: 'utility', mods: [m('speed', 0.035)], cost: 150 },
	{ id: 'rune_cdr', name: '집중', slot: 'utility', mods: [m('cdr', 0.035)], cost: 200 },
	{ id: 'rune_leech', name: '갈증', slot: 'utility', mods: [m('lifesteal', 0.014)], cost: 200 },
	{ id: 'rune_insight', name: '통찰', slot: 'utility', mods: [], rerolls: 1, cost: 250 }
];

const BY_ID = new Map(RUNES.map((r) => [r.id, r]));

export function getRune(id: string): RuneDef | undefined {
	return BY_ID.get(id);
}

/** Budget points of one rune (stat weights + perks). */
export function runeBudget(r: RuneDef): number {
	let v = 0;
	for (const mod of r.mods) v += mod.value * STAT_INFO[mod.stat].weight;
	return v + (r.rerolls ?? 0) * REROLL_BUDGET;
}

/** Drops unknown ids and keeps the first rune per slot, so a tampered save can't stack runes. */
export function sanitizeRunes(ids: readonly string[]): string[] {
	const taken = new Set<RuneSlot>();
	const out: string[] = [];
	for (const id of ids) {
		const r = getRune(id);
		if (!r || taken.has(r.slot)) continue;
		taken.add(r.slot);
		out.push(id);
	}
	return out;
}

export function runeMods(ids: readonly string[]): StatMod[] {
	return ids.flatMap((id) => getRune(id)?.mods ?? []);
}

export function runeRerolls(ids: readonly string[]): number {
	return ids.reduce((n, id) => n + (getRune(id)?.rerolls ?? 0), 0);
}
