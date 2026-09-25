/**
 * Match score → coins. Placement dominates (a win is worth ~3 mid-pack finishes),
 * kills and levels reward playing the build game instead of hiding at the edge.
 */
export interface MatchOutcome {
	placement: number;
	fighters: number;
	kills: number;
	level: number;
	/** Seconds survived. */
	time: number;
}

export interface MatchReward {
	score: number;
	coins: number;
	breakdown: { label: string; points: number }[];
}

export const SCORE_PER_COIN = 10;
const PLACEMENT_MAX = 1000;
const PER_KILL = 100;
const PER_LEVEL = 20;
/** Survival points per second, capped so camping can't outscore fighting. */
const PER_SECOND = 1;
const TIME_CAP = 420;

export function scoreMatch(o: MatchOutcome): MatchReward {
	const n = Math.max(2, o.fighters);
	const place = Math.min(n, Math.max(1, Math.round(o.placement)));
	// Quadratic: the top few places matter most, like any royale's ranked points.
	const placement = Math.round(PLACEMENT_MAX * ((n - place) / (n - 1)) ** 2);
	const breakdown = [
		{ label: `순위 #${place}`, points: placement },
		{ label: `처치 ${o.kills}`, points: Math.max(0, o.kills) * PER_KILL },
		{ label: `레벨 ${o.level}`, points: Math.max(0, o.level - 1) * PER_LEVEL },
		{ label: `생존 ${Math.floor(o.time)}초`, points: Math.floor(Math.min(TIME_CAP, Math.max(0, o.time)) * PER_SECOND) }
	];
	const score = breakdown.reduce((a, b) => a + b.points, 0);
	return { score, coins: Math.floor(score / SCORE_PER_COIN), breakdown };
}
