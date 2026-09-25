export const TAGS = ['fire', 'bleed', 'speed', 'melee', 'ranged', 'guard'] as const;
export type Tag = (typeof TAGS)[number];

/** Tag counts at which a synergy tier switches on. Power spikes live at these thresholds. */
export const SYNERGY_THRESHOLDS = [3, 5] as const;
export type SynergyTier = 0 | 1 | 2;

export interface TagInfo {
	label: string;
	icon: string;
	color: string;
	tiers: [string, string];
}

export const TAG_INFO: Record<Tag, TagInfo> = {
	fire: {
		label: '화염',
		icon: '🔥',
		color: '#ff7a33',
		tiers: ['공격이 화상을 입힘 (3초, 초당 공격력 30%)', '화상 피해 2배 · 화상 중 처치 시 폭발']
	},
	bleed: {
		label: '출혈',
		icon: '🩸',
		color: '#e0344f',
		tiers: ['공격마다 출혈 중첩 (최대 8)', '출혈 최대 16중첩 · 출혈 대상에게 피해 +20%']
	},
	speed: {
		label: '신속',
		icon: '💨',
		color: '#3ad6c5',
		tiers: ['대시 재사용 대기시간 -40%', '대시 후 2초간 공격 속도 +40%']
	},
	melee: {
		label: '근접',
		icon: '⚔️',
		color: '#e8b93f',
		tiers: ['(근접 무기) 3타가 360° 베기', '(근접 무기) 모든 공격 360° · 넉백']
	},
	ranged: {
		label: '원거리',
		icon: '🏹',
		color: '#7fb2ff',
		tiers: ['(원거리 무기) 투사체가 적 2명 관통', '(원거리 무기) 투사체 +2발 (부채꼴)']
	},
	guard: {
		label: '수호',
		icon: '🛡️',
		color: '#a8b4c4',
		tiers: ['최대 체력 15% 보호막 (4초간 피격 없으면 재생)', '받은 피해 15% 반사']
	}
};

export function synergyTier(count: number): SynergyTier {
	if (count >= SYNERGY_THRESHOLDS[1]) return 2;
	if (count >= SYNERGY_THRESHOLDS[0]) return 1;
	return 0;
}

export function emptyTagCounts(): Record<Tag, number> {
	return { fire: 0, bleed: 0, speed: 0, melee: 0, ranged: 0, guard: 0 };
}
