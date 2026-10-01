import { API, DATA_HASH, MATCH_ID_PATTERN, PROTOCOL_VERSION, type ApiErrorCode, type GuestResponse, type HealthResponse, type ProfileResponse, type QuickplayResponse } from '@ofa/net';
import { buyRune, equippedRunes, generateGuestName, normalizeNickname, toggleRune, type ShopError } from '@ofa/meta';
import { encodeSeatHeader, INTERNAL_SIG_HEADER, SEAT_HEADER, signToken, TICKET_TTL_MS, verifyGuest, verifyInternal, verifyTicket, type MatchSummary, type RewardGrant } from '@ofa/match';
import { createPlayer, getProfile, renamePlayer, updateProfile } from './db';
import { apiError, bearer, corsHeaders, json, originAllowed, readCapped, readJson } from './http';
import { grantReward, recordMatch } from './match/rewards';
import { readSettings, type MatchBackend } from './settings';

export { Lobby } from './lobby';
export { MatchRoom } from './match/room';

const MATCH_WS = /^\/api\/match\/([^/]+)\/ws$/;
const MAX_RUNE_ID = 64;

const NOT_SIGNED_IN = () => apiError(401, 'unauthorized', 'Sign in first');
const RATE_LIMITED = () => apiError(429, 'rate_limited', 'Too many requests');

const parseName = (v: unknown) => (typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : null);
const parseRuneId = (v: unknown) => {
	const id = typeof v === 'object' && v !== null ? (v as { runeId?: unknown }).runeId : null;
	return typeof id === 'string' && id.length > 0 && id.length <= MAX_RUNE_ID ? id : null;
};

/** The guest uid behind the Bearer token, or null. */
async function authenticate(request: Request, env: Env): Promise<string | null> {
	const token = bearer(request);
	return token ? ((await verifyGuest(env.AUTH_SECRET, token))?.sub ?? null) : null;
}

async function guest(request: Request, env: Env): Promise<Response> {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
	if (!(await env.GUEST_LIMITER.limit({ key: ip })).success) return RATE_LIMITED();
	const now = Date.now();
	const profile = await createPlayer(env.DB, crypto.randomUUID(), generateGuestName(Math.random), now);
	const token = await signToken(env.AUTH_SECRET, { typ: 'guest', sub: profile.uid, iat: now });
	return json({ token, profile } satisfies GuestResponse);
}

async function profile(request: Request, env: Env): Promise<Response> {
	const uid = await authenticate(request, env);
	const p = uid && (await getProfile(env.DB, uid));
	return p ? json({ profile: p } satisfies ProfileResponse) : NOT_SIGNED_IN();
}

async function rename(request: Request, env: Env): Promise<Response> {
	const uid = await authenticate(request, env);
	if (!uid) return NOT_SIGNED_IN();
	if (!(await env.ACCOUNT_LIMITER.limit({ key: uid })).success) return RATE_LIMITED();
	const raw = await readJson(request, parseName);
	if (raw instanceof Response) return raw;
	const name = normalizeNickname(raw);
	if (!name) return apiError(422, 'bad_name', 'Nicknames are 2-12 letters, digits, Hangul, _ - or spaces');
	const p = await renamePlayer(env.DB, uid, name);
	return p ? json({ profile: p } satisfies ProfileResponse) : NOT_SIGNED_IN();
}

const SHOP_ERRORS: Record<ShopError | 'conflict', [number, ApiErrorCode, string]> = {
	unknown: [422, 'unknown_rune', 'No such rune'],
	owned: [409, 'owned', 'Already owned'],
	coins: [409, 'coins', 'Not enough coins'],
	conflict: [409, 'conflict', 'Try again']
};

async function shop(request: Request, env: Env, action: 'buy' | 'equip'): Promise<Response> {
	const uid = await authenticate(request, env);
	if (!uid) return NOT_SIGNED_IN();
	if (!(await env.ACCOUNT_LIMITER.limit({ key: uid })).success) return RATE_LIMITED();
	const runeId = await readJson(request, parseRuneId);
	if (runeId instanceof Response) return runeId;
	const result = await updateProfile(env.DB, uid, (p) => (action === 'buy' ? buyRune(p, runeId) : toggleRune(p, runeId)));
	if (result === null) return NOT_SIGNED_IN();
	if (typeof result === 'string') return apiError(...SHOP_ERRORS[result]);
	return json({ profile: result } satisfies ProfileResponse);
}

/** The standalone match server only takes matches once its origin is configured. */
function effectiveBackend(chosen: MatchBackend, env: Env): MatchBackend {
	return chosen === 'server' && env.MATCH_SERVER_ORIGIN ? 'server' : 'do';
}

async function quickplay(request: Request, env: Env): Promise<Response> {
	const uid = await authenticate(request, env);
	if (!uid) return NOT_SIGNED_IN();
	if (!(await env.PLAY_LIMITER.limit({ key: uid })).success) return RATE_LIMITED();
	// Matches already running play out; only new ones are refused.
	const settings = await readSettings(env.DB);
	if (!settings.open) return apiError(503, 'closed', 'Online play is closed by the operator');
	const p = await getProfile(env.DB, uid);
	if (!p) return NOT_SIGNED_IN();
	const lobby = env.LOBBY.getByName('lobby', { locationHint: env.LOCATION_HINT as DurableObjectLocationHint });
	const backend = effectiveBackend(settings.backend, env);
	const { matchId } = await lobby.assign(uid, backend);
	const now = Date.now();
	const ticket = await signToken(env.TICKET_SECRET, {
		typ: 'ticket',
		sub: uid,
		mid: matchId,
		name: p.name,
		runes: equippedRunes(p),
		iat: now,
		exp: now + TICKET_TTL_MS
	});
	return json((backend === 'server' ? { matchId, ticket, server: env.MATCH_SERVER_ORIGIN } : { matchId, ticket }) satisfies QuickplayResponse);
}

async function matchWs(request: Request, env: Env, id: string): Promise<Response> {
	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return apiError(426, 'bad_request', 'Expected a WebSocket upgrade');
	if (!MATCH_ID_PATTERN.test(id)) return apiError(404, 'not_found', 'No such match');
	if (!originAllowed(request, env)) return apiError(403, 'unauthorized', 'Origin not allowed');
	const query = new URL(request.url).searchParams;
	if (query.get('v') !== String(PROTOCOL_VERSION) || query.get('h') !== DATA_HASH) return apiError(409, 'version', 'Client version mismatch');
	const claims = await verifyTicket(env.TICKET_SECRET, query.get('ticket') ?? '', Date.now());
	if (!claims || claims.mid !== id) return apiError(401, 'unauthorized', 'Invalid ticket');
	let room: DurableObjectId;
	try {
		room = env.MATCH.idFromString(id);
	} catch {
		// Well-formed but not an id of this namespace.
		return apiError(404, 'not_found', 'No such match');
	}
	const forwarded = new Request(request);
	forwarded.headers.set(SEAT_HEADER, encodeSeatHeader({ uid: claims.sub, name: claims.name, runes: claims.runes, iat: claims.iat }));
	return env.MATCH.get(room, { locationHint: env.LOCATION_HINT as DurableObjectLocationHint }).fetch(forwarded);
}

// ── Match server → Worker (docs/match-server-oracle.md §8): rewards and match rows for matches the Worker does not host.

const MAX_INTERNAL_BYTES = 8192;
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseGrant(v: unknown): RewardGrant | null {
	if (!isObj(v) || !isObj(v.result)) return null;
	const { matchId, uid, score, coins, result: r } = v;
	if (typeof matchId !== 'string' || !MATCH_ID_PATTERN.test(matchId) || typeof uid !== 'string' || !uid || !isInt(score) || !isInt(coins)) return null;
	if (!isInt(r.placement, 1) || !isInt(r.kills) || !isInt(r.level) || typeof r.time !== 'number' || !(r.time >= 0) || typeof r.leftEarly !== 'boolean') return null;
	return { matchId, uid, score, coins, result: { placement: r.placement, kills: r.kills, level: r.level, time: r.time, leftEarly: r.leftEarly } };
}

function parseSummary(v: unknown): MatchSummary | null {
	if (!isObj(v)) return null;
	const { matchId, seed, startedAt, endedAt, durationS, humans, winnerUid } = v;
	if (typeof matchId !== 'string' || !MATCH_ID_PATTERN.test(matchId) || !isInt(seed) || !isInt(startedAt) || !isInt(endedAt) || typeof durationS !== 'number' || !isInt(humans)) return null;
	if (winnerUid !== null && typeof winnerUid !== 'string') return null;
	return { matchId, seed, startedAt, endedAt, durationS, humans, winnerUid };
}

/** Verifies the signature over the raw body, then parses it. Browsers never call these: any Origin is refused. */
async function internal<T>(request: Request, env: Env, parse: (v: unknown) => T | null, run: (v: T) => Promise<Response>): Promise<Response> {
	if (request.headers.has('Origin') || !env.INTERNAL_SECRET) return apiError(404, 'not_found', 'Not found');
	const body = await readCapped(request, MAX_INTERNAL_BYTES);
	if (body === null || !(await verifyInternal(env.INTERNAL_SECRET, request.headers.get(INTERNAL_SIG_HEADER), body, Date.now()))) {
		return apiError(401, 'unauthorized', 'Bad signature');
	}
	let value: T | null = null;
	try {
		value = parse(JSON.parse(body));
	} catch {
		// Falls through to 400.
	}
	return value === null ? apiError(400, 'bad_request', 'Invalid request body') : run(value);
}

type Handler = (request: Request, env: Env) => Promise<Response> | Response;

const ROUTES: Record<string, { method: 'GET' | 'POST'; handler: Handler }> = {
	[API.health]: {
		method: 'GET',
		handler: async (_request, env) => {
			const settings = await readSettings(env.DB);
			return json({
				ok: true,
				protocol: PROTOCOL_VERSION,
				dataHash: DATA_HASH,
				multiplayer: settings.open,
				matchBackend: effectiveBackend(settings.backend, env)
			} satisfies HealthResponse);
		}
	},
	[API.guest]: { method: 'POST', handler: guest },
	[API.profile]: { method: 'GET', handler: profile },
	[API.name]: { method: 'POST', handler: rename },
	[API.buy]: { method: 'POST', handler: (r, e) => shop(r, e, 'buy') },
	[API.equip]: { method: 'POST', handler: (r, e) => shop(r, e, 'equip') },
	[API.quickplay]: { method: 'POST', handler: quickplay },
	[API.internalGrant]: { method: 'POST', handler: (r, e) => internal(r, e, parseGrant, async (g) => json(await grantReward(e.DB, g, Date.now()))) },
	[API.internalMatch]: {
		method: 'POST',
		handler: (r, e) =>
			internal(r, e, parseSummary, async (m) => {
				await recordMatch(e.DB, m);
				return json({ ok: true });
			})
	}
};

async function route(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (request.method === 'OPTIONS') {
		return originAllowed(request, env) ? new Response(null, { status: 204 }) : apiError(403, 'unauthorized', 'Origin not allowed');
	}
	const ws = MATCH_WS.exec(pathname);
	if (ws) return request.method === 'GET' ? matchWs(request, env, ws[1]) : apiError(405, 'bad_request', 'Method not allowed');
	const entry = ROUTES[pathname];
	if (!entry) return apiError(404, 'not_found', 'Not found');
	if (request.method !== entry.method) return apiError(405, 'bad_request', 'Method not allowed');
	return entry.handler(request, env);
}

/** HTTP entry (docs/multiplayer-server-design.md §7). */
export default {
	async fetch(request, env): Promise<Response> {
		let response: Response;
		try {
			response = await route(request, env);
		} catch (err) {
			// Message only: stacks and requests could carry tokens.
			console.error(err instanceof Error ? err.message : 'unexpected error');
			response = apiError(500, 'server', 'Internal error');
		}
		// A 101 carries the socket and its headers are immutable; browsers do not apply CORS to WebSockets anyway.
		if (response.status === 101) return response;
		const cors = corsHeaders(request, env);
		if (Object.keys(cors).length === 0) return response;
		const out = new Response(response.body, response);
		for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
		return out;
	}
} satisfies ExportedHandler<Env>;
