import { API, DATA_HASH, PROTOCOL_VERSION, type HealthResponse } from '@ofa/net';

export { Lobby } from './lobby';
export { MatchRoom } from './match/room';

/** HTTP entry (docs/multiplayer-server-design.md §7). Skeleton until T5. */
export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === API.health) {
			return Response.json({ ok: true, protocol: PROTOCOL_VERSION, dataHash: DATA_HASH } satisfies HealthResponse);
		}
		return Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
	}
} satisfies ExportedHandler<Env>;
