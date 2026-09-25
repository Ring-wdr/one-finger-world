/**
 * Headless server-sizing profile: CPU per tick, entity counts, naive snapshot size and how many
 * units sit inside a fighter's area of interest. Numbers feed the multiplayer infra plan
 * (docs/multiplayer-cloud-analysis.md).
 *   bun run profile -- [matches=5] [fighters=12] [seed=11]
 */
import { createWorld, step, type World } from '../src/index';

const [matches = 5, fighters = 12, seed0 = 11] = process.argv.slice(2).map(Number);
/** Area-of-interest radii (world units) to count neighbours for. */
const AOI = [25, 35] as const;
const MAX_SECONDS = 600;

const percentile = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number) => Math.hypot(a.x - b.x, a.y - b.y) < r;

/** Units (other fighters, monsters, projectiles) within `r` of each living fighter. */
function aoiCounts(world: World, r: number): number[] {
	const alive = world.fighters.filter((f) => f.alive);
	return alive.map((f) => {
		let n = 0;
		for (const m of world.monsters) if (near(m.pos, f.pos, r)) n++;
		for (const g of alive) if (g !== f && near(g.pos, f.pos, r)) n++;
		for (const p of world.projectiles) if (near(p.pos, f.pos, r)) n++;
		return n;
	});
}

const allTicks: number[] = [];
for (let i = 0; i < matches; i++) {
	const { world } = createWorld({ seed: seed0 + i, fighters });
	const tickMs: number[] = [];
	const aoi: Record<number, number[]> = { 25: [], 35: [] };
	const snapshotBytes: Record<string, number> = { '0s': JSON.stringify(world).length };
	let maxMonsters = 0;
	let maxProjectiles = 0;
	let events = 0;

	while (!world.over && world.time < MAX_SECONDS) {
		const t0 = performance.now();
		step(world);
		tickMs.push(performance.now() - t0);
		events += world.events.length;
		maxMonsters = Math.max(maxMonsters, world.monsters.length);
		maxProjectiles = Math.max(maxProjectiles, world.projectiles.length);
		if (world.tick % 20 === 0) {
			const t = Math.round(world.time);
			if (t % 60 === 0) snapshotBytes[`${t}s`] = JSON.stringify(world).length;
			for (const r of AOI) aoi[r].push(...aoiCounts(world, r));
		}
	}
	allTicks.push(...tickMs);
	const cpuMs = tickMs.reduce((a, b) => a + b, 0);
	console.log(
		`match ${i + 1}: ${Math.round(world.time)}s, ${world.tick} ticks, cpu ${cpuMs.toFixed(0)} ms ` +
			`(${(cpuMs / world.time).toFixed(2)} ms per sim-second), tick mean ${mean(tickMs).toFixed(3)} ` +
			`p99 ${percentile(tickMs, 0.99).toFixed(3)} max ${Math.max(...tickMs).toFixed(3)} ms, ` +
			`events/tick ${(events / world.tick).toFixed(2)}, monsters ≤${maxMonsters}, projectiles ≤${maxProjectiles}`
	);
	console.log(
		`  aoi r25 mean ${mean(aoi[25]).toFixed(1)} p95 ${percentile(aoi[25], 0.95)} · r35 mean ${mean(aoi[35]).toFixed(1)} p95 ${percentile(aoi[35], 0.95)}`
	);
	console.log(
		`  JSON.stringify(world): ${Object.entries(snapshotBytes)
			.map(([t, b]) => `${t} ${(b / 1024).toFixed(0)} KB`)
			.join(', ')}`
	);
}
console.log(
	`\nall ticks: n ${allTicks.length}, mean ${mean(allTicks).toFixed(3)} ms, p99 ${percentile(allTicks, 0.99).toFixed(3)} ms, max ${Math.max(...allTicks).toFixed(3)} ms`
);
