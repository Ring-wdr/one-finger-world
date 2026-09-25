import { getItem, type AttackMode, type SkillId } from './items';
import { deriveStats, type DerivedStats, type StatConversion, type StatMod } from './stats';
import { emptyTagCounts, synergyTier, TAGS, type SynergyTier, type Tag } from './tags';

export interface BuildSummary {
	/** Tag counts after bridges. */
	tagCounts: Record<Tag, number>;
	tiers: Record<Tag, SynergyTier>;
	stats: DerivedStats;
	skills: SkillId[];
	weapon: string | null;
	/** Without a weapon you punch (melee). */
	attack: AttackMode;
	projectile: 'arrow' | 'fireball';
}

export function summarizeBuild(itemIds: readonly string[]): BuildSummary {
	const base = emptyTagCounts();
	const mods: StatMod[] = [];
	const conversions: StatConversion[] = [];
	const skills: SkillId[] = [];
	const bridges: { from: Tag; to: Tag }[] = [];
	let weapon: string | null = null;

	for (const id of itemIds) {
		const item = getItem(id);
		for (const tag of item.tags) base[tag] += 1;
		mods.push(...item.mods);
		if (item.kind === 'weapon') weapon = id;
		if (item.skill && !skills.includes(item.skill)) skills.push(item.skill);
		if (item.bridge) {
			conversions.push(item.bridge.convert);
			bridges.push(item.bridge);
		}
	}

	// Bridges read base counts, so two bridges can't loop counts into each other.
	const tagCounts = { ...base };
	for (const b of bridges) tagCounts[b.to] += Math.floor(base[b.from] / 2);

	const tiers = Object.fromEntries(TAGS.map((t) => [t, synergyTier(tagCounts[t])])) as Record<
		Tag,
		SynergyTier
	>;

	const w = weapon ? getItem(weapon) : null;
	return {
		tagCounts,
		tiers,
		stats: deriveStats(mods, conversions),
		skills,
		weapon,
		attack: w?.attack ?? 'melee',
		projectile: w?.projectile ?? 'arrow'
	};
}

/** True when basic attacks are projectiles instead of a melee swing. The weapon decides. */
export function usesRangedBasic(build: BuildSummary) {
	return build.attack === 'ranged';
}
