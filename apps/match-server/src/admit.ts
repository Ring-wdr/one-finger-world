import { verifyTicket, type SeatClaim } from '@ofa/match';
import { DATA_HASH, MATCH_ID_PATTERN, PROTOCOL_VERSION } from '@ofa/net';

export type Admission = { ok: true; claim: SeatClaim } | { ok: false; status: number; message: string };

const no = (status: number, message: string): Admission => ({ ok: false, status, message });

/**
 * The checks the Worker's matchWs route makes before forwarding to a Durable Object, in the
 * same order (docs/match-server-oracle.md §6.1). Pure, so it is tested without a socket.
 */
export async function admit(opts: {
	matchId: string;
	query: URLSearchParams;
	upgrade: string | null;
	origin: string | null;
	allowedOrigins: readonly string[];
	ticketSecret: string;
	now: number;
}): Promise<Admission> {
	if (opts.upgrade?.toLowerCase() !== 'websocket') return no(426, 'Expected a WebSocket upgrade');
	if (!MATCH_ID_PATTERN.test(opts.matchId)) return no(404, 'No such match');
	// Browsers always send Origin; tools (loadtest) may not.
	if (opts.origin !== null && !opts.allowedOrigins.includes('*') && !opts.allowedOrigins.includes(opts.origin)) return no(403, 'Origin not allowed');
	if (opts.query.get('v') !== String(PROTOCOL_VERSION) || opts.query.get('h') !== DATA_HASH) return no(409, 'Client version mismatch');
	const claims = await verifyTicket(opts.ticketSecret, opts.query.get('ticket') ?? '', opts.now);
	if (!claims || claims.mid !== opts.matchId) return no(401, 'Invalid ticket');
	return { ok: true, claim: { uid: claims.sub, name: claims.name, runes: claims.runes, iat: claims.iat } };
}
