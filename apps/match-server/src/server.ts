import type { Server, ServerWebSocket } from 'bun';
import type { ConnId, SeatClaim } from '@ofa/match';
import { DATA_HASH, PING, PONG, PROTOCOL_VERSION } from '@ofa/net';
import { admit } from './admit';
import type { Config } from './config';
import type { Room } from './room';
import type { Rooms } from './rooms';

interface SocketData {
	matchId: string;
	claim: SeatClaim;
	ip: string;
	room: Room | null;
	conn: ConnId | null;
}

const MATCH_WS = /^\/match\/([^/]+)\/ws$/;
/** Snapshots for a socket this far behind are dropped rather than queued (a stalled phone must not grow memory). */
const MAX_BUFFERED_BYTES = 1 << 20;
/** Input frames are 12 bytes and control messages at most 512 (docs/multiplayer-server-design.md §10). */
const MAX_PAYLOAD_BYTES = 4096;

const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Behind Caddy the peer is loopback and the client is the first X-Forwarded-For hop; never trust the header otherwise. */
function clientIp(req: Request, server: Server<SocketData>): string {
	const peer = server.requestIP(req)?.address ?? 'unknown';
	const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
	if (!loopback) return peer;
	return req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || peer;
}

/** HTTP + WebSocket front of the match server (docs/match-server-oracle.md §6). */
export function startServer(config: Config, rooms: Rooms, log: (fields: Record<string, unknown>) => void): Server<SocketData> {
	const perIp = new Map<string, number>();
	const release = (ip: string) => {
		const n = (perIp.get(ip) ?? 1) - 1;
		if (n <= 0) perIp.delete(ip);
		else perIp.set(ip, n);
	};

	return Bun.serve<SocketData>({
		hostname: config.host,
		port: config.port,
		async fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === '/health') {
				return Response.json({ ok: true, release: config.release, protocol: PROTOCOL_VERSION, dataHash: DATA_HASH, ...rooms.stats() });
			}
			const m = MATCH_WS.exec(url.pathname);
			if (!m || req.method !== 'GET') return text(404, 'Not found');
			const a = await admit({
				matchId: m[1]!,
				query: url.searchParams,
				upgrade: req.headers.get('Upgrade'),
				origin: req.headers.get('Origin'),
				allowedOrigins: config.allowedOrigins,
				ticketSecret: config.ticketSecret,
				now: Date.now()
			});
			if (!a.ok) return text(a.status, a.message);
			const ip = clientIp(req, server);
			if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) return text(429, 'Too many connections');
			perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
			if (server.upgrade(req, { data: { matchId: m[1]!, claim: a.claim, ip, room: null, conn: null } })) return undefined;
			release(ip);
			return text(400, 'Upgrade failed');
		},
		websocket: {
			maxPayloadLength: MAX_PAYLOAD_BYTES,
			idleTimeout: 60,
			open(ws) {
				const room = rooms.open(ws.data.matchId);
				ws.data.room = room;
				ws.data.conn = room.join(adapt(ws), ws.data.claim);
			},
			message(ws, message) {
				if (message === PING) {
					ws.send(PONG);
					return;
				}
				const { room, conn } = ws.data;
				if (!room || !conn) return;
				// Bun hands binary frames over as Buffer; the core wants the exact ArrayBuffer bytes.
				const data = typeof message === 'string' ? message : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
				room.message(conn, data as ArrayBuffer);
			},
			close(ws) {
				release(ws.data.ip);
				const { room, conn } = ws.data;
				if (room && conn) room.disconnect(conn);
			}
		},
		error(err) {
			log({ event: 'http_error', message: err.message });
			return text(500, 'Internal error');
		}
	});
}

function adapt(ws: ServerWebSocket<SocketData>) {
	return {
		send(data: string | Uint8Array) {
			if (typeof data !== 'string' && ws.getBufferedAmount() > MAX_BUFFERED_BYTES) return;
			ws.send(data);
		},
		close(code: number, reason: string) {
			try {
				ws.close(code, reason);
			} catch {
				// Already closed.
			}
		}
	};
}
