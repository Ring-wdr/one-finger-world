import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PING, PONG, decodeSnapshot, emptyFrame, encodeInput, parseServerMessage, type ServerMessage, type Snapshot } from '@ofa/net';
import { SEAT_HEADER, encodeSeatHeader } from '../src/match/types';

type Item = { msg: ServerMessage } | { snap: Snapshot } | { text: string } | { close: number };

/** A room connection that records everything it receives. */
class Client {
	readonly items: Item[] = [];
	private waiters: (() => void)[] = [];
	seq = 0;

	private constructor(readonly ws: WebSocket) {
		ws.binaryType = 'arraybuffer';
		ws.addEventListener('message', (e) => {
			if (typeof e.data !== 'string') this.push({ snap: decodeSnapshot(e.data as ArrayBuffer) });
			else {
				const msg = parseServerMessage(e.data);
				this.push(msg ? { msg } : { text: e.data });
			}
		});
		ws.addEventListener('close', (e) => this.push({ close: e.code }));
	}

	static async connect(stub: DurableObjectStub, uid: string): Promise<Client> {
		const claim = { uid, name: `player-${uid}`, runes: [], iat: Date.now() };
		const res = await stub.fetch('http://room/ws', { headers: { Upgrade: 'websocket', [SEAT_HEADER]: encodeSeatHeader(claim) } });
		expect(res.status).toBe(101);
		const ws = res.webSocket!;
		ws.accept();
		return new Client(ws);
	}

	private push(item: Item): void {
		this.items.push(item);
		for (const w of this.waiters.splice(0)) w();
	}

	/** The first received item the picker accepts, waiting up to `timeout` ms. */
	async waitFor<T>(pick: (item: Item) => T | undefined, timeout = 8000): Promise<T> {
		const deadline = Date.now() + timeout;
		for (;;) {
			for (const item of this.items) {
				const v = pick(item);
				if (v !== undefined) return v;
			}
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out; received ${JSON.stringify(this.items.map((i) => Object.keys(i)[0]))}`);
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, left);
				this.waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}

	message<T extends ServerMessage['t']>(t: T, where: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) {
		return this.waitFor((i) => ('msg' in i && i.msg.t === t && where(i.msg as Extract<ServerMessage, { t: T }>) ? (i.msg as Extract<ServerMessage, { t: T }>) : undefined));
	}

	snapshot(where: (s: Snapshot) => boolean = () => true) {
		return this.waitFor((i) => ('snap' in i && where(i.snap) ? i.snap : undefined));
	}

	/** Sends one input frame per 50 ms until the returned function is called. */
	streamInput(over: Partial<ReturnType<typeof emptyFrame>>): () => void {
		const iv = setInterval(() => this.ws.send(encodeInput({ ...emptyFrame(++this.seq), ...over })), 50);
		return () => clearInterval(iv);
	}
}

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
