import { ITEMS, MAX_SKILLS, getItem, type ItemDef, type ItemKind, type Rarity } from './items';
import type { Rng } from './rng';
import { emptyTagCounts } from './tags';

export type MatchPhase = 1 | 2 | 3;

/** Resource phases: stats early, skills mid, synergy completers late. Ends line up with zone stages. */
export const PHASE_STARTS: Record<MatchPhase, number> = { 1: 0, 2: 75, 3: 165 };

export const PHASE_INFO: Record<MatchPhase, { label: string; resource: string }> = {
	1: { label: '1단계', resource: '스탯' },
	2: { label: '2단계', resource: '스킬' },
	3: { label: '3단계', resource: '시너지' }
};

export function phaseAt(time: number): MatchPhase {
	if (time >= PHASE_STARTS[3]) return 3;
	if (time >= PHASE_STARTS[2]) return 2;
	return 1;
}

type Bucket = `${ItemKind}:${Rarity}` | 'weapon' | 'skill' | 'bridge';

const PHASE_WEIGHTS: Record<MatchPhase, Partial<Record<Bucket, number>>> = {
	1: { 'stat:common': 64, 'stat:rare': 28, weapon: 8 },
	2: { 'stat:common': 22, 'stat:rare': 32, skill: 40, weapon: 6 },
	3: { 'stat:common': 10, 'stat:rare': 35, skill: 15, bridge: 40 }
};

function bucketOf(item: ItemDef): Bucket {
	if (item.kind === 'weapon') return 'weapon';
	if (item.kind === 'skill') return 'skill';
	if (item.kind === 'bridge') return 'bridge';
	return `stat:${item.rarity}`;
}

/** Pulls offers slightly toward tags you already own so builds can actually converge. */
const OWNED_TAG_BIAS = 0.35;
export const OFFER_SIZE = 3;

export function isOfferable(item: ItemDef, owned: readonly string[]) {
	if ((item.kind === 'bridge' || item.kind === 'weapon') && owned.includes(item.id)) return false;
	if (item.kind === 'skill') {
		if (owned.includes(item.id)) return false;
		const skillCount = owned.filter((id) => getItem(id).kind === 'skill').length;
		if (skillCount >= MAX_SKILLS) return false;
	}
	return true;
}

export function rollOffer(rng: Rng, phase: MatchPhase, owned: readonly string[]): string[] {
	const counts = emptyTagCounts();
	for (const id of owned) for (const t of getItem(id).tags) counts[t] += 1;

	const weights = PHASE_WEIGHTS[phase];
	const offer: string[] = [];

	for (let i = 0; i < OFFER_SIZE; i++) {
		const candidates = ITEMS.filter((it) => !offer.includes(it.id) && isOfferable(it, owned));
		const byBucket = new Map<Bucket, ItemDef[]>();
		for (const it of candidates) {
			const b = bucketOf(it);
			if (!weights[b]) continue;
			byBucket.set(b, [...(byBucket.get(b) ?? []), it]);
		}
		const bucket = rng.weighted(
			[...byBucket.keys()].map((b) => ({ item: b, weight: weights[b] ?? 0 }))
		);
		const pool = bucket ? byBucket.get(bucket)! : candidates;
		const pick = rng.weighted(
			pool.map((it) => ({
				item: it,
				weight: 1 + OWNED_TAG_BIAS * it.tags.reduce((s, t) => s + counts[t], 0)
			}))
		);
		if (!pick) break;
		offer.push(pick.id);
	}
	return offer;
}
