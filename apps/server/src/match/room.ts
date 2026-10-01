import { DurableObject } from 'cloudflare:workers';
import { MatchCore, MessageBudget, SEAT_HEADER, TickLoop, decodeSeatHeader, type ConnId, type MatchHost, type MatchMeta } from '@ofa/match';
import { Close, PING, PONG } from '@ofa/net';
import type { WorldCheckpoint } from '@ofa/sim';
import { grantReward, recordMatch } from './rewards';

interface Attachment {
	conn: ConnId;
	uid: string;
}

/** One authoritative match (docs/multiplayer-server-design.md §5): the Durable Object shell around MatchCore. */
export class MatchRoom extends DurableObject<Env> {
	private core!: MatchCore;
	private readonly sockets = new Map<ConnId, WebSocket>();
	private readonly budget = new MessageBudget<ConnId>();
	private loop!: TickLoop;
	private coloLogged = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		void ctx.blockConcurrencyWhile(async () => {
			const [meta, checkpoint] = await Promise.all([ctx.storage.get<MatchMeta>('meta'), ctx.storage.get<WorldCheckpoint>('checkpoint')]);
			// The match id is the room's own id (64 hex, MATCH_ID_PATTERN).
			this.core = new MatchCore(this.host(), ctx.id.toString(), meta ? { meta, checkpoint: checkpoint ?? null } : undefined);
			this.loop = new TickLoop(this.core, (err) => void this.crash(err));
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
		if (!conn) return;
		// Every message is billed (20 messages = 1 request), so one socket must not be able to burn the quota.
		if (!this.budget.take(conn, Date.now())) {
			ws.close(Close.Flood, 'Too many messages');
			this.dropSocket(ws);
			return;
		}
		this.core.message(conn, message);
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
		this.budget.forget(conn);
		this.sockets.delete(conn);
		this.core.disconnect(conn);
		this.sync();
	}

	// ── Loop (§5.4)

	/** Runs the tick loop exactly while the match is running. */
	private sync(): void {
		if (!this.coloLogged && this.core.state === 'running' && this.core.world?.tick === 0) void this.logColo();
		this.loop.sync();
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
