/**
 * One-off gameplay hints already shown (per browser). Shared so the settings screen can
 * reset them before the game (and its HUD) has been loaded.
 */
const HINTS_KEY = 'ofa.hints.v1';

function load(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(HINTS_KEY) ?? '[]') as string[]);
	} catch {
		return new Set();
	}
}

const seen = load();

function save() {
	try {
		localStorage.setItem(HINTS_KEY, JSON.stringify([...seen]));
	} catch {
		// Hints just repeat next time if storage is unavailable.
	}
}

export const seenHints = {
	has: (id: string) => seen.has(id),
	add(id: string) {
		seen.add(id);
		save();
	},
	reset() {
		seen.clear();
		save();
	}
};
