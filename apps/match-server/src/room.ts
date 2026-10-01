import { MatchCore, MessageBudget, TickLoop, type ConnId, type LoopTimers, type MatchHost, type SeatClaim } from '@ofa/match';
import { Close } from '@ofa/net';
import type { RoomStore, StoredRoom } from './store';
import type { WorkerApi } from './worker';

/** One WebSocket as the room sees it; the Bun adapter lives in server.ts. */
export interface RoomSocket {
	send(data: string | Uint8Array): void;
	close(code: number, reason: string): void;
}

export interface RoomDeps {
	store: RoomStore;
	worker: WorkerApi;
	log(fields: Record<string, unknown>): void;
	timers?: LoopTimers;
}

/** Close code for a planned restart or a tick crash: not 4xxx, so clients reconnect and resume (§6.4). */
export const CLOSE_RESTART = 1012;

const realTimers: LoopTimers = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
};

/**
 * One match on the standalone server: MatchCore plus the MatchHost that the Durable Object
 * used to provide (docs/match-server-oracle.md §5.2). Storage is the RoomStore, the alarm a
 * timer, rewards a signed call to the Worker.
 */
export class Room {
	private core!: MatchCore;
	private loop!: TickLoop;
	private readonly sockets = new Map<ConnId, RoomSocket>();
	private readonly budget = new MessageBudget<ConnId>();
	private readonly timers: LoopTimers;
	private alarm: unknown = null;
	private nextConn = 0;
	private gone = false;

	constructor(
		readonly id: string,
		private readonly deps: RoomDeps,
		/** Called once the match is over and cleaned up; the registry forgets the room. */
		private readonly onDestroyed: (room: Room) => void,
		stored?: StoredRoom
	) {
		this.timers = deps.timers ?? realTimers;
		this.boot(stored);
	}

	get state() {
		return this.core.state;
	}

	get connections(): number {
		return this.sockets.size;
	}

	/** Seats a socket; null when the core refused it (the socket is already closed with the reason). */
	join(socket: RoomSocket, claim: SeatClaim): ConnId | null {
		const conn = `c${++this.nextConn}`;
		this.sockets.set(conn, socket);
		const rejection = this.core.join(conn, claim);
		if (rejection) {
			this.sockets.delete(conn);
			socket.close(rejection.code, rejection.reason);
			this.loop.sync();
			return null;
		}
		this.loop.sync();
		return conn;
	}

	/** False when the connection blew its message budget and was closed. */
	message(conn: ConnId, data: string | ArrayBuffer): boolean {
		if (!this.sockets.has(conn)) return true;
		if (!this.budget.take(conn, this.timers.now())) {
			this.sockets.get(conn)?.close(Close.Flood, 'Too many messages');
			this.disconnect(conn);
			return false;
		}
		this.core.message(conn, data);
		this.loop.sync();
		return true;
	}

	/** The socket closed. Also after the core closed it itself (left, replaced): like the DO, the core ignores unknown conns. */
	disconnect(conn: ConnId): void {
		this.sockets.delete(conn);
		this.budget.forget(conn);
		if (this.gone) return;
		this.core.disconnect(conn);
		this.loop.sync();
	}

	/** Planned restart: checkpoint, then close every socket so clients reconnect to the next process. */
	shutdown(): void {
		this.core.checkpointNow();
		this.stopTimers();
		for (const s of this.sockets.values()) s.close(CLOSE_RESTART, 'server restarting');
		this.sockets.clear();
	}

	// ── Internals

	private boot(stored?: StoredRoom): void {
		this.core = new MatchCore(this.host(), this.id, stored);
		this.loop = new TickLoop(this.core, (err) => this.crash(err), this.timers);
		this.loop.sync();
	}

	/** A tick threw: count it, drop every socket and rebuild from the last checkpoint (the DO's ctx.abort). */
	private crash(err: unknown): void {
		const meta = this.core.recordCrash();
		this.deps.log({ event: 'tick_error', matchId: this.id, message: err instanceof Error ? err.message : String(err) });
		this.deps.store.save(this.id, meta);
		this.stopTimers();
		for (const s of this.sockets.values()) s.close(CLOSE_RESTART, 'match restarting');
		this.sockets.clear();
		const stored = this.deps.store.loadAll().get(this.id);
		if (stored) this.boot(stored);
		else this.destroyed();
	}

	private stopTimers(): void {
		this.loop.stop();
		if (this.alarm !== null) this.timers.clearTimeout(this.alarm);
		this.alarm = null;
	}

	private destroyed(): void {
		if (this.gone) return;
		this.gone = true;
		this.onDestroyed(this);
	}

	private host(): MatchHost {
		const { deps } = this;
		return {
			now: () => this.timers.now(),
			send: (conn, data) => this.sockets.get(conn)?.send(data),
			close: (conn, code, reason) => {
				this.sockets.get(conn)?.close(code, reason);
				this.sockets.delete(conn);
				this.budget.forget(conn);
			},
			save: (meta, checkpoint) => deps.store.save(this.id, meta, checkpoint),
			setAlarm: (at) => {
				if (this.alarm !== null) this.timers.clearTimeout(this.alarm);
				this.alarm = null;
				if (at === null) return;
				this.alarm = this.timers.setTimeout(
					() => {
						this.alarm = null;
						this.core
							.alarm()
							.catch((err) => deps.log({ event: 'alarm_error', matchId: this.id, message: err instanceof Error ? err.message : String(err) }))
							.finally(() => {
								if (!this.gone) this.loop.sync();
							});
					},
					Math.max(0, at - this.timers.now())
				);
			},
			grant: (g) => deps.worker.grant(g),
			recordMatch: (s) => deps.worker.recordMatch(s),
			destroy: () => {
				this.stopTimers();
				for (const s of this.sockets.values()) s.close(Close.Normal, 'match cleaned up');
				this.sockets.clear();
				deps.store.delete(this.id);
				this.destroyed();
			},
			log: (fields) => deps.log(fields),
			random32: () => crypto.getRandomValues(new Uint32Array(1))[0]!
		};
	}
}
