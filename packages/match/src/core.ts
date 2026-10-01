import { scoreMatch } from '@ofa/meta';
import {
	Close,
	INPUT_QUEUE_MAX,
	MATCH_FIGHTERS,
	MAX_HUMANS,
	TICK_MS,
	decodeInput,
	encodeSnapshot,
	frameToCommands,
	mergeOneShots,
	parseClientMessage,
	pickFocus,
	type CloseCode,
	type InputFrame,
	type ResultMessage,
	type ServerMessage
} from '@ofa/net';
import { checkpointWorld, createWorld, restoreWorld, setBotControl, step, type Command, type Fighter, type World, type WorldCheckpoint } from '@ofa/sim';
import {
	ABANDON_MS,
	CHECKPOINT_EVERY_TICKS,
	CLEANUP_AFTER_END_MS,
	DISCONNECT_GRACE_MS,
	EMPTY_ROOM_TTL_MS,
	END_LINGER_MS,
	FULL_START_DELAY_MS,
	GRANT_RETRY_MS,
	JOIN_TICKET_MAX_AGE_MS,
	LATE_TICK_MS,
	MAX_GRANT_ATTEMPTS,
	MAX_MATCH_SECONDS,
	MAX_TICK_CRASHES,
	WAIT_MS,
	WATCHDOG_MS,
	type ConnId,
	type MatchHost,
	type MatchMeta,
	type MatchState,
	type Seat,
	type SeatClaim,
	type SeatOutcome,
	type SeatResult
} from './types';

/** Per-seat state that is not persisted: it is rebuilt (empty) after a restart. */
interface SeatRuntime {
	conn: ConnId | null;
	queue: InputFrame[];
	lastSeq: number;
	ack: number;
	sinceAck: number;
	spectateId: number | null;
	/** JSON of the last `self` content sent, to send it again only on change. */
	selfKey: string | null;
	disconnectedAt: number | null;
	rtt: { p50: number; p95: number; n: number } | null;
	granting: boolean;
	retryAt: number;
}

interface Metrics {
	firstTickAt: number | null;
	lastTickAt: number | null;
	intervals: number[];
	lateTicks: number;
	snapshots: number;
	snapshotBytes: number;
	inputsDropped: number;
	inputStarvedTicks: number;
	reconnects: number;
	botTakeovers: number;
}

const percentile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
};

/**
 * The match state machine (docs/multiplayer-server-design.md §5): seats, the sim, input queues,
 * results and rewards. It knows nothing about Cloudflare; MatchHost supplies time, sockets,
 * storage and D1, so it runs in Node tests with a fake host.
 */
export class MatchCore {
	private meta: MatchMeta;
	private _world: World | null = null;
	private readonly runtimes = new Map<string, SeatRuntime>();
	private readonly connToUid = new Map<ConnId, string>();
	private metrics: Metrics = MatchCore.freshMetrics();
	/** A restore happened and no checkpoint has been written since. */
	private awaitingCheckpoint = false;
	private socketsClosed = false;
	/** Storage is deleted: nothing may be written any more. */
	private cleaned = false;

	constructor(
		private readonly host: MatchHost,
		matchId: string,
		stored?: { meta: MatchMeta; checkpoint: WorldCheckpoint | null }
	) {
		const now = host.now();
		this.meta = stored?.meta ?? {
			v: 1,
			matchId,
			state: 'empty',
			createdAt: now,
			startsAt: null,
			emptySince: null,
			seed: null,
			startedAt: null,
			endedAt: null,
			winner: null,
			seats: [],
			crashes: 0,
			restores: 0,
			aborted: false
		};
		// A grant that was in flight when the room died left no outcome: pay it again (idempotent).
		for (const seat of this.meta.seats) {
			if (seat.final && !seat.outcome) seat.outcome = this.pendingOutcome(seat.final);
		}
		if (stored?.meta.state === 'running') this.restore(stored.checkpoint, now);
		this.schedule();
	}

	get state(): MatchState {
		return this.meta.state;
	}

	get world(): World | null {
		return this._world;
	}

	/** Counts a tick failure in the persisted meta, which the room writes before it aborts. */
	recordCrash(): MatchMeta {
		this.meta.crashes += 1;
		return this.meta;
	}

	join(conn: ConnId, claim: SeatClaim): { code: CloseCode; reason: string } | null {
		const now = this.host.now();
		const existing = this.meta.seats.find((s) => s.uid === claim.uid);
		if (existing) return this.rejoin(conn, existing);
		if (this.meta.state === 'running') return { code: Close.Started, reason: 'match already started' };
		if (this.meta.state === 'ended') return { code: Close.Ended, reason: 'match ended' };
		if (now - claim.iat > JOIN_TICKET_MAX_AGE_MS) return { code: Close.Ended, reason: 'ticket too old' };
		if (this.meta.seats.length >= MAX_HUMANS) return { code: Close.Full, reason: 'match full' };

		const first = this.meta.seats.length === 0;
		this.meta.seats.push({ uid: claim.uid, name: claim.name, runes: claim.runes, fighterId: null, locked: null, final: null, outcome: null, left: false });
		this.link(conn, claim.uid);
		this.meta.state = 'waiting';
		this.meta.emptySince = null;
		if (first) this.meta.startsAt = now + WAIT_MS;
		if (this.meta.seats.length === MAX_HUMANS) this.meta.startsAt = Math.min(this.meta.startsAt ?? Infinity, now + FULL_START_DELAY_MS);
		this.persist();
		this.broadcastLobby();
		this.schedule();
		return null;
	}

	reattach(conn: ConnId, uid: string): void {
		if (!this.meta.seats.some((s) => s.uid === uid)) return;
		if (this.meta.aborted) {
			this.host.close(conn, Close.ServerError, 'match aborted');
			return;
		}
		const rt = this.runtime(uid);
		rt.conn = conn;
		rt.disconnectedAt = null;
		this.connToUid.set(conn, uid);
	}

	message(conn: ConnId, data: string | ArrayBuffer): void {
		const seat = this.seatOf(conn);
		if (!seat) return;
		if (typeof data === 'string') this.textMessage(seat, data);
		else this.inputMessage(seat, data);
	}

	disconnect(conn: ConnId): void {
		const seat = this.seatOf(conn);
		if (!seat) return;
		this.connToUid.delete(conn);
		const rt = this.runtime(seat.uid);
		rt.conn = null;
		if (this.meta.state === 'waiting') this.removeWaitingSeat(seat);
		else if (this.meta.state === 'running') {
			rt.disconnectedAt = this.host.now();
			this.schedule();
		}
	}

	/** One 50 ms sim tick; the room calls it while state is 'running'. */
	tick(): void {
		const world = this._world;
		if (this.meta.state !== 'running' || !world) return;
		const now = this.host.now();
		this.recordInterval(now);

		const commands = new Map<number, Command[]>();
		for (const seat of this.meta.seats) {
			const rt = this.runtime(seat.uid);
			const f = this.fighterOf(seat);
			if (!f?.alive || f.bot) {
				rt.queue.length = 0;
				continue;
			}
			const frame = rt.queue.shift();
			if (frame) {
				commands.set(f.id, frameToCommands(frame));
				rt.ack = frame.seq;
				rt.sinceAck = 0;
			} else {
				rt.sinceAck = Math.min(255, rt.sinceAck + 1);
				if (rt.conn) this.metrics.inputStarvedTicks += 1;
			}
		}
		step(world, commands);
		if (this.finalizeDead()) this.persist();

		for (const seat of this.meta.seats) {
			const rt = this.runtime(seat.uid);
			if (!rt.conn) continue;
			this.sendSelf(seat, rt.conn, false);
			const snapshot = encodeSnapshot(world, world.events, {
				focusId: pickFocus(world, seat.fighterId, rt.spectateId),
				selfId: seat.fighterId,
				ack: rt.ack,
				sinceAck: rt.sinceAck,
				inputQueue: rt.queue.length
			});
			this.metrics.snapshots += 1;
			this.metrics.snapshotBytes += snapshot.byteLength;
			this.host.send(rt.conn, snapshot);
		}

		this.takeOverAbsent(now);
		if (world.tick % CHECKPOINT_EVERY_TICKS === 0) this.checkpoint();
		if (world.over || world.time >= MAX_MATCH_SECONDS) this.finish();
	}

	/** Everything time-driven that is not per tick (start, watchdog, grants, closing, cleanup). */
	async alarm(): Promise<void> {
		const now = this.host.now();
		const meta = this.meta;
		if (meta.state === 'waiting') {
			if (meta.seats.length > 0 && meta.startsAt !== null && now >= meta.startsAt) this.start();
			else if (meta.seats.length === 0 && meta.emptySince !== null && now >= meta.emptySince + EMPTY_ROOM_TTL_MS) {
				// Storage is gone; a later fresh ticket may open a new waiting room in the same instance.
				this.host.destroy();
				meta.state = 'empty';
				meta.emptySince = null;
			}
		} else if (meta.state === 'running') {
			this.takeOverAbsent(now);
			if (this.abandoned(now)) this.fastForward();
		}
		if (meta.state === 'running' || meta.state === 'ended') await this.retryGrants(now);
		if (meta.state === 'ended') this.cleanUp(now);
		this.schedule();
	}

	// ── Test hooks

	forceStart(): void {
		if (this.meta.state === 'waiting' && this.meta.seats.length > 0) this.start();
	}

	/** Runs the rest of the match without snapshots, as for an abandoned room. */
	fastForward(): void {
		const world = this._world;
		if (this.meta.state !== 'running' || !world) return;
		while (!world.over && world.time < MAX_MATCH_SECONDS) {
			step(world);
			this.finalizeDead();
		}
		this.finish();
	}

	debugState(): {
		state: MatchState;
		tick: number;
		seats: { uid: string; fighterId: number | null; connected: boolean; bot: boolean; final: SeatResult | null; outcome: SeatOutcome | null }[];
	} {
		return {
			state: this.meta.state,
			tick: this._world?.tick ?? 0,
			seats: this.meta.seats.map((s) => ({
				uid: s.uid,
				fighterId: s.fighterId,
				connected: this.runtime(s.uid).conn !== null,
				bot: this.fighterOf(s)?.bot != null,
				final: s.final,
				outcome: s.outcome
			}))
		};
	}

	// ── Seats and connections

	private static freshMetrics(): Metrics {
		return {
			firstTickAt: null,
			lastTickAt: null,
			intervals: [],
			lateTicks: 0,
			snapshots: 0,
			snapshotBytes: 0,
			inputsDropped: 0,
			inputStarvedTicks: 0,
			reconnects: 0,
			botTakeovers: 0
		};
	}

	private runtime(uid: string): SeatRuntime {
		let rt = this.runtimes.get(uid);
		if (!rt) {
			rt = { conn: null, queue: [], lastSeq: 0, ack: 0, sinceAck: 0, spectateId: null, selfKey: null, disconnectedAt: null, rtt: null, granting: false, retryAt: 0 };
			this.runtimes.set(uid, rt);
		}
		return rt;
	}

	private seatOf(conn: ConnId): Seat | undefined {
		const uid = this.connToUid.get(conn);
		return uid === undefined ? undefined : this.meta.seats.find((s) => s.uid === uid);
	}

	private fighterOf(seat: Seat): Fighter | undefined {
		return seat.fighterId === null ? undefined : this._world?.fighters.find((f) => f.id === seat.fighterId);
	}

	private link(conn: ConnId, uid: string): void {
		const rt = this.runtime(uid);
		rt.conn = conn;
		rt.disconnectedAt = null;
		rt.queue = [];
		rt.lastSeq = 0;
		rt.ack = 0;
		rt.sinceAck = 0;
		rt.selfKey = null;
		this.connToUid.set(conn, uid);
	}

	/** Same uid again: the newest connection wins, in any state. */
	private rejoin(conn: ConnId, seat: Seat): { code: CloseCode; reason: string } | null {
		if (this.meta.aborted) return { code: Close.ServerError, reason: 'match aborted' };
		const rt = this.runtime(seat.uid);
		const old = rt.conn;
		if (old !== null && old !== conn) {
			this.connToUid.delete(old);
			this.host.close(old, Close.Replaced, 'replaced by a new connection');
		}
		this.link(conn, seat.uid);

		if (this.meta.state === 'waiting') this.broadcastLobby();
		else if (this.meta.state === 'running') {
			this.metrics.reconnects += 1;
			const f = this.fighterOf(seat);
			if (f?.alive && f.bot) setBotControl(this._world!, f.id, false);
			if (!seat.final) seat.locked = null;
			seat.left = false;
			this.persist();
			this.sendStart(conn, seat);
			this.sendSelf(seat, conn, true);
			this.sendResult(seat);
			this.schedule();
		} else {
			this.sendResult(seat);
			this.send(conn, { t: 'end', winner: this.meta.winner });
			if (this.socketsClosed) this.host.close(conn, Close.Normal, 'match ended');
		}
		return null;
	}

	private removeWaitingSeat(seat: Seat): void {
		this.meta.seats = this.meta.seats.filter((s) => s !== seat);
		this.runtimes.delete(seat.uid);
		if (this.meta.seats.length === 0) {
			this.meta.startsAt = null;
			this.meta.emptySince = this.host.now();
		}
		this.persist();
		this.broadcastLobby();
		this.schedule();
	}

	private textMessage(seat: Seat, text: string): void {
		const msg = parseClientMessage(text);
		if (!msg) return;
		const rt = this.runtime(seat.uid);
		if (msg.t === 'stats') rt.rtt = msg.rtt;
		else if (msg.t === 'spectate') rt.spectateId = msg.id;
		else if (this.meta.state === 'waiting') {
			const conn = rt.conn;
			if (conn) {
				this.connToUid.delete(conn);
				this.host.close(conn, Close.Normal, 'left');
			}
			this.removeWaitingSeat(seat);
		} else if (this.meta.state === 'running') {
			seat.left = true;
			this.takeOver(seat);
			this.persist();
		}
	}

	private inputMessage(seat: Seat, data: ArrayBuffer): void {
		if (this.meta.state !== 'running') return;
		const frame = decodeInput(data);
		const f = this.fighterOf(seat);
		if (!frame || !f?.alive || f.bot) return;
		const rt = this.runtime(seat.uid);
		if (frame.seq <= rt.lastSeq) return;
		rt.lastSeq = frame.seq;
		rt.queue.push(frame);
		if (rt.queue.length > INPUT_QUEUE_MAX) {
			const dropped = rt.queue.shift()!;
			mergeOneShots(rt.queue[0]!, dropped);
			this.metrics.inputsDropped += 1;
		}
	}

	// ── Messages out

	private send(conn: ConnId, msg: ServerMessage): void {
		this.host.send(conn, JSON.stringify(msg));
	}

	private broadcastLobby(): void {
		const { seats, startsAt, matchId } = this.meta;
		const serverNow = this.host.now();
		for (const seat of seats) {
			const conn = this.runtime(seat.uid).conn;
			if (!conn) continue;
			this.send(conn, {
				t: 'lobby',
				matchId,
				players: seats.map((s) => ({ name: s.name, you: s.uid === seat.uid })),
				max: MAX_HUMANS,
				startsAt,
				serverNow
			});
		}
	}

	private sendStart(conn: ConnId, seat: Seat): void {
		const world = this._world;
		if (!world) return;
		const humanIds = new Set(this.meta.seats.map((s) => s.fighterId));
		this.send(conn, {
			t: 'start',
			matchId: this.meta.matchId,
			tick: world.tick,
			you: seat.fighterId,
			fighters: world.fighters.map((f) => ({ id: f.id, name: f.name, color: f.color, human: humanIds.has(f.id) }))
		});
	}

	private sendSelf(seat: Seat, conn: ConnId, force: boolean): void {
		const f = this.fighterOf(seat);
		if (!f) return;
		const rt = this.runtime(seat.uid);
		const self = { items: f.items, runes: f.runes, offer: f.offer, pendingDrafts: f.pendingDrafts, rerolls: f.rerolls, exchangeTokens: f.exchangeTokens };
		const key = JSON.stringify(self);
		if (!force && key === rt.selfKey) return;
		rt.selfKey = key;
		this.send(conn, { t: 'self', ...self });
	}

	/** The seat's result, once its grant has an outcome; to the connection if there is one. */
	private sendResult(seat: Seat): void {
		const conn = this.runtime(seat.uid).conn;
		const { final, outcome } = seat;
		if (!conn || !final || !outcome) return;
		const msg: ResultMessage = {
			t: 'result',
			placement: final.placement,
			kills: final.kills,
			level: final.level,
			time: final.time,
			reward: outcome.reward,
			coins: outcome.coins,
			best: outcome.best,
			newBest: outcome.newBest,
			rewardPending: outcome.status === 'pending'
		};
		this.send(conn, msg);
	}

	// ── Lifecycle

	private start(): void {
		const seed = this.host.random32();
		const { world, humanIds } = createWorld({
			seed,
			fighters: MATCH_FIGHTERS,
			humans: this.meta.seats.map((s) => ({ name: s.name, runes: s.runes }))
		});
		this._world = world;
		this.meta.seats.forEach((seat, i) => (seat.fighterId = humanIds[i]!));
		this.meta.state = 'running';
		this.meta.seed = seed;
		this.meta.startedAt = this.host.now();
		this.meta.startsAt = null;
		this.metrics = MatchCore.freshMetrics();
		for (const seat of this.meta.seats) if (!this.runtime(seat.uid).conn) this.takeOver(seat);
		this.host.save(this.meta, checkpointWorld(world));
		for (const seat of this.meta.seats) {
			const conn = this.runtime(seat.uid).conn;
			if (!conn) continue;
			this.sendStart(conn, seat);
			this.sendSelf(seat, conn, true);
		}
		this.host.log({ event: 'match_start', matchId: this.meta.matchId, humans: this.meta.seats.length, seed });
		this.schedule();
	}

	private restore(checkpoint: WorldCheckpoint | null, now: number): void {
		const meta = this.meta;
		meta.restores += 1;
		this.host.log({ event: 'match_restore', matchId: meta.matchId, tick: checkpoint?.tick ?? null, crashes: meta.crashes });
		if (!checkpoint || meta.crashes > MAX_TICK_CRASHES) {
			this.abort(now);
			return;
		}
		this._world = restoreWorld(checkpoint);
		this.awaitingCheckpoint = true;
		for (const seat of meta.seats) this.runtime(seat.uid).disconnectedAt = now;
		this.persist();
	}

	/** Unrecoverable: end without rewards for seats that have no result yet. */
	private abort(now: number): void {
		const meta = this.meta;
		meta.state = 'ended';
		meta.aborted = true;
		meta.endedAt = now;
		this.socketsClosed = true;
		for (const conn of this.connToUid.keys()) this.host.close(conn, Close.ServerError, 'match aborted');
		this.host.log({ event: 'match_abort', matchId: meta.matchId, crashes: meta.crashes });
		this.host.save(meta, null);
	}

	/** A planned restart (the standalone server's SIGTERM): checkpoint the current tick so the restore resumes here. */
	checkpointNow(): void {
		if (this.meta.state === 'running' && this._world && !this.cleaned) this.checkpoint();
	}

	private checkpoint(): void {
		if (this.awaitingCheckpoint) {
			this.awaitingCheckpoint = false;
			this.meta.crashes = 0;
		}
		this.host.save(this.meta, checkpointWorld(this._world!));
	}

	private persist(): void {
		if (!this.cleaned) this.host.save(this.meta);
	}

	// ── AI takeover and results

	/** Hands the seat's fighter to the AI and records what the human had achieved by now. */
	private takeOver(seat: Seat): boolean {
		const world = this._world;
		const f = this.fighterOf(seat);
		if (!world || !f?.alive || f.bot) return false;
		setBotControl(world, f.id, true);
		seat.locked = {
			placement: world.fighters.filter((x) => x.alive).length,
			kills: f.kills,
			level: f.level,
			time: world.time,
			leftEarly: true
		};
		this.metrics.botTakeovers += 1;
		return true;
	}

	private takeOverAbsent(now: number): void {
		let changed = false;
		for (const seat of this.meta.seats) {
			const at = this.runtime(seat.uid).disconnectedAt;
			if (at === null || now - at < DISCONNECT_GRACE_MS || seat.locked || seat.final) continue;
			changed = this.takeOver(seat) || changed;
		}
		if (changed) this.persist();
	}

	private abandoned(now: number): boolean {
		return this.meta.seats.every((s) => {
			const at = this.runtime(s.uid).disconnectedAt;
			return at !== null && now - at >= ABANDON_MS;
		});
	}

	/** Fixes the result of every seat whose fighter has died. True when any changed. */
	private finalizeDead(): boolean {
		const world = this._world!;
		let changed = false;
		for (const seat of this.meta.seats) {
			const f = this.fighterOf(seat);
			if (seat.final || !f || f.alive) continue;
			this.setFinal(seat, seat.locked ?? { placement: f.placement ?? MATCH_FIGHTERS, kills: f.kills, level: f.level, time: world.time, leftEarly: false });
			changed = true;
		}
		return changed;
	}

	private pendingOutcome(result: SeatResult): SeatOutcome {
		const reward = scoreMatch({ placement: result.placement, fighters: MATCH_FIGHTERS, kills: result.kills, level: result.level, time: result.time });
		return { reward, coins: null, best: null, newBest: false, status: 'pending', attempts: 0 };
	}

	private setFinal(seat: Seat, result: SeatResult): void {
		seat.final = result;
		seat.outcome = this.pendingOutcome(result);
		void this.grant(seat);
	}

	/** One grant attempt. Never awaited by the tick loop; failures are retried from alarm(). */
	private async grant(seat: Seat): Promise<void> {
		const rt = this.runtime(seat.uid);
		const { final, outcome } = seat;
		if (rt.granting || !final || !outcome || outcome.status !== 'pending') return;
		rt.granting = true;
		try {
			const granted = await this.host.grant({ matchId: this.meta.matchId, uid: seat.uid, result: final, score: outcome.reward.score, coins: outcome.reward.coins });
			seat.outcome = {
				...outcome,
				coins: granted.coins,
				best: granted.best,
				newBest: outcome.reward.score > granted.prevBest,
				status: 'granted',
				attempts: outcome.attempts + 1
			};
			this.persist();
			this.sendResult(seat);
		} catch (err) {
			const attempts = outcome.attempts + 1;
			outcome.attempts = attempts;
			rt.retryAt = this.host.now() + GRANT_RETRY_MS;
			if (attempts >= MAX_GRANT_ATTEMPTS) outcome.status = 'failed';
			this.host.log({ event: 'grant_error', matchId: this.meta.matchId, uid: seat.uid, attempt: attempts, message: err instanceof Error ? err.message : String(err) });
			this.persist();
			if (attempts === 1) this.sendResult(seat);
		} finally {
			rt.granting = false;
			this.schedule();
		}
	}

	private async retryGrants(now: number): Promise<void> {
		const due = this.meta.seats.filter((s) => s.outcome?.status === 'pending' && this.runtime(s.uid).retryAt <= now);
		await Promise.all(due.map((s) => this.grant(s)));
	}

	private finish(): void {
		const world = this._world!;
		const meta = this.meta;
		const now = this.host.now();
		const survivors = world.fighters.filter((f) => f.alive).length;
		for (const seat of meta.seats) {
			const f = this.fighterOf(seat);
			if (seat.final || !f) continue;
			// Alive at the end: the winner, or (at the time cap) one of the survivors.
			const placement = world.over ? (f.placement ?? 1) : survivors;
			this.setFinal(seat, seat.locked ?? { placement, kills: f.kills, level: f.level, time: world.time, leftEarly: false });
		}
		meta.state = 'ended';
		meta.endedAt = now;
		meta.winner = world.winner;
		this.host.save(meta, null);
		for (const seat of meta.seats) {
			const conn = this.runtime(seat.uid).conn;
			if (conn) this.send(conn, { t: 'end', winner: world.winner });
		}
		const winnerUid = meta.seats.find((s) => s.fighterId !== null && s.fighterId === world.winner)?.uid ?? null;
		void this.record({
			matchId: meta.matchId,
			seed: meta.seed!,
			startedAt: meta.startedAt!,
			endedAt: now,
			durationS: world.time,
			humans: meta.seats.length,
			winnerUid
		});
		this.logMatchEnd(world);
		this.schedule();
	}

	private async record(summary: Parameters<MatchHost['recordMatch']>[0]): Promise<void> {
		try {
			await this.host.recordMatch(summary);
		} catch (err) {
			this.host.log({ event: 'record_error', matchId: summary.matchId, message: err instanceof Error ? err.message : String(err) });
		}
	}

	private recordInterval(now: number): void {
		const m = this.metrics;
		if (m.lastTickAt !== null) {
			const interval = now - m.lastTickAt;
			m.intervals.push(interval);
			if (interval > LATE_TICK_MS) m.lateTicks += 1;
		} else m.firstTickAt = now;
		m.lastTickAt = now;
	}

	private logMatchEnd(world: World): void {
		const m = this.metrics;
		const sorted = [...m.intervals].sort((a, b) => a - b);
		const elapsedTicks = m.firstTickAt === null || m.lastTickAt === null ? 0 : Math.round((m.lastTickAt - m.firstTickAt) / TICK_MS);
		const reports = this.meta.seats.flatMap((s) => {
			const rtt = this.runtime(s.uid).rtt;
			return rtt ? [rtt] : [];
		});
		this.host.log({
			event: 'match_end',
			matchId: this.meta.matchId,
			durationS: world.time,
			ticks: world.tick,
			humans: this.meta.seats.length,
			tickIntervalMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1] ?? 0 },
			lateTicks: m.lateTicks,
			skippedTicks: Math.max(0, elapsedTicks - m.intervals.length),
			snapshotBytesAvg: m.snapshots === 0 ? 0 : Math.round(m.snapshotBytes / m.snapshots),
			inputsDropped: m.inputsDropped,
			inputStarvedTicks: m.inputStarvedTicks,
			reconnects: m.reconnects,
			botTakeovers: m.botTakeovers,
			restores: this.meta.restores,
			rtt: { p50: median(reports.map((r) => r.p50)), p95: median(reports.map((r) => r.p95)) }
		});
	}

	// ── Ended: linger, cleanup

	private cleanUp(now: number): void {
		const meta = this.meta;
		if (this.cleaned || meta.endedAt === null) return;
		if (!this.socketsClosed && now >= meta.endedAt + END_LINGER_MS) {
			this.socketsClosed = true;
			for (const conn of this.connToUid.keys()) this.host.close(conn, Close.Normal, 'match ended');
		}
		const paying = meta.seats.some((s) => s.outcome?.status === 'pending');
		if (!paying && now >= meta.endedAt + CLEANUP_AFTER_END_MS) {
			this.cleaned = true;
			this.host.destroy();
		}
	}

	/** Sets the single alarm to the earliest deadline of the current state (§5.11). */
	private schedule(): void {
		if (this.cleaned) return;
		const meta = this.meta;
		const deadlines: number[] = [];
		if (meta.state === 'waiting') {
			if (meta.seats.length > 0 && meta.startsAt !== null) deadlines.push(meta.startsAt);
			else if (meta.emptySince !== null) deadlines.push(meta.emptySince + EMPTY_ROOM_TTL_MS);
		} else if (meta.state === 'running') deadlines.push(this.host.now() + WATCHDOG_MS);
		else if (meta.state === 'ended' && meta.endedAt !== null) {
			if (!this.socketsClosed) deadlines.push(meta.endedAt + END_LINGER_MS);
			const retries = meta.seats.filter((s) => s.outcome?.status === 'pending' && !this.runtime(s.uid).granting);
			for (const s of retries) deadlines.push(this.runtime(s.uid).retryAt);
			// A grant in flight reschedules when it settles.
			if (!meta.seats.some((s) => s.outcome?.status === 'pending')) deadlines.push(meta.endedAt + CLEANUP_AFTER_END_MS);
		}
		this.host.setAlarm(deadlines.length === 0 ? null : Math.min(...deadlines));
	}
}
