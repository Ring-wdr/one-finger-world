/**
 * Headless all-bot matches for balance tuning.
 *   bun run balance -- [matches=40] [fighters=12] [seed=1]
 */
import { createWorld, step, TAGS, type Fighter, type Tag } from '../src/index';

const [matches = 40, fighters = 12, seed0 = 1] = process.argv.slice(2).map(Number);

interface Row {
	appearances: number;
	wins: number;
	placementSum: number;
}
const tagRows = new Map<Tag, Row>(TAGS.map((t) => [t, { appearances: 0, wins: 0, placementSum: 0 }]));
const riskRows = new Map<string, Row>();
const weaponRows = new Map<string, Row>();
const itemPickups = new Map<string, number>();
let durationSum = 0;
let winnerLevelSum = 0;
let winnerItemsSum = 0;
let winnerKillsSum = 0;
let pveDeaths = 0;
const deathTimes: number[] = [];
let totalDeaths = 0;

function bump(row: Row, f: Fighter, won: boolean) {
	row.appearances++;
	row.placementSum += f.placement ?? fighters;
	if (won) row.wins++;
}

const started = performance.now();
for (let i = 0; i < matches; i++) {
	const { world } = createWorld({ seed: seed0 + i, fighters });
	while (!world.over && world.time < 900) {
		step(world);
		for (const e of world.events) {
			if (e.type !== 'death' || e.kind !== 'fighter') continue;
			totalDeaths++;
			if (e.killer === null) pveDeaths++;
			deathTimes.push(world.time);
		}
	}
	durationSum += world.time;

	for (const f of world.fighters) {
		const won = f.id === world.winner;
		// A fighter "plays" a tag if it reached tier 1 in it by the end.
		for (const t of TAGS) if (f.build.tiers[t] >= 1) bump(tagRows.get(t)!, f, won);
		const risk = f.bot!.risk < 0.35 ? 'safe (outer)' : f.bot!.risk < 0.7 ? 'mid' : 'diver (center)';
		if (!riskRows.has(risk)) riskRows.set(risk, { appearances: 0, wins: 0, placementSum: 0 });
		bump(riskRows.get(risk)!, f, won);
		const weapon = f.build.weapon ?? 'none';
		if (!weaponRows.has(weapon)) weaponRows.set(weapon, { appearances: 0, wins: 0, placementSum: 0 });
		bump(weaponRows.get(weapon)!, f, won);
		for (const id of f.items) itemPickups.set(id, (itemPickups.get(id) ?? 0) + 1);
		if (won) {
			winnerLevelSum += f.level;
			winnerItemsSum += f.items.length;
			winnerKillsSum += f.kills;
		}
	}
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const avg = (n: number) => (n / matches).toFixed(1);
const baseline = 1 / fighters;

console.log(`\n${matches} matches × ${fighters} fighters in ${((performance.now() - started) / 1000).toFixed(1)}s`);
console.log(`avg duration ${avg(durationSum)}s · winner lvl ${avg(winnerLevelSum)} · items ${avg(winnerItemsSum)} · kills ${avg(winnerKillsSum)}`);
console.log(`non-PvP deaths (zone/monsters): ${pct(pveDeaths / Math.max(1, totalDeaths))}`);
const buckets = [0, 60, 120, 180, 240, 300, 360];
console.log(
	'deaths by minute:',
	buckets.map((t) => `${t}s:${deathTimes.filter((d) => d >= t && d < t + 60).length}`).join(' ')
);

const table = (title: string, rows: Map<string, Row>) => {
	console.log(`\n${title}  (fair win rate ≈ ${pct(baseline)})`);
	console.table(
		Object.fromEntries(
			[...rows].map(([k, r]) => [
				k,
				{
					fighters: r.appearances,
					'win rate': pct(r.wins / Math.max(1, r.appearances)),
					'avg place': (r.placementSum / Math.max(1, r.appearances)).toFixed(2)
				}
			])
		)
	);
};
table('Tag tier ≥1 at end', tagRows as Map<string, Row>);
table('Risk profile', riskRows);
table('Weapon at end', weaponRows);

const top = [...itemPickups].sort((a, b) => b[1] - a[1]);
console.log('\nmost held items:', top.slice(0, 6).map(([id, n]) => `${id}(${n})`).join(', '));
console.log('least held items:', top.slice(-6).map(([id, n]) => `${id}(${n})`).join(', '));
