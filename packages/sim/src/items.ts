import type { StatConversion, StatMod } from './stats';
import type { Tag } from './tags';

export type Rarity = 'common' | 'rare' | 'legendary';
/**
 * weapon = decides the basic attack (one equipped, swapping replaces it),
 * stat = early-phase resource, skill = mid-phase, bridge = late-phase synergy completer.
 */
export type ItemKind = 'weapon' | 'stat' | 'skill' | 'bridge';
export type AttackMode = 'melee' | 'ranged';

export type SkillId = 'fireball' | 'whirl' | 'volley' | 'thornShell' | 'bloodPulse' | 'flashStep';

export interface SkillDef {
	name: string;
	/** Seconds; 0 = passive. */
	cooldown: number;
	desc: string;
}

export const SKILLS: Record<SkillId, SkillDef> = {
	fireball: { name: '화염구', cooldown: 2.8, desc: '가장 가까운 적에게 폭발하는 화염구 (160%, 항상 화상)' },
	whirl: { name: '회전베기', cooldown: 4, desc: '주변 3.5m 회전 공격 (120%, 항상 출혈)' },
	volley: { name: '연사', cooldown: 3, desc: '화살 3발 부채꼴 발사 (각 70%)' },
	thornShell: { name: '가시 껍질', cooldown: 7, desc: '최대 체력 20% 보호막 획득' },
	bloodPulse: { name: '혈류 파동', cooldown: 5, desc: '주변 7m 출혈 대상의 중첩을 터뜨려 즉시 피해' },
	flashStep: { name: '섬광 발걸음', cooldown: 0, desc: '대시로 지나간 적에게 150% 피해 (패시브)' }
};

export const MAX_SKILLS = 3;

export interface Bridge {
	from: Tag;
	to: Tag;
	convert: StatConversion;
}

export interface ItemDef {
	id: string;
	name: string;
	rarity: Rarity;
	kind: ItemKind;
	tags: Tag[];
	mods: StatMod[];
	skill?: SkillId;
	bridge?: Bridge;
	/** Weapons only: basic attack style and projectile look. */
	attack?: AttackMode;
	projectile?: 'arrow' | 'fireball';
}

const m = (stat: StatMod['stat'], value: number): StatMod => ({ stat, value });

export const ITEMS: ItemDef[] = [
	// ── Weapons: picked at match start, swappable via draft cards. Ranged pays in HP or speed.
	{ id: 'greatsword', name: '대검', rarity: 'common', kind: 'weapon', attack: 'melee', tags: ['melee'], mods: [m('reach', 0.1), m('speed', -0.04)] },
	{ id: 'twin_daggers', name: '쌍단검', rarity: 'common', kind: 'weapon', attack: 'melee', tags: ['bleed', 'speed'], mods: [m('haste', 0.2), m('reach', -0.2)] },
	{ id: 'hunting_bow', name: '사냥활', rarity: 'common', kind: 'weapon', attack: 'ranged', projectile: 'arrow', tags: ['ranged'], mods: [m('haste', 0.1), m('maxHp', -10)] },
	{ id: 'fire_staff', name: '화염 지팡이', rarity: 'common', kind: 'weapon', attack: 'ranged', projectile: 'fireball', tags: ['fire'], mods: [m('power', 0.1), m('haste', -0.15)] },

	// ── Commons: one tag, ~1 budget point. Stronger ones already carry a cost.
	{ id: 'ember_ring', name: '불씨 반지', rarity: 'common', kind: 'stat', tags: ['fire'], mods: [m('power', 0.1)] },
	{ id: 'cinder_gloves', name: '잿불 장갑', rarity: 'common', kind: 'stat', tags: ['fire'], mods: [m('power', 0.16), m('maxHp', -12)] },
	{ id: 'serrated', name: '톱니 단검', rarity: 'common', kind: 'stat', tags: ['bleed'], mods: [m('crit', 0.06)] },
	{ id: 'blood_charm', name: '피의 부적', rarity: 'common', kind: 'stat', tags: ['bleed'], mods: [m('lifesteal', 0.05), m('regen', -0.3)] },
	{ id: 'light_boots', name: '가벼운 장화', rarity: 'common', kind: 'stat', tags: ['speed'], mods: [m('speed', 0.1)] },
	{ id: 'wind_cloak', name: '바람 망토', rarity: 'common', kind: 'stat', tags: ['speed'], mods: [m('haste', 0.18), m('armor', -4)] },
	{ id: 'heavy_gauntlet', name: '묵직한 건틀릿', rarity: 'common', kind: 'stat', tags: ['melee'], mods: [m('power', 0.15), m('speed', -0.06)] },
	{ id: 'broad_blade', name: '넓은 칼날', rarity: 'common', kind: 'stat', tags: ['melee'], mods: [m('reach', 0.15)] },
	{ id: 'scope', name: '조준경', rarity: 'common', kind: 'stat', tags: ['ranged'], mods: [m('reach', 0.25), m('speed', -0.08)] },
	{ id: 'light_string', name: '가벼운 시위', rarity: 'common', kind: 'stat', tags: ['ranged'], mods: [m('haste', 0.12)] },
	{ id: 'iron_plate', name: '철판', rarity: 'common', kind: 'stat', tags: ['guard'], mods: [m('armor', 12), m('speed', -0.05)] },
	{ id: 'stout_heart', name: '튼튼한 심장', rarity: 'common', kind: 'stat', tags: ['guard'], mods: [m('maxHp', 25)] },

	// ── Rares: two tags (faster threshold progress), always with a trade-off.
	{ id: 'berserker_belt', name: '광전사 허리띠', rarity: 'rare', kind: 'stat', tags: ['melee', 'bleed'], mods: [m('power', 0.18), m('lifesteal', 0.03), m('maxHp', -20)] },
	{ id: 'flame_quiver', name: '불꽃 화살통', rarity: 'rare', kind: 'stat', tags: ['fire', 'ranged'], mods: [m('haste', 0.2), m('reach', 0.1), m('armor', -5)] },
	{ id: 'charging_plate', name: '돌격 갑주', rarity: 'rare', kind: 'stat', tags: ['speed', 'guard'], mods: [m('armor', 10), m('speed', 0.1), m('haste', -0.1)] },
	{ id: 'burning_edge', name: '달군 칼날', rarity: 'rare', kind: 'stat', tags: ['fire', 'melee'], mods: [m('power', 0.18), m('crit', 0.04), m('regen', -0.5)] },
	{ id: 'hunter_claw', name: '사냥꾼의 발톱', rarity: 'rare', kind: 'stat', tags: ['bleed', 'ranged'], mods: [m('crit', 0.1), m('reach', 0.12), m('maxHp', -15)] },
	{ id: 'razor_wind', name: '칼바람', rarity: 'rare', kind: 'stat', tags: ['speed', 'bleed'], mods: [m('speed', 0.12), m('crit', 0.06), m('armor', -6)] },
	{ id: 'shield_bash', name: '방패 강타', rarity: 'rare', kind: 'stat', tags: ['guard', 'melee'], mods: [m('maxHp', 30), m('power', 0.1), m('haste', -0.1)] },
	{ id: 'phoenix_heart', name: '불사조 심장', rarity: 'rare', kind: 'stat', tags: ['guard', 'fire'], mods: [m('regen', 1.2), m('armor', 6), m('power', -0.06)] },
	{ id: 'quick_draw', name: '속사', rarity: 'rare', kind: 'stat', tags: ['speed', 'ranged'], mods: [m('haste', 0.15), m('speed', 0.08), m('maxHp', -15)] },

	// ── Skills: auto-cast, limited slots, small stat cost.
	{ id: 'skill_fireball', name: '화염구 두루마리', rarity: 'rare', kind: 'skill', tags: ['fire', 'ranged'], skill: 'fireball', mods: [m('haste', -0.05)] },
	{ id: 'skill_whirl', name: '회전베기 교본', rarity: 'rare', kind: 'skill', tags: ['melee', 'bleed'], skill: 'whirl', mods: [m('speed', -0.04)] },
	{ id: 'skill_volley', name: '연사 장치', rarity: 'common', kind: 'skill', tags: ['ranged'], skill: 'volley', mods: [m('power', -0.04)] },
	{ id: 'skill_thorns', name: '가시 껍질', rarity: 'common', kind: 'skill', tags: ['guard'], skill: 'thornShell', mods: [m('speed', -0.04)] },
	{ id: 'skill_pulse', name: '혈류 파동', rarity: 'common', kind: 'skill', tags: ['bleed'], skill: 'bloodPulse', mods: [m('maxHp', -10)] },
	{ id: 'skill_flash', name: '섬광 발걸음', rarity: 'common', kind: 'skill', tags: ['speed'], skill: 'flashStep', mods: [m('armor', -4)] },

	// ── Legendaries: bridges. Not bigger numbers; they make one tag also feed another.
	{
		id: 'purgatory', name: '연옥의 피', rarity: 'legendary', kind: 'bridge', tags: ['bleed', 'fire'],
		mods: [m('lifesteal', 0.04), m('maxHp', -15)],
		bridge: { from: 'bleed', to: 'fire', convert: { from: 'lifesteal', to: 'power', ratio: 3 } }
	},
	{
		id: 'storm_arrow', name: '폭풍 화살', rarity: 'legendary', kind: 'bridge', tags: ['speed', 'ranged'],
		mods: [m('speed', 0.08), m('armor', -5)],
		bridge: { from: 'speed', to: 'ranged', convert: { from: 'speed', to: 'reach', ratio: 1.2 } }
	},
	{
		id: 'bastion', name: '성채의 돌격', rarity: 'legendary', kind: 'bridge', tags: ['guard', 'melee'],
		mods: [m('armor', 8), m('speed', -0.06)],
		bridge: { from: 'guard', to: 'melee', convert: { from: 'armor', to: 'power', ratio: 0.012 } }
	},
	{
		id: 'flaming_steps', name: '불꽃 발자국', rarity: 'legendary', kind: 'bridge', tags: ['speed', 'fire'],
		mods: [m('speed', 0.06), m('maxHp', -15)],
		bridge: { from: 'speed', to: 'fire', convert: { from: 'speed', to: 'haste', ratio: 1 } }
	},
	{
		id: 'crimson_mark', name: '진홍 표식', rarity: 'legendary', kind: 'bridge', tags: ['ranged', 'bleed'],
		mods: [m('reach', 0.1), m('regen', -0.6)],
		bridge: { from: 'ranged', to: 'bleed', convert: { from: 'reach', to: 'crit', ratio: 0.4 } }
	},
	{
		id: 'iron_thorns', name: '강철 가시', rarity: 'legendary', kind: 'bridge', tags: ['guard', 'bleed'],
		mods: [m('armor', 6), m('power', -0.06)],
		bridge: { from: 'guard', to: 'bleed', convert: { from: 'armor', to: 'lifesteal', ratio: 0.004 } }
	}
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

export const WEAPON_IDS = ITEMS.filter((i) => i.kind === 'weapon').map((i) => i.id);

export function getItem(id: string): ItemDef {
	const item = ITEM_BY_ID[id];
	if (!item) throw new Error(`Unknown item: ${id}`);
	return item;
}
