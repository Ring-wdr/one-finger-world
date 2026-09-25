/** Seedable mulberry32 PRNG. State is a single uint32 so it can be snapshotted/synced. */
export class Rng {
	state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	next(): number {
		let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	range(min: number, max: number) {
		return min + (max - min) * this.next();
	}

	int(n: number) {
		return Math.floor(this.next() * n);
	}

	chance(p: number) {
		return this.next() < p;
	}

	pick<T>(items: readonly T[]): T {
		return items[this.int(items.length)];
	}

	weighted<T>(entries: readonly { item: T; weight: number }[]): T | undefined {
		let total = 0;
		for (const e of entries) total += Math.max(0, e.weight);
		if (total <= 0) return undefined;
		let roll = this.next() * total;
		for (const e of entries) {
			roll -= Math.max(0, e.weight);
			if (roll < 0) return e.item;
		}
		return entries[entries.length - 1].item;
	}

	shuffle<T>(items: T[]): T[] {
		for (let i = items.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			[items[i], items[j]] = [items[j], items[i]];
		}
		return items;
	}
}
