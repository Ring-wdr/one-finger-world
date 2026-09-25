export type StatKey =
	| 'maxHp'
	| 'power'
	| 'haste'
	| 'speed'
	| 'reach'
	| 'armor'
	| 'crit'
	| 'lifesteal'
	| 'regen'
	| 'cdr';

export interface StatMod {
	stat: StatKey;
	value: number;
}

export interface StatInfo {
	label: string;
	/** Where diminishing returns begin for the summed bonus. */
	knee: number;
	/** Display as percentage. */
	percent: boolean;
	/** Budget points per unit of value. One common item is worth ~1 point. */
	weight: number;
}

export const STAT_INFO: Record<StatKey, StatInfo> = {
	maxHp: { label: '최대 체력', knee: 120, percent: false, weight: 1 / 25 },
	power: { label: '피해량', knee: 0.6, percent: true, weight: 10 },
	haste: { label: '공격 속도', knee: 0.6, percent: true, weight: 8 },
	speed: { label: '이동 속도', knee: 0.35, percent: true, weight: 10 },
	reach: { label: '사거리', knee: 0.5, percent: true, weight: 7 },
	armor: { label: '방어력', knee: 30, percent: false, weight: 1 / 8 },
	crit: { label: '치명타', knee: 0.3, percent: true, weight: 16 },
	lifesteal: { label: '흡혈', knee: 0.12, percent: true, weight: 25 },
	regen: { label: '체력 재생', knee: 3, percent: false, weight: 1 },
	cdr: { label: '재사용 감소', knee: 0.3, percent: true, weight: 10 }
};

export const STAT_KEYS = Object.keys(STAT_INFO) as StatKey[];

export const BASE = {
	maxHp: 100,
	damage: 10,
	attackRate: 1.4,
	moveSpeed: 6,
	range: 2.4,
	crit: 0.05,
	regen: 0.4,
	armorScale: 40
} as const;

/**
 * Linear up to `knee`, logarithmic after. Stacking one stat keeps paying off,
 * but noticeably less than branching into another axis.
 */
export function softCap(raw: number, knee: number): number {
	if (raw <= knee) return raw;
	return knee + knee * Math.log1p((raw - knee) / knee);
}

export interface DerivedStats {
	maxHp: number;
	damage: number;
	attackRate: number;
	moveSpeed: number;
	range: number;
	/** Multiplier on incoming damage (armor). */
	damageTaken: number;
	crit: number;
	lifesteal: number;
	regen: number;
	cdr: number;
}

export interface StatConversion {
	from: StatKey;
	to: StatKey;
	ratio: number;
}

export function sumMods(mods: readonly StatMod[]): Record<StatKey, number> {
	const raw = Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Record<StatKey, number>;
	for (const m of mods) raw[m.stat] += m.value;
	return raw;
}

export function deriveStats(
	mods: readonly StatMod[],
	conversions: readonly StatConversion[] = []
): DerivedStats {
	const raw = sumMods(mods);
	// Conversions read the pre-conversion totals so bridges never chain into each other.
	const snapshot = { ...raw };
	for (const c of conversions) raw[c.to] += Math.max(0, snapshot[c.from]) * c.ratio;

	const b = (k: StatKey) => softCap(raw[k], STAT_INFO[k].knee);
	const armor = b('armor');

	return {
		maxHp: Math.max(20, BASE.maxHp + b('maxHp')),
		damage: BASE.damage * Math.max(0.2, 1 + b('power')),
		attackRate: BASE.attackRate * Math.max(0.3, 1 + b('haste')),
		moveSpeed: BASE.moveSpeed * Math.max(0.4, 1 + b('speed')),
		range: BASE.range * Math.max(0.5, 1 + b('reach')),
		damageTaken:
			armor >= 0
				? BASE.armorScale / (BASE.armorScale + armor)
				: (BASE.armorScale - armor) / BASE.armorScale,
		crit: clamp(BASE.crit + b('crit'), 0, 0.75),
		lifesteal: clamp(b('lifesteal'), 0, 0.5),
		regen: Math.max(0, BASE.regen + b('regen')),
		cdr: clamp(b('cdr'), 0, 0.6)
	};
}

export function modBudget(mods: readonly StatMod[]) {
	let positive = 0;
	let negative = 0;
	for (const m of mods) {
		const v = m.value * STAT_INFO[m.stat].weight;
		if (v >= 0) positive += v;
		else negative += -v;
	}
	return { positive, negative, net: positive - negative };
}

export function clamp(v: number, min: number, max: number) {
	return v < min ? min : v > max ? max : v;
}
