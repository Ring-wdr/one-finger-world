import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Close, PING, PONG } from '@ofa/net';
import { Client } from './wsclient';

async function addPlayer(id: string) {
	await env.DB.prepare('INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?, ?, 0, 0)').bind(id, id).run();
}

describe('MatchRoom', () => {
	it('answers ping with pong without a seat', async () => {
		const stub = env.MATCH.get(env.MATCH.newUniqueId());
		const c = await Client.connect(stub, 'pinger');
		c.ws.send(PING);
		await c.waitFor((i) => ('text' in i && i.text === PONG ? true : undefined));
		c.ws.close();
	});

	it('closes a socket that sends more messages than the budget allows', async () => {
		const stub = env.MATCH.get(env.MATCH.newUniqueId());
		const uid = `flood-${stub.id.toString().slice(0, 8)}`;
		await addPlayer(uid);
		const c = await Client.connect(stub, uid);
		for (let i = 0; i < 300; i++) c.ws.send('{}');
		const code = await c.waitFor((i) => ('close' in i ? i.close : undefined));
		expect(code).toBe(Close.Flood);
	});

	it('rejects a request that is not a WebSocket upgrade or has no seat', async () => {
		const stub = env.MATCH.get(env.MATCH.newUniqueId());
		expect((await stub.fetch('http://room/ws')).status).toBe(426);
		expect((await stub.fetch('http://room/ws', { headers: { Upgrade: 'websocket' } })).status).toBe(400);
	});

	it('runs a match: lobby, start, inputs, restore after a restart, end and rewards', { timeout: 60_000 }, async () => {
		const stub = env.MATCH.get(env.MATCH.newUniqueId());
		const matchId = stub.id.toString();
		const [uidA, uidB] = [`a-${matchId.slice(0, 8)}`, `b-${matchId.slice(0, 8)}`];
		await addPlayer(uidA);
		await addPlayer(uidB);

		const a = await Client.connect(stub, uidA);
		const b = await Client.connect(stub, uidB);
		const lobby = await a.message('lobby', (m) => m.players.length === 2);
		expect(lobby.players.map((p) => p.you)).toEqual([true, false]);
		await b.message('lobby', (m) => m.players.length === 2);

		await stub.debugForceStart();
		const start = await a.message('start');
		expect(start.fighters).toHaveLength(12);
		await b.message('start');
		await a.message('self');

		// Inputs move the fighter.
		const first = await a.snapshot((s) => s.self !== null);
		const stop = a.streamInput({ move: { x: 1, y: 0 }, run: true });
		const moved = await a.snapshot((s) => s.self !== null && Math.hypot(s.self.pos.x - first.self!.pos.x, s.self.pos.y - first.self!.pos.y) > 0.5);
		stop();
		expect(moved.ack).toBeGreaterThan(0);

		// Run past the first checkpoint, then evict the room and its sockets.
		const beforeEvict = await a.snapshot((s) => s.tick >= 45);
		// The tick timer keeps a running room from being evicted, so restart it the way a tick crash does.
		await runInDurableObject(stub, (_room, state) => state.abort('test restart')).catch(() => {});
		// A stub that saw the abort stays broken; a new one reaches the fresh instance.
		const revived = env.MATCH.get(stub.id);
		const a2 = await Client.connect(revived, uidA);
		const restarted = await a2.message('start');
		expect(restarted.you).toBe(start.you);
		expect(restarted.tick).toBeGreaterThanOrEqual(40);
		expect(restarted.tick).toBeLessThanOrEqual(beforeEvict.tick);
		const resumed = await a2.snapshot((s) => s.tick > restarted.tick);
		expect(resumed.self).not.toBeNull();
		expect((await revived.debugState()).state).toBe('running');

		// Finish: both seats get their result once and D1 is paid once.
		await revived.debugFastForward();
		const result = await a2.message('result');
		await a2.message('end');
		expect(result.reward).not.toBeNull();
		expect(result.rewardPending).toBe(false);

		const rows = await env.DB.prepare('SELECT player_id, coins, score FROM match_results WHERE match_id = ? ORDER BY player_id').bind(matchId).all<{ player_id: string; coins: number; score: number }>();
		expect(rows.results.map((r) => r.player_id)).toEqual([uidA, uidB].sort());
		const player = await env.DB.prepare('SELECT coins, best, matches FROM players WHERE id = ?').bind(uidA).first<{ coins: number; best: number; matches: number }>();
		expect(player).toEqual({ coins: result.reward!.coins, best: result.reward!.score, matches: 1 });
		expect(result.coins).toBe(player!.coins);
		const match = await env.DB.prepare('SELECT humans FROM matches WHERE id = ?').bind(matchId).first<{ humans: number }>();
		expect(match).toEqual({ humans: 2 });

		// A returning seat after the end gets its result again, without paying twice.
		const a3 = await Client.connect(revived, uidA);
		await a3.message('result');
		await a3.message('end');
		const again = await env.DB.prepare('SELECT coins, matches FROM players WHERE id = ?').bind(uidA).first<{ coins: number; matches: number }>();
		expect(again).toEqual({ coins: result.reward!.coins, matches: 1 });
	});
});
