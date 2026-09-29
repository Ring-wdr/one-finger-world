import type { MatchSummary, RewardGrant, RewardOutcome } from './types';

interface Balance {
	coins: number;
	best: number;
}

const readBalance = async (db: D1Database, uid: string): Promise<Balance> => {
	const row = await db.prepare('SELECT coins, best FROM players WHERE id = ?').bind(uid).first<Balance>();
	if (!row) throw new Error(`player ${uid} not found`);
	return row;
};

/**
 * Pays one seat's result (§9.3). The (match_id, player_id) primary key makes it idempotent:
 * a repeat fails the batch on the insert, which rolls the coin update back too.
 */
export async function grantReward(db: D1Database, g: RewardGrant, now: number): Promise<RewardOutcome> {
	const { best: prevBest } = await readBalance(db, g.uid);
	try {
		await db.batch([
			db
				.prepare(
					'INSERT INTO match_results (match_id, player_id, placement, kills, level, survived_s, score, coins, left_early, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(g.matchId, g.uid, g.result.placement, g.result.kills, g.result.level, g.result.time, g.score, g.coins, g.result.leftEarly ? 1 : 0, now),
			db
				.prepare('UPDATE players SET coins = coins + ?, best = MAX(best, ?), matches = matches + 1, version = version + 1, last_seen_at = ? WHERE id = ?')
				.bind(g.coins, g.score, now, g.uid)
		]);
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('UNIQUE constraint failed')) throw err;
		const after = await readBalance(db, g.uid);
		return { status: 'duplicate', ...after, prevBest: after.best };
	}
	const after = await readBalance(db, g.uid);
	return { status: 'granted', ...after, prevBest };
}

/** The matches row; a repeat is ignored. */
export async function recordMatch(db: D1Database, s: MatchSummary): Promise<void> {
	await db
		.prepare('INSERT OR IGNORE INTO matches (id, seed, started_at, ended_at, duration_s, humans, winner_player_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(s.matchId, s.seed, s.startedAt, s.endedAt, s.durationS, s.humans, s.winnerUid)
		.run();
}
