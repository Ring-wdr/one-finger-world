/** Signed tokens (docs/multiplayer-server-design.md §8): base64url(JSON) + '.' + base64url(HMAC-SHA256). */

export interface GuestClaims {
	typ: 'guest';
	sub: string;
	iat: number;
}

export interface TicketClaims {
	typ: 'ticket';
	sub: string;
	mid: string;
	name: string;
	runes: string[];
	iat: number;
	exp: number;
}

export const TICKET_TTL_MS = 15 * 60_000;

const encoder = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on malformed input; callers catch. */
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// One key import per secret for the isolate's lifetime.
const keys = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
	let key = keys.get(secret);
	if (!key) {
		key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
		keys.set(secret, key);
	}
	return key;
}

export async function signToken(secret: string, claims: GuestClaims | TicketClaims): Promise<string> {
	const payload = toB64url(encoder.encode(JSON.stringify(claims)));
	const sig = await crypto.subtle.sign('HMAC', await importKey(secret), encoder.encode(payload));
	return `${payload}.${toB64url(new Uint8Array(sig))}`;
}

async function open(secret: string, token: string): Promise<Record<string, unknown> | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 2) return null;
		const [payload, sig] = parts;
		const ok = await crypto.subtle.verify('HMAC', await importKey(secret), fromB64url(sig), encoder.encode(payload));
		if (!ok) return null;
		const claims: unknown = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
		return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export async function verifyGuest(secret: string, token: string): Promise<GuestClaims | null> {
	const c = await open(secret, token);
	if (!c || c.typ !== 'guest' || !isStr(c.sub) || !isNum(c.iat)) return null;
	return { typ: 'guest', sub: c.sub, iat: c.iat };
}

export async function verifyTicket(secret: string, token: string, now: number): Promise<TicketClaims | null> {
	const c = await open(secret, token);
	if (!c || c.typ !== 'ticket' || !isStr(c.sub) || !isStr(c.mid) || typeof c.name !== 'string') return null;
	if (!isNum(c.iat) || !isNum(c.exp) || c.exp <= now) return null;
	if (!Array.isArray(c.runes) || !c.runes.every((r) => typeof r === 'string')) return null;
	return { typ: 'ticket', sub: c.sub, mid: c.mid, name: c.name, runes: c.runes, iat: c.iat, exp: c.exp };
}

// ── Match server → Worker requests (docs/match-server-oracle.md §7)

/** Header carrying `<epoch ms>.<base64url HMAC-SHA256(secret, "<epoch ms>.<body>")>`. */
export const INTERNAL_SIG_HEADER = 'X-OFA-Sig';
/** How far a signed request's timestamp may be from the receiver's clock. */
export const INTERNAL_MAX_SKEW_MS = 5 * 60_000;

export async function signInternal(secret: string, body: string, now: number): Promise<string> {
	const sig = await crypto.subtle.sign('HMAC', await importKey(secret), encoder.encode(`${now}.${body}`));
	return `${now}.${toB64url(new Uint8Array(sig))}`;
}

/** Replays inside the window are harmless: reward grants are idempotent per (match, player). */
export async function verifyInternal(secret: string, header: string | null, body: string, now: number): Promise<boolean> {
	const m = /^(\d{1,15})\.([A-Za-z0-9_-]+)$/.exec(header ?? '');
	if (!m) return false;
	const ts = Number(m[1]);
	if (Math.abs(now - ts) > INTERNAL_MAX_SKEW_MS) return false;
	try {
		return await crypto.subtle.verify('HMAC', await importKey(secret), fromB64url(m[2]), encoder.encode(`${ts}.${body}`));
	} catch {
		return false;
	}
}
