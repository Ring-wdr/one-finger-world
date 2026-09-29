import { describe, expect, it } from 'vitest';
import { Close, decodeSnapshot, emptyFrame, encodeInput, parseServerMessage, type InputFrame, type ServerMessage, type Snapshot } from '@ofa/net';
import type { WorldCheckpoint } from '@ofa/sim';
import { MatchCore } from './core';
import {
	ABANDON_MS,
	CHECKPOINT_EVERY_TICKS,
	CLEANUP_AFTER_END_MS,
	DISCONNECT_GRACE_MS,
	EMPTY_ROOM_TTL_MS,
	END_LINGER_MS,
	FULL_START_DELAY_MS,
	GRANT_RETRY_MS,
	MAX_GRANT_ATTEMPTS,
	MAX_TICK_CRASHES,
	WAIT_MS,
	WATCHDOG_MS,
	type MatchHost,
	type MatchMeta,
	type MatchSummary,
	type RewardGrant,
	type RewardOutcome,
	type SeatClaim
} from './types';

const T0 = 1_700_000_000_000;

class FakeHost implements MatchHost {
	t = T0;
	sent: { conn: string; data: string | Uint8Array }[] = [];
	closed: { conn: string; code: number; reason: string }[] = [];
	meta: MatchMeta | null = null;
	checkpoint: WorldCheckpoint | null = null;
	alarm: number | null = null;
	destroyed = 0;
	logs: Record<string, unknown>[] = [];
	grants: RewardGrant[] = [];
	recorded: MatchSummary[] = [];
	grantImpl: (g: RewardGrant) => Promise<RewardOutcome> = async (g) => ({ status: 'granted', coins: 100 + g.coins, best: g.score, prevBest: 0 });

	now = () => this.t;
	send = (conn: string, data: string | Uint8Array) => void this.sent.push({ conn, data });
	close = (conn: string, code: number, reason: string) => void this.closed.push({ conn, code, reason });
	save = (meta: MatchMeta, checkpoint?: WorldCheckpoint | null) => {
		this.meta = structuredClone(meta);
		if (checkpoint !== undefined) this.checkpoint = checkpoint;
	};
	setAlarm = (at: number | null) => void (this.alarm = at);
	grant = (g: RewardGrant) => {
		this.grants.push(g);
		return this.grantImpl(g);
	};
	recordMatch = async (s: MatchSummary) => void this.recorded.push(s);
	destroy = () => void this.destroyed++;
	log = (fields: Record<string, unknown>) => void this.logs.push(fields);
	random32 = () => 4242;

	json(conn: string): ServerMessage[] {
		return this.sent.flatMap((s) => (s.conn === conn && typeof s.data === 'string' ? [parseServerMessage(s.data)!] : []));
	}
	of<T extends ServerMessage['t']>(conn: string, t: T): Extract<ServerMessage, { t: T }>[] {
		return this.json(conn).filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
	}
	snapshots(conn: string): Snapshot[] {
		return this.sent.flatMap((s) => (s.conn === conn && typeof s.data !== 'string' ? [decodeSnapshot(s.data)] : []));
	}
	log_(event: string) {
		return this.logs.filter((l) => l.event === event);
	}
}

const claim = (uid: string, host: FakeHost, over: Partial<SeatClaim> = {}): SeatClaim => ({ uid, name: `name-${uid}`, runes: [], iat: host.t, ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));
const input = (seq: number, over: Partial<InputFrame> = {}) => encodeInput({ ...emptyFrame(seq), ...over }).slice().buffer;

function lobby(humans = 2) {
	const host = new FakeHost();
	const core = new MatchCore(host, 'm1');
	for (let i = 0; i < humans; i++) expect(core.join(`c${i}`, claim(`u${i}`, host))).toBeNull();
	return { host, core };
}

async function running(humans = 2) {
	const { host, core } = lobby(humans);
	host.t += WAIT_MS;
	await core.alarm();
	expect(core.state).toBe('running');
	return { host, core };
}

const fighterOf = (core: MatchCore, uid: string) => {
	const id = core.debugState().seats.find((s) => s.uid === uid)!.fighterId;
	return core.world!.fighters.find((f) => f.id === id)!;
};

/** Shrinks the zone to a point and leaves the fighter a sliver of health: it dies on the next tick. */
function doom(core: MatchCore, uid: string) {
	const f = fighterOf(core, uid);
	core.world!.zone.from = { center: { x: 0, y: 0 }, radius: 1 };
	f.hp = 0.001;
	f.shield = 0;
}

describe('waiting room', () => {
	it('seats players in join order and tells everyone the lobby', () => {
		const { host, core } = lobby(2);
		expect(core.state).toBe('waiting');
		const last = host.of('c0', 'lobby').at(-1)!;
		expect(last.players).toEqual([
			{ name: 'name-u0', you: true },
			{ name: 'name-u1', you: false }
		]);
		expect(host.of('c1', 'lobby').at(-1)!.players.map((p) => p.you)).toEqual([false, true]);
		expect(last).toMatchObject({ matchId: 'm1', max: 12, startsAt: T0 + WAIT_MS, serverNow: T0 });
		expect(host.alarm).toBe(T0 + WAIT_MS);
	});

	it('pulls the start in when the room fills and rejects the 13th player', () => {
		const { host, core } = lobby(11);
		host.t += 5000;
		expect(core.join('c11', claim('u11', host))).toBeNull();
		expect(host.alarm).toBe(host.t + FULL_START_DELAY_MS);
		expect(core.join('c12', claim('u12', host))).toMatchObject({ code: Close.Full });
	});

	it('refuses a stale ticket for a new seat but not for a returning one', () => {
		const { host, core } = lobby(1);
		const stale = claim('other', host, { iat: host.t - 30_001 });
		expect(core.join('cx', stale)).toMatchObject({ code: Close.Ended });
		expect(core.join('c0b', claim('u0', host, { iat: host.t - 60_000 }))).toBeNull();
		expect(host.closed).toEqual([{ conn: 'c0', code: Close.Replaced, reason: expect.any(String) }]);
	});

	it('frees the seat when a player disconnects or leaves', () => {
		const { host, core } = lobby(3);
		core.disconnect('c1');
		expect(host.of('c0', 'lobby').at(-1)!.players).toHaveLength(2);
		core.message('c2', JSON.stringify({ t: 'leave' }));
		expect(host.of('c0', 'lobby').at(-1)!.players).toHaveLength(1);
		expect(host.closed.at(-1)).toMatchObject({ conn: 'c2', code: Close.Normal });
		// The freed seat can be taken again.
		expect(core.join('c9', claim('u1', host))).toBeNull();
	});

	it('destroys an empty room after the TTL', async () => {
		const { host, core } = lobby(1);
		core.disconnect('c0');
		expect(host.alarm).toBe(T0 + EMPTY_ROOM_TTL_MS);
		host.t += EMPTY_ROOM_TTL_MS - 1;
		await core.alarm();
		expect(host.destroyed).toBe(0);
		host.t += 1;
		await core.alarm();
		expect(host.destroyed).toBe(1);
		expect(core.state).toBe('empty');
	});
});

describe('start', () => {
	it('starts at startsAt with the humans first and bots for the rest', async () => {
		const { host, core } = lobby(2);
		host.t += WAIT_MS - 1;
		await core.alarm();
		expect(core.state).toBe('waiting');
		host.t += 1;
		await core.alarm();
		expect(core.state).toBe('running');

		const world = core.world!;
		expect(world.seed).toBe(4242);
		expect(world.fighters).toHaveLength(12);
		expect(world.fighters.filter((f) => f.bot === null)).toHaveLength(2);
		const start = host.of('c0', 'start')[0]!;
		expect(start).toMatchObject({ matchId: 'm1', tick: 0, you: fighterOf(core, 'u0').id });
		expect(start.fighters.filter((f) => f.human)).toHaveLength(2);
		expect(host.of('c1', 'self')).toHaveLength(1);
		expect(host.meta).toMatchObject({ state: 'running', seed: 4242 });
		expect(host.checkpoint?.tick).toBe(0);
		expect(host.log_('match_start')[0]).toMatchObject({ humans: 2, seed: 4242 });
		expect(host.alarm).toBe(host.t + WATCHDOG_MS);

		core.tick();
		const snap = host.snapshots('c0');
		expect(snap).toHaveLength(1);
		expect(snap[0]!.tick).toBe(1);
		expect(snap[0]!.self).not.toBeNull();
	});
});

describe('inputs', () => {
	it('moves the fighter with a move frame and reports the ack', async () => {
		const { host, core } = await running();
		const before = fighterOf(core, 'u0').pos.x;
		core.message('c0', input(1, { move: { x: 1, y: 0 }, run: true }));
		core.tick();
		expect(fighterOf(core, 'u0').pos.x).toBeGreaterThan(before);
		expect(host.snapshots('c0')[0]).toMatchObject({ ack: 1, sinceAck: 0, inputQueue: 0 });
	});

	it('drops frames that are not newer than the last seq', async () => {
		const { host, core } = await running();
		core.message('c0', input(5));
		core.message('c0', input(3));
		core.message('c0', input(5));
		core.tick();
		core.tick();
		const snaps = host.snapshots('c0');
		expect(snaps[0]).toMatchObject({ ack: 5, inputQueue: 0 });
		expect(snaps[1]).toMatchObject({ ack: 5, sinceAck: 1 });
	});

	it('merges the one-shots of a frame dropped by queue overflow', async () => {
		const { host, core } = await running();
		core.message('c0', input(1, { attack: true }));
		for (let seq = 2; seq <= 5; seq++) core.message('c0', input(seq, { move: { x: 0, y: 1 } }));
		core.tick();
		const snap = host.snapshots('c0')[0]!;
		expect(snap).toMatchObject({ ack: 2, inputQueue: 3 });
		expect(snap.events.some((e) => e.type === 'attack' && e.unit === fighterOf(core, 'u0').id)).toBe(true);
	});

	it('raises sinceAck while no input arrives, and ignores malformed frames', async () => {
		const { host, core } = await running();
		core.message('c0', input(1));
		core.message('c0', new ArrayBuffer(3));
		for (let i = 0; i < 4; i++) core.tick();
		expect(host.snapshots('c0').map((s) => s.sinceAck)).toEqual([0, 1, 2, 3]);
		expect(host.snapshots('c0').map((s) => s.ack)).toEqual([1, 1, 1, 1]);
	});

	it('sends self before the snapshot when the build changes', async () => {
		const { host, core } = await running();
		core.tick();
		const before = host.of('c0', 'self').length;
		const f = fighterOf(core, 'u0');
		f.pendingDrafts += 1;
		host.sent.length = 0;
		core.tick();
		expect(host.of('c0', 'self')).toHaveLength(1);
		expect(host.of('c0', 'self')[0]!.pendingDrafts).toBe(f.pendingDrafts);
		expect(host.sent[0]!.data).toEqual(expect.any(String));
		expect(before).toBe(1);
		host.sent.length = 0;
		core.tick();
		expect(host.of('c0', 'self')).toHaveLength(0);
	});

	it('follows the requested spectate target once the fighter is dead', async () => {
		const { host, core } = await running();
		const target = fighterOf(core, 'u1').id;
		doom(core, 'u0');
		core.tick();
		core.message('c0', JSON.stringify({ t: 'spectate', id: target }));
		core.tick();
		expect(host.snapshots('c0').at(-1)!.focusId).toBe(target);
	});
});

describe('disconnects and the AI', () => {
	it('hands the fighter to the AI after the grace period and locks the result', async () => {
		const { host, core } = await running();
		core.disconnect('c0');
		host.t += DISCONNECT_GRACE_MS - 1;
		core.tick();
		expect(fighterOf(core, 'u0').bot).toBeNull();
		host.t += 1;
		core.tick();
		expect(fighterOf(core, 'u0').bot).not.toBeNull();
		expect(host.meta!.seats[0]!.locked).toMatchObject({ placement: 12, leftEarly: true, kills: 0 });
	});

	it('restores control and clears the lock when the human returns', async () => {
		const { host, core } = await running();
		core.disconnect('c0');
		host.t += DISCONNECT_GRACE_MS;
		core.tick();
		expect(core.debugState().seats[0]).toMatchObject({ bot: true, connected: false });
		expect(core.join('c0b', claim('u0', host))).toBeNull();
		expect(core.debugState().seats[0]).toMatchObject({ bot: false, connected: true });
		expect(host.meta!.seats[0]!.locked).toBeNull();
		expect(host.of('c0b', 'start')).toHaveLength(1);
		expect(host.of('c0b', 'self')).toHaveLength(1);
		// The old socket's late close event must not disconnect the new connection.
		core.disconnect('c0');
		expect(core.debugState().seats[0]!.connected).toBe(true);
	});

	it('locks at once on leave, and ignores input from an AI-controlled seat', async () => {
		const { host, core } = await running();
		core.message('c0', JSON.stringify({ t: 'leave' }));
		expect(fighterOf(core, 'u0').bot).not.toBeNull();
		expect(host.meta!.seats[0]).toMatchObject({ left: true, locked: { leftEarly: true } });
		core.message('c0', input(1, { move: { x: 1, y: 0 } }));
		core.tick();
		expect(host.snapshots('c0')[0]).toMatchObject({ ack: 0, inputQueue: 0 });
	});

	it('gives a locked seat the locked result when its fighter dies', async () => {
		const { host, core } = await running();
		core.message('c0', JSON.stringify({ t: 'leave' }));
		core.tick();
		doom(core, 'u0');
		core.tick();
		await flush();
		expect(host.meta!.seats[0]!.final).toMatchObject({ placement: 12, leftEarly: true });
		expect(host.grants).toHaveLength(1);
	});
});

describe('results and rewards', () => {
	it('finalizes a death and grants exactly once', async () => {
		const { host, core } = await running();
		host.grantImpl = async (g) => ({ status: 'granted', coins: 100 + g.coins, best: g.score, prevBest: g.score - 1 });
		doom(core, 'u0');
		core.tick();
		expect(core.debugState().seats[0]!.final).toMatchObject({ placement: 12, leftEarly: false });
		await flush();
		for (let i = 0; i < 5; i++) core.tick();
		expect(host.grants).toHaveLength(1);
		expect(host.grants[0]).toMatchObject({ matchId: 'm1', uid: 'u0' });
		const result = host.of('c0', 'result');
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ placement: 12, rewardPending: false, newBest: true, coins: 100 + host.grants[0]!.coins });
		expect(host.of('c1', 'result')).toHaveLength(0);
		expect(core.debugState().seats[0]!.outcome).toMatchObject({ status: 'granted', attempts: 1 });
	});

	it('keeps the match ticking while a grant is slow', async () => {
		const { host, core } = await running();
		host.grantImpl = () => new Promise(() => {});
		doom(core, 'u0');
		core.tick();
		core.tick();
		expect(core.world!.tick).toBe(2);
		expect(host.of('c0', 'result')).toHaveLength(0);
	});

	it('marks a failed grant pending, tells the seat, and retries from the alarm', async () => {
		const { host, core } = await running();
		let calls = 0;
		host.grantImpl = async (g) => {
			if (++calls === 1) throw new Error('d1 down');
			return { status: 'granted', coins: g.coins, best: g.score, prevBest: 0 };
		};
		doom(core, 'u0');
		core.tick();
		await flush();
		expect(core.debugState().seats[0]!.outcome).toMatchObject({ status: 'pending', attempts: 1, coins: null });
		expect(host.of('c0', 'result')[0]).toMatchObject({ rewardPending: true, coins: null });
		expect(host.log_('grant_error')[0]).toMatchObject({ uid: 'u0', attempt: 1, message: 'd1 down' });

		host.t += GRANT_RETRY_MS - 1;
		await core.alarm();
		expect(calls).toBe(1);
		host.t += 1;
		await core.alarm();
		expect(calls).toBe(2);
		expect(core.debugState().seats[0]!.outcome).toMatchObject({ status: 'granted', attempts: 2 });
		expect(host.of('c0', 'result').at(-1)).toMatchObject({ rewardPending: false });
		// Idempotent: another alarm does not pay again.
		await core.alarm();
		expect(calls).toBe(2);
	});

	it('gives up after MAX_GRANT_ATTEMPTS', async () => {
		const { host, core } = await running();
		host.grantImpl = async () => {
			throw new Error('nope');
		};
		doom(core, 'u0');
		core.tick();
		await flush();
		for (let i = 1; i < MAX_GRANT_ATTEMPTS; i++) {
			host.t += GRANT_RETRY_MS;
			await core.alarm();
		}
		expect(host.grants).toHaveLength(MAX_GRANT_ATTEMPTS);
		expect(core.debugState().seats[0]!.outcome).toMatchObject({ status: 'failed', attempts: MAX_GRANT_ATTEMPTS });
		host.t += GRANT_RETRY_MS;
		await core.alarm();
		expect(host.grants).toHaveLength(MAX_GRANT_ATTEMPTS);
	});

	it('treats a duplicate grant as paid without a new best', async () => {
		const { host, core } = await running();
		host.grantImpl = async () => ({ status: 'duplicate', coins: 500, best: 900, prevBest: 900 });
		doom(core, 'u0');
		core.tick();
		await flush();
		expect(host.of('c0', 'result')[0]).toMatchObject({ coins: 500, best: 900, newBest: false, rewardPending: false });
	});
});

describe('match end', () => {
	it('ends the match, records it, closes sockets after the linger and cleans up', async () => {
		const { host, core } = await running();
		core.message('c0', input(1));
		core.fastForward();
		expect(core.state).toBe('ended');
		await flush();
		for (const conn of ['c0', 'c1']) {
			expect(host.of(conn, 'end')).toHaveLength(1);
			expect(host.of(conn, 'result')).toHaveLength(1);
		}
		const winner = core.world!.winner;
		expect(host.of('c0', 'end')[0]!.winner).toBe(winner);
		expect(host.recorded).toHaveLength(1);
		expect(host.recorded[0]).toMatchObject({ matchId: 'm1', seed: 4242, humans: 2, winnerUid: null });
		expect(host.grants.map((g) => g.uid).sort()).toEqual(['u0', 'u1']);
		expect(host.log_('match_end')[0]).toMatchObject({ matchId: 'm1', humans: 2, restores: 0 });
		expect(host.checkpoint).toBeNull();

		const endedAt = host.t;
		expect(host.alarm).toBe(endedAt + END_LINGER_MS);
		host.t = endedAt + END_LINGER_MS - 1;
		await core.alarm();
		expect(host.closed).toHaveLength(0);
		host.t = endedAt + END_LINGER_MS;
		await core.alarm();
		expect(host.closed.map((c) => [c.conn, c.code])).toEqual([
			['c0', Close.Normal],
			['c1', Close.Normal]
		]);
		expect(host.alarm).toBe(endedAt + CLEANUP_AFTER_END_MS);
		host.t = endedAt + CLEANUP_AFTER_END_MS;
		await core.alarm();
		await core.alarm();
		expect(host.destroyed).toBe(1);
	});

	it('names a human winner and gives it placement 1', async () => {
		const { host, core } = await running();
		const world = core.world!;
		world.zone.from = { center: { x: 0, y: 0 }, radius: 1 };
		for (const f of world.fighters) if (f !== fighterOf(core, 'u0')) f.hp = 0.001;
		core.tick();
		await flush();
		expect(core.state).toBe('ended');
		expect(host.recorded[0]!.winnerUid).toBe('u0');
		expect(host.of('c0', 'end')[0]!.winner).toBe(fighterOf(core, 'u0').id);
		expect(host.of('c0', 'result')[0]).toMatchObject({ placement: 1 });
		expect(host.of('c1', 'result')[0]!.placement).toBeGreaterThan(1);
	});

	it('waits for a pending grant before cleaning up', async () => {
		const { host, core } = await running();
		host.grantImpl = async () => {
			throw new Error('d1 down');
		};
		core.fastForward();
		await flush();
		const endedAt = host.t;
		host.t = endedAt + CLEANUP_AFTER_END_MS;
		await core.alarm();
		expect(host.destroyed).toBe(0);
		host.grantImpl = async (g) => ({ status: 'granted', coins: g.coins, best: g.score, prevBest: 0 });
		host.t += GRANT_RETRY_MS;
		await core.alarm();
		await core.alarm();
		expect(host.destroyed).toBe(1);
	});

	it('resends the result and end to a seat that comes back after the end', async () => {
		const { host, core } = await running();
		core.fastForward();
		await flush();
		host.sent.length = 0;
		expect(core.join('c0b', claim('u0', host))).toBeNull();
		expect(host.of('c0b', 'result')).toHaveLength(1);
		expect(host.of('c0b', 'end')).toHaveLength(1);
		expect(core.join('cnew', claim('stranger', host))).toMatchObject({ code: Close.Ended });
	});
});

describe('restore', () => {
	async function midMatch() {
		const { host, core } = await running();
		while (core.world!.tick < CHECKPOINT_EVERY_TICKS) core.tick();
		return { host, core };
	}

	it('continues from the last checkpoint with every seat disconnected', async () => {
		const { host } = await midMatch();
		expect(host.checkpoint!.tick).toBe(CHECKPOINT_EVERY_TICKS);
		const host2 = new FakeHost();
		host2.t = host.t + 1000;
		const core2 = new MatchCore(host2, 'm1', { meta: structuredClone(host.meta!), checkpoint: host.checkpoint });
		expect(core2.state).toBe('running');
		expect(core2.world!.tick).toBe(CHECKPOINT_EVERY_TICKS);
		expect(host2.meta!.restores).toBe(1);
		expect(host2.log_('match_restore')[0]).toMatchObject({ matchId: 'm1', tick: CHECKPOINT_EVERY_TICKS, crashes: 0 });
		expect(core2.debugState().seats.every((s) => !s.connected)).toBe(true);

		core2.reattach('r0', 'u0');
		core2.tick();
		expect(core2.world!.tick).toBe(CHECKPOINT_EVERY_TICKS + 1);
		expect(host2.snapshots('r0')[0]!.tick).toBe(CHECKPOINT_EVERY_TICKS + 1);
		// The seat that did not come back is taken over by the AI after the grace period.
		host2.t += DISCONNECT_GRACE_MS;
		core2.tick();
		expect(core2.debugState().seats.map((s) => s.bot)).toEqual([false, true]);
	});

	it('resets the crash counter at the next checkpoint', async () => {
		const { host } = await midMatch();
		const meta = structuredClone(host.meta!);
		meta.crashes = MAX_TICK_CRASHES;
		const host2 = new FakeHost();
		const core2 = new MatchCore(host2, 'm1', { meta, checkpoint: host.checkpoint });
		expect(core2.state).toBe('running');
		expect(host2.meta!.crashes).toBe(MAX_TICK_CRASHES);
		while (core2.world!.tick < 2 * CHECKPOINT_EVERY_TICKS) core2.tick();
		expect(host2.meta!.crashes).toBe(0);
	});

	it('aborts when the crash limit is passed', async () => {
		const { host, core } = await midMatch();
		const meta = core.recordCrash();
		meta.crashes = MAX_TICK_CRASHES + 1;
		const host2 = new FakeHost();
		const core2 = new MatchCore(host2, 'm1', { meta: structuredClone(meta), checkpoint: host.checkpoint });
		expect(core2.state).toBe('ended');
		expect(host2.meta).toMatchObject({ aborted: true, state: 'ended' });
		expect(host2.meta!.seats.every((s) => s.final === null)).toBe(true);
		core2.reattach('r0', 'u0');
		expect(host2.closed).toEqual([{ conn: 'r0', code: Close.ServerError, reason: expect.any(String) }]);
		expect(core2.join('r1', claim('u1', host2))).toMatchObject({ code: Close.ServerError });
		expect(host2.grants).toHaveLength(0);
		host2.t += CLEANUP_AFTER_END_MS;
		await core2.alarm();
		expect(host2.destroyed).toBe(1);
	});

	it('pays a result whose grant was interrupted by the restart', async () => {
		const { host, core } = await running();
		host.grantImpl = () => new Promise(() => {});
		doom(core, 'u0');
		core.tick();
		while (core.world!.tick < CHECKPOINT_EVERY_TICKS) core.tick();
		const host2 = new FakeHost();
		const meta = structuredClone(host.meta!);
		meta.seats[0]!.outcome = null;
		const core2 = new MatchCore(host2, 'm1', { meta, checkpoint: host.checkpoint });
		await core2.alarm();
		expect(host2.grants).toHaveLength(1);
		expect(core2.debugState().seats[0]!.outcome).toMatchObject({ status: 'granted' });
	});
});

describe('abandonment', () => {
	it('fast-forwards to the end when nobody has been connected for a while', async () => {
		const { host, core } = await running();
		core.disconnect('c0');
		host.t += 10_000;
		core.disconnect('c1');
		host.t += ABANDON_MS - 1;
		await core.alarm();
		expect(core.state).toBe('running');
		host.t += 1;
		await core.alarm();
		expect(core.state).toBe('ended');
		expect(core.world!.over).toBe(true);
		await flush();
		// Both seats were handed to the AI and the match ran out: both results are decided and paid.
		expect(host.grants).toHaveLength(2);
		expect(host.recorded).toHaveLength(1);
	});
});
