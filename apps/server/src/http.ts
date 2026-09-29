import type { ApiErrorBody, ApiErrorCode } from '@ofa/net';

const MAX_BODY_BYTES = 4096;

function allowedOrigins(env: Env): string[] {
	return env.ALLOWED_ORIGINS.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
}

/** A single `*` entry admits any origin; only local development sets it (Vite serves the page, the Worker sees its origin). */
function listed(origin: string, env: Env): boolean {
	const list = allowedOrigins(env);
	return list.includes('*') || list.includes(origin);
}

/** No Origin (non-browser), same origin, or listed in ALLOWED_ORIGINS. */
export function originAllowed(request: Request, env: Env): boolean {
	const origin = request.headers.get('Origin');
	return origin === null || origin === new URL(request.url).origin || listed(origin, env);
}

/** CORS headers for a cross-origin request from a listed origin; empty otherwise (§7). Always echoes the origin, never a literal `*`. */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
	const origin = request.headers.get('Origin');
	if (origin === null || !listed(origin, env)) return {};
	return {
		'Access-Control-Allow-Origin': origin,
		Vary: 'Origin',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Max-Age': '86400'
	};
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(data, { status, headers });
}

export function apiError(status: number, code: ApiErrorCode, message: string): Response {
	return json({ error: { code, message } } satisfies ApiErrorBody, status);
}

/** Parses a small JSON body; a 400 response when it is too big, not JSON, or rejected by `validate`. */
export async function readJson<T>(request: Request, validate: (v: unknown) => T | null): Promise<T | Response> {
	const bad = () => apiError(400, 'bad_request', 'Invalid request body');
	const declared = Number(request.headers.get('Content-Length'));
	if (declared > MAX_BODY_BYTES) return bad();
	const text = await request.text();
	if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return bad();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return bad();
	}
	return validate(value) ?? bad();
}

export function bearer(request: Request): string | null {
	const match = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') ?? '');
	return match ? match[1] : null;
}
