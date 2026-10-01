import { DurableObject } from 'cloudflare:workers';
import { Close, PING, PONG, TICK_MS } from '@ofa/net';
import type { WorldCheckpoint } from '@ofa/sim';
import { MatchCore } from './core';
import { grantReward, recordMatch } from './rewards';
import { MAX_CATCHUP_TICKS, SEAT_HEADER, decodeSeatHeader, type ConnId, type MatchHost, type MatchMeta } from './types';

interface Attachment {
	conn: ConnId;
	uid: string;
}

/** One authoritative match (docs/multiplayer-server-design.md §5): the Durable Object shell around MatchCore. */
export class MatchRoom extends DurableObject<Env> {
	private core!: MatchCore;
	private readonly sockets = new Map<ConnId, WebSocket>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nextTickAt = 0;
	private coloLogged = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		void ctx.blockConcurrencyWhile(async () => {
			const [meta, checkpoint] = await Promise.all([ctx.storage.get<MatchMeta>('meta'), ctx.storage.get<WorldCheckpoint>('checkpoint')]);
			// The match id is the room's own id (64 hex, MATCH_ID_PATTERN).
			this.core = new MatchCore(this.host(), ctx.id.toString(), meta ? { meta, checkpoint: checkpoint ?? null } : undefined);
			for (const ws of ctx.getWebSockets()) {
				const att = ws.deserializeAttachment() as Attachment | null;
				if (!att) continue;
				this.sockets.set(att.conn, ws);
				this.core.reattach(att.conn, att.uid);
			}
			this.sync();
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
		const claim = decodeSeatHeader(request.headers.get(SEAT_HEADER));
		if (!claim) return new Response('Missing or malformed seat', { status: 400 });

		const [client, server] = Object.values(new WebSocketPair());
		const conn = crypto.randomUUID();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ conn, uid: claim.uid } satisfies Attachment);
		this.sockets.set(conn, server);
		const rejection = this.core.join(conn, claim);
		if (rejection) {
			this.sockets.delete(conn);
			server.close(rejection.code, rejection.reason);
		}
		this.sync();
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const conn = this.connOf(ws);
		if (conn) this.core.message(conn, message);
	}

	webSocketClose(ws: WebSocket): void {
		this.dropSocket(ws);
	}

	webSocketError(ws: WebSocket): void {
		this.dropSocket(ws);
	}

	async alarm(): Promise<void> {
		await this.core.alarm();
		this.sync();
	}

	// ── Test-only RPC

	debugForceStart(): void {
		this.requireTestHooks();
		this.core.forceStart();
		this.sync();
	}

	debugFastForward(): void {
		this.requireTestHooks();
		this.core.fastForward();
		this.sync();
	}

	debugState(): ReturnType<MatchCore['debugState']> {
		this.requireTestHooks();
		return this.core.debugState();
	}

	private requireTestHooks(): void {
		if (this.env.TEST_HOOKS !== '1') throw new Error('test hooks are disabled');
	}

	// ── Sockets

	private connOf(ws: WebSocket): ConnId | null {
		return (ws.deserializeAttachment() as Attachment | null)?.conn ?? null;
	}

	private dropSocket(ws: WebSocket): void {
		const conn = this.connOf(ws);
		if (!conn) return;
		this.sockets.delete(conn);
		this.core.disconnect(conn);
		this.sync();
	}

	// ── Loop (§5.4)

	/** Runs the tick loop exactly while the match is running. */
	private sync(): void {
		const running = this.core.state === 'running';
		if (running && this.timer === null) {
			if (!this.coloLogged && this.core.world?.tick === 0) void this.logColo();
			this.nextTickAt = Date.now() + TICK_MS;
			this.timer = setTimeout(() => this.onTimer(), TICK_MS);
		} else if (!running && this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private onTimer(): void {
		this.timer = null;
		try {
			const now = Date.now();
			let n = 0;
			while (now >= this.nextTickAt && n < MAX_CATCHUP_TICKS && this.core.state === 'running') {
				this.core.tick();
				this.nextTickAt += TICK_MS;
				n += 1;
			}
			// More than the catch-up allowance behind: skip ahead instead of racing.
			if (now >= this.nextTickAt) this.nextTickAt = now + TICK_MS;
		} catch (err) {
			void this.crash(err);
			return;
		}
		if (this.core.state === 'running') this.timer = setTimeout(() => this.onTimer(), Math.max(0, this.nextTickAt - Date.now()));
	}

	/** A tick threw: remember it, then restart from the last checkpoint (fresh isolate state). */
	private async crash(err: unknown): Promise<void> {
		const meta = this.core.recordCrash();
		console.log(JSON.stringify({ event: 'tick_error', matchId: meta.matchId, message: err instanceof Error ? err.message : String(err) }));
		await this.ctx.storage.put('meta', meta);
		this.ctx.abort('tick failed');
	}

	private async logColo(): Promise<void> {
		this.coloLogged = true;
		if (this.env.TEST_HOOKS === '1') return;
		try {
			const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
			const colo = /^colo=(\w+)$/m.exec(text)?.[1];
			if (colo) this.host().log({ event: 'match_colo', matchId: this.ctx.id.toString(), colo });
		} catch {
			// Only a diagnostic.
		}
	}

	// ── MatchHost

	private host(): MatchHost {
		const { ctx, env } = this;
		return {
			now: () => Date.now(),
			send: (conn, data) => {
				try {
					this.sockets.get(conn)?.send(data);
				} catch {
					// Closed under us; the close event will follow.
				}
			},
			close: (conn, code, reason) => {
				try {
					this.sockets.get(conn)?.close(code, reason);
				} catch {
					// Already closed.
				}
				this.sockets.delete(conn);
			},
			save: (meta, checkpoint) => {
				const entries: Record<string, unknown> = { meta };
				if (checkpoint) entries.checkpoint = checkpoint;
				void ctx.storage.put(entries, { allowUnconfirmed: true });
				if (checkpoint === null) void ctx.storage.delete('checkpoint');
			},
			setAlarm: (at) => {
				if (at === null) void ctx.storage.deleteAlarm();
				else void ctx.storage.setAlarm(at, { allowUnconfirmed: true });
			},
			grant: (g) => grantReward(env.DB, g, Date.now()),
			recordMatch: (s) => recordMatch(env.DB, s),
			destroy: () => {
				for (const ws of ctx.getWebSockets()) {
					try {
						ws.close(Close.Normal, 'match cleaned up');
					} catch {
						// Already closed.
					}
				}
				this.sockets.clear();
				void ctx.storage.deleteAll();
			},
			log: (fields) => console.log(JSON.stringify(fields)),
			random32: () => crypto.getRandomValues(new Uint32Array(1))[0]!
		};
	}
}
