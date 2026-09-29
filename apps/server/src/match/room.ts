import { DurableObject } from 'cloudflare:workers';
import { Close } from '@ofa/net';

/** One authoritative match (docs/multiplayer-server-design.md §5). Skeleton until T6. */
export class MatchRoom extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		void request;
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.close(Close.ServerError, 'not implemented yet');
		return new Response(null, { status: 101, webSocket: client });
	}
}
