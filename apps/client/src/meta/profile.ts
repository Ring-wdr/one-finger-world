import { getRune, RUNE_SLOTS, type RuneSlot } from '@ofa/sim';

/** Persistent meta progression: coins earned from matches and the rune collection. */
export interface Profile {
	coins: number;
	owned: string[];
	equipped: Record<RuneSlot, string | null>;
	best: number;
	matches: number;
}

export const PROFILE_STORAGE_KEY = 'ofa.profile.v1';

export function defaultProfile(): Profile {
	return { coins: 0, owned: [], equipped: { offense: null, defense: null, utility: null }, best: 0, matches: 0 };
}

const nonNegInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

export function parseProfile(raw: unknown): Profile {
	const p = defaultProfile();
	if (typeof raw !== 'object' || raw === null) return p;
	const r = raw as Partial<Record<keyof Profile, unknown>>;
	p.coins = nonNegInt(r.coins);
	p.best = nonNegInt(r.best);
	p.matches = nonNegInt(r.matches);
	if (Array.isArray(r.owned)) p.owned = [...new Set(r.owned.filter((id): id is string => typeof id === 'string' && !!getRune(id)))];
	if (typeof r.equipped === 'object' && r.equipped !== null) {
		const eq = r.equipped as Record<string, unknown>;
		for (const slot of RUNE_SLOTS) {
			const id = eq[slot];
			// Only owned runes of the right slot survive a load.
			if (typeof id === 'string' && p.owned.includes(id) && getRune(id)?.slot === slot) p.equipped[slot] = id;
		}
	}
	return p;
}

export function loadProfile(storage: Storage | undefined): Profile {
	try {
		const raw = storage?.getItem(PROFILE_STORAGE_KEY);
		return raw ? parseProfile(JSON.parse(raw)) : defaultProfile();
	} catch {
		return defaultProfile();
	}
}

export function saveProfile(storage: Storage | undefined, p: Profile) {
	try {
		storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(p));
	} catch {
		// Private mode / quota: progress lasts for this session only.
	}
}

export type ShopError = 'unknown' | 'owned' | 'coins';

/** Buys and auto-equips when the slot is empty. Returns the new profile or why it failed. */
export function buyRune(p: Profile, id: string): Profile | ShopError {
	const rune = getRune(id);
	if (!rune) return 'unknown';
	if (p.owned.includes(id)) return 'owned';
	if (p.coins < rune.cost) return 'coins';
	const equipped = p.equipped[rune.slot] ? p.equipped : { ...p.equipped, [rune.slot]: id };
	return { ...p, coins: p.coins - rune.cost, owned: [...p.owned, id], equipped };
}

/** Equips an owned rune; equipping the one already in its slot takes it off. */
export function toggleRune(p: Profile, id: string): Profile {
	const rune = getRune(id);
	if (!rune || !p.owned.includes(id)) return p;
	const next = p.equipped[rune.slot] === id ? null : id;
	return { ...p, equipped: { ...p.equipped, [rune.slot]: next } };
}

export function equippedRunes(p: Profile): string[] {
	return RUNE_SLOTS.map((s) => p.equipped[s]).filter((id): id is string => id !== null);
}

export function grantReward(p: Profile, coins: number, score: number): Profile {
	return { ...p, coins: p.coins + Math.max(0, Math.floor(coins)), best: Math.max(p.best, score), matches: p.matches + 1 };
}
