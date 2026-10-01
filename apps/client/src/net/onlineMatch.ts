import {
	Close,
	ServerClock,
	SnapshotBuffer,
	Predictor,
	TICK_MS,
	decodeSnapshot,
	emptyFrame,
	encodeInput,
	motionFromSelf,
	motionStats,
	parseServerMessage,
	quantizeDir,
	type ClientMessage,
	type MotionStats,
	type ResultMessage,
	type RosterEntry,
	type SelfMessage,
	type SelfState,
	type Snapshot
} from '@ofa/net';
import { summarizeBuild, type Command, type Fighter, type GameEvent, type Vec2 } from '@ofa/sim';
import { ApiRequestError, type ApiClient } from './api';
import { MatchConnection, type SocketLike } from './connection';
import { ViewWorldBuilder, type ViewWorld } from './viewWorld';

/** One online match from the client's side: connection, local ticks, prediction, view (§11, §12). */

export type OnlinePhase = 'idle' | 'connecting' | 'waiting' | 'running' | 'ended' | 'error';

export interface LobbyView {
	players: { name: string; you: boolean }[];
	max: number;
	/** Remaining time when the message arrived, on the server's clock; null until the countdown starts. */
	startsInMs: number | null;
}

export type OnlineErrorCode = 'full' | 'started' | 'ended' | 'version' | 'server' | 'network' | 'unauthorized' | 'closed';

export interface OnlineCallbacks {
	onLobby(l: LobbyView): void;
	onStart(): void;
	/** Events to feed renderer, HUD and sound, already in dispatch order (§11.5). */
	onEvents(events: readonly GameEvent[]): void;
	onSelfDied(): void;
	onResult(r: ResultMessage): void;
	onEnd(winner: number | null): void;
	onConnection(state: 'open' | 'reconnecting'): void;
	onError(code: OnlineErrorCode, message: string): void;
}

export interface ViewFrame {
	world: ViewWorld;
	prev: Map<number, Vec2>;
	alpha: number;
	focusId: number | null;
	me: Fighter | undefined;
	focus: Fighter | undefined;
}

export interface NetStats {
	rttP50: number | null;
	rttP95: number | null;
	jitterMs: number;
	inputQueue: number;
	snapshotsPerSecond: number;
	tickMs: number;
}

export interface OnlineDeps {
	createSocket?: (url: string) => SocketLike;
	now?: () => number;
}

const FIGHTER_RADIUS = 0.7;
const MAX_CATCH_UP_TICKS = 5;
const QUEUE_EMA_ALPHA = 0.1;
/** Retries of a quickplay whose match had already started (§4). */
const MAX_STARTED_RETRIES = 3;
const SNAPSHOT_RATE_WINDOW_MS = 1000;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

/** Events the local player caused: shown on arrival instead of waiting for the interpolation delay (§11.5). */
function isOwnEvent(e: GameEvent, selfId: number | null): boolean {
	if (selfId === null) return false;
	switch (e.type) {
		case 'attack':
		case 'dash':
		case 'levelUp':
		case 'synergy':
		case 'pickup':
			return e.unit === selfId;
		case 'hit':
			return e.src === selfId;
		default:
			return false;
	}
}

interface OneShots {
	attack: boolean;
	dash: Vec2 | null;
	dashTouch: boolean;
	draft: number | null;
	reroll: boolean;
	exchange: number | null;
}

const noOneShots = (): OneShots => ({ attack: false, dash: null, dashTouch: false, draft: null, reroll: false, exchange: null });

export class OnlineMatch {
	private readonly createSocket: ((url: string) => SocketLike) | undefined;
	private readonly now: () => number;
	private readonly builder = new ViewWorldBuilder();
	private readonly buffer = new SnapshotBuffer();
	private readonly clock = new ServerClock();
	private readonly predictor = new Predictor();
	private conn: MatchConnection | null = null;
	private _phase: OnlinePhase = 'idle';
	private _selfId: number | null = null;
	/** Bumped by every start/leave/dispose so a stale quickplay reply is dropped. */
	private generation = 0;
	private startedRetries = 0;

	private roster: RosterEntry[] = [];
	private deadFighters = new Set<number>();
	private spectateId: number | null = null;
	private selfMsg: SelfMessage | null = null;
	private selfState: SelfState | null = null;
	private stats: MotionStats = motionStats(summarizeBuild([], []), FIGHTER_RADIUS);
	private sawSelf = false;
	private selfDead = false;
	private statsSent = false;

	private heldDir: Vec2 | null = null;
	private run = false;
	private oneShots = noOneShots();
	private seq = 0;
	private lastFrameMs: number | null = null;
	private accMs = 0;
	private queueEma = 1;
	private inputQueue = 0;
	private lastDispatched = -1;
	private arrivals: number[] = [];

	constructor(
		private readonly api: ApiClient,
		private readonly cb: OnlineCallbacks,
		deps: OnlineDeps = {}
	) {
		this.createSocket = deps.createSocket;
		this.now = deps.now ?? (() => performance.now());
	}

	get phase(): OnlinePhase {
		return this._phase;
	}

	get selfId(): number | null {
		return this._selfId;
	}

	/** quickplay → connect. A 4003 (started) close retries with a fresh quickplay up to 3 times. */
	async start(): Promise<void> {
		this.closeConnection();
		this.resetMatchState();
		this.deadFighters = new Set();
		this.roster = [];
		this.spectateId = null;
		this._selfId = null;
		this.statsSent = false;
		this.startedRetries = 0;
		this._phase = 'connecting';
		await this.connect();
	}

	command(c: Command): void {
		switch (c.type) {
			case 'move':
				this.heldDir = c.dir ? quantizeDir(c.dir) : null;
				this.run = c.run;
				return;
			case 'attack':
				if (this._phase === 'running') this.oneShots.attack = true;
				return;
			case 'dash':
				if (this._phase !== 'running') return;
				this.oneShots.dash = quantizeDir(c.dir);
				this.oneShots.dashTouch = c.touch ?? false;
				return;
			case 'draft':
				if (this._phase === 'running') this.oneShots.draft = c.index;
				return;
			case 'reroll':
				if (this._phase === 'running') this.oneShots.reroll = true;
				return;
			case 'exchange':
				if (this._phase === 'running') this.oneShots.exchange = c.itemIndex;
				return;
		}
	}

	spectate(fighterId: number): void {
		this.spectateId = fighterId;
		this.send({ t: 'spectate', id: fighterId });
	}

	/** Next living fighter by id after the current focus (living = roster minus fighter deaths seen). */
	spectateNext(): void {
		const focus = this.spectateId ?? this.buffer.latest()?.focusId ?? -1;
		const living = this.roster.map((r) => r.id).filter((id) => !this.deadFighters.has(id)).sort((a, b) => a - b);
		const next = living.find((id) => id > focus) ?? living[0];
		if (next !== undefined) this.spectate(next);
	}

	leave(): void {
		this.generation++;
		this.send({ t: 'leave' });
		this.closeConnection(Close.Normal);
		this._phase = 'ended';
	}

	/** Once per animation frame: run local ticks, build what to draw. null until the match runs. */
	frame(nowMs: number): ViewFrame | null {
		if ((this._phase !== 'running' && this._phase !== 'ended') || this.buffer.latest() === null) return null;
		const dtMs = this.lastFrameMs === null ? 0 : Math.max(0, nowMs - this.lastFrameMs);
		this.lastFrameMs = nowMs;
		if (this._phase === 'running' && this._selfId !== null && !this.selfDead) this.runLocalTicks(dtMs);

		const renderTick = this.clock.renderTick(nowMs);
		const due = this.buffer.between(this.lastDispatched, renderTick);
		if (due.length > 0) {
			this.lastDispatched = due[due.length - 1].tick;
			const events = due.flatMap((s) => s.events);
			if (events.length > 0) this.cb.onEvents(events);
		}

		const sample = this.buffer.sample(renderTick);
		if (!sample) return null;
		const motion = this.predictor.state;
		const displayPos = this.predictor.displayPos(dtMs / 1000, this.accMs / this.tickMs());
		const own = this.selfState && motion ? { self: this.selfState, build: this.selfMsg, motion, displayPos } : null;
		const { world, prev, alpha } = this.builder.build(sample, this._selfId, own);
		const find = (id: number | null) => (id === null ? undefined : world.fighters.find((f) => f.id === id));
		const focusId = sample.b.focusId;
		return { world, prev, alpha, focusId, me: find(this._selfId), focus: find(focusId) };
	}

	netStats(): NetStats {
		const rtts = [...(this.conn?.rtts ?? [])].sort((a, b) => a - b);
		const now = this.now();
		return {
			rttP50: rtts.length ? percentile(rtts, 0.5) : null,
			rttP95: rtts.length ? percentile(rtts, 0.95) : null,
			jitterMs: this.clock.jitterMs,
			inputQueue: this.inputQueue,
			snapshotsPerSecond: this.arrivals.filter((t) => now - t < SNAPSHOT_RATE_WINDOW_MS).length,
			tickMs: this.tickMs()
		};
	}

	dispose(): void {
		this.generation++;
		this.closeConnection();
		this._phase = 'idle';
	}

	private tickMs(): number {
		return TICK_MS * (1 + clamp(0.02 * (this.queueEma - 1), -0.05, 0.05));
	}

	private runLocalTicks(dtMs: number): void {
		this.accMs += dtMs;
		const tickMs = this.tickMs();
		let ticks = 0;
		while (this.accMs >= tickMs && ticks < MAX_CATCH_UP_TICKS) {
			this.accMs -= tickMs;
			this.localTick();
			ticks++;
		}
		// After a stall, drop the backlog instead of bursting through it later.
		if (ticks === MAX_CATCH_UP_TICKS) this.accMs = 0;
	}

	private localTick(): void {
		const f = emptyFrame(++this.seq);
		const s = this.oneShots;
		f.move = this.heldDir;
		f.run = this.run;
		f.attack = s.attack;
		f.dash = s.dash;
		f.dashTouch = s.dashTouch;
		f.draft = s.draft;
		f.reroll = s.reroll;
		f.exchange = s.exchange;
		this.oneShots = noOneShots();
		this.conn?.sendBinary(encodeInput(f));
		this.predictor.push(f, this.stats);
	}

	private resetMatchState(): void {
		this.buffer.clear();
		this.clock.reset();
		this.predictor.clear();
		this.selfMsg = null;
		this.selfState = null;
		this.stats = motionStats(summarizeBuild([], []), FIGHTER_RADIUS);
		this.sawSelf = false;
		this.selfDead = false;
		this.oneShots = noOneShots();
		this.seq = 0;
		this.lastFrameMs = null;
		this.accMs = 0;
		this.queueEma = 1;
		this.inputQueue = 0;
		this.lastDispatched = -1;
		this.arrivals = [];
	}

	private send(m: ClientMessage): void {
		this.conn?.sendText(JSON.stringify(m));
	}

	private closeConnection(code?: number): void {
		this.conn?.close(code);
		this.conn = null;
	}

	private async connect(): Promise<void> {
		const gen = ++this.generation;
		try {
			const q = await this.api.quickplay();
			if (gen !== this.generation) return;
			this.conn = new MatchConnection(
				this.api.wsUrl(q.matchId, q.ticket, q.server),
				{
					onOpen: () => this.cb.onConnection('open'),
					onText: (t) => this.onText(t),
					onBinary: (d) => this.onBinary(d),
					onClosed: (code, reason) => this.onClosed(code, reason),
					onReconnecting: () => this.cb.onConnection('reconnecting')
				},
				{ createSocket: this.createSocket, now: this.now }
			);
			this.conn.open();
		} catch (e) {
			if (gen !== this.generation) return;
			if (e instanceof ApiRequestError && e.status === 401) this.fail('unauthorized', e.message);
			else if (e instanceof ApiRequestError && e.code === 'closed') this.fail('closed', e.message);
			else this.fail('network', e instanceof Error ? e.message : 'network error');
		}
	}

	private fail(code: OnlineErrorCode, message: string): void {
		this._phase = 'error';
		this.cb.onError(code, message);
	}

	private onClosed(code: number, reason: string): void {
		this.conn = null;
		if (this._phase === 'ended' || this._phase === 'idle') return;
		switch (code) {
			case Close.Normal:
				return;
			case Close.Started:
				if (this.startedRetries < MAX_STARTED_RETRIES) {
					this.startedRetries++;
					this._phase = 'connecting';
					void this.connect();
				} else this.fail('started', 'match already started');
				return;
			case Close.Full:
				return this.fail('full', 'match is full');
			case Close.Ended:
				return this.fail('ended', 'match has ended');
			case Close.Version:
				return this.fail('version', 'client is out of date, reload the page');
			case Close.Replaced:
				return this.fail('server', 'another tab took over this account');
			default:
				if (code >= 4000 && code <= 4999) return this.fail('server', reason || `closed (${code})`);
				return this.fail('network', 'connection lost');
		}
	}

	private onText(text: string): void {
		const m = parseServerMessage(text);
		if (!m) return;
		switch (m.t) {
			case 'lobby':
				if (this._phase !== 'connecting' && this._phase !== 'waiting') return;
				this._phase = 'waiting';
				this.cb.onLobby({
					players: m.players,
					max: m.max,
					startsInMs: m.startsAt === null ? null : Math.max(0, m.startsAt - m.serverNow)
				});
				return;
			case 'start': {
				// A returning player gets `start` again: rebuild state but don't announce a new match.
				const resumed = this._phase === 'running';
				this.resetMatchState();
				this.roster = m.fighters;
				this.builder.setRoster(m.fighters);
				this._selfId = m.you;
				this._phase = 'running';
				if (!resumed) this.cb.onStart();
				return;
			}
			case 'self':
				this.selfMsg = m;
				this.stats = motionStats(summarizeBuild(m.items, m.runes), FIGHTER_RADIUS);
				return;
			case 'result': {
				this.cb.onResult(m);
				const rtts = [...(this.conn?.rtts ?? [])].sort((a, b) => a - b);
				if (!this.statsSent && rtts.length > 0) {
					this.statsSent = true;
					this.send({ t: 'stats', rtt: { p50: percentile(rtts, 0.5), p95: percentile(rtts, 0.95), n: rtts.length } });
				}
				return;
			}
			case 'end':
				this._phase = 'ended';
				this.cb.onEnd(m.winner);
				return;
		}
	}

	private onBinary(data: ArrayBuffer): void {
		if (this._phase !== 'running') return;
		let snap: Snapshot;
		try {
			snap = decodeSnapshot(data);
		} catch {
			return;
		}
		if (this.buffer.latest()?.tick === snap.tick) return;
		if (this.buffer.push(snap) === 'reset') {
			this.clock.reset();
			this.predictor.clear();
			this.lastDispatched = snap.tick - 1;
		}
		const now = this.now();
		this.clock.onSnapshot(snap.tick, now);
		this.arrivals = this.arrivals.filter((t) => now - t < SNAPSHOT_RATE_WINDOW_MS);
		this.arrivals.push(now);
		this.inputQueue = snap.inputQueue;
		this.queueEma += (snap.inputQueue - this.queueEma) * QUEUE_EMA_ALPHA;

		const own: GameEvent[] = [];
		const later: GameEvent[] = [];
		for (const e of snap.events) {
			if (e.type === 'death' && e.kind === 'fighter') this.deadFighters.add(e.unit);
			(isOwnEvent(e, this._selfId) ? own : later).push(e);
		}
		snap.events = later;
		if (own.length > 0) this.cb.onEvents(own);

		if (snap.self) {
			this.sawSelf = true;
			this.selfState = snap.self;
			this.predictor.reconcile(motionFromSelf(snap.self), snap.ack, this.stats);
		} else if (this.sawSelf && !this.selfDead) {
			this.selfDead = true;
			this.selfState = null;
			this.predictor.clear();
			this.cb.onSelfDied();
		}
	}
}

