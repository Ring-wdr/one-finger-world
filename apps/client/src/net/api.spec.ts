import { API, DATA_HASH, PROTOCOL_VERSION, type ProfileDto } from '@ofa/net';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiRequestError, AUTH_STORAGE_KEY } from './api';

const profile = (name = 'guest'): ProfileDto => ({
	uid: 'u1',
	name,
	coins: 0,
	owned: [],
	equipped: { weapon: null, armor: null, trinket: null } as unknown as ProfileDto['equipped'],
	best: 0,
	matches: 0
});

class MemoryStorage {
	readonly data = new Map<string, string>();
	getItem = (k: string) => this.data.get(k) ?? null;
	setItem = (k: string, v: string) => void this.data.set(k, v);
}

interface Call {
	method: string;
	path: string;
	auth: string | null;
	body: unknown;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const errorBody = (code: string) => ({ error: { code, message: `${code} happened` } });

/** A fetch that records calls and answers from `respond`. */
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const call: Call = {
			method: init?.method ?? 'GET',
			path: url.pathname,
			auth: headers.get('authorization'),
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		};
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return { fn, calls };
}

const client = (fetch: typeof globalThis.fetch, storage?: Storage, extra: { timeoutMs?: number } = {}) =>
	new ApiClient({ origin: 'https://ofa.test', fetch, storage, ...extra });

describe('ApiClient guests', () => {
	it('creates a guest when nothing is stored and keeps the token', async () => {
		const storage = new MemoryStorage();
		const { fn, calls } = fakeFetch(() => json(200, { token: 'tok-1', profile: profile() }));
		const p = await client(fn, storage as unknown as Storage).ensureGuest();
		expect(p.name).toBe('guest');
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${API.guest}`]);
		expect(storage.data.get(AUTH_STORAGE_KEY)).toBe('tok-1');
	});

	it('reuses a stored token instead of creating another guest', async () => {
		const storage = new MemoryStorage();
		storage.setItem(AUTH_STORAGE_KEY, 'tok-old');
		const { fn, calls } = fakeFetch(() => json(200, { profile: profile('me') }));
		const p = await client(fn, storage as unknown as Storage).ensureGuest();
		expect(p.name).toBe('me');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'GET', path: API.profile, auth: 'Bearer tok-old' });
	});

	it('replaces a token the server rejects with a new guest', async () => {
		const storage = new MemoryStorage();
		storage.setItem(AUTH_STORAGE_KEY, 'tok-stale');
		const { fn, calls } = fakeFetch((c) =>
			c.path === API.guest
				? json(200, { token: 'tok-new', profile: profile('fresh') })
				: c.auth === 'Bearer tok-new'
					? json(200, { profile: profile('fresh') })
					: json(401, errorBody('unauthorized'))
		);
		const c = client(fn, storage as unknown as Storage);
		expect((await c.ensureGuest()).name).toBe('fresh');
		expect(storage.data.get(AUTH_STORAGE_KEY)).toBe('tok-new');
		expect(calls.map((x) => x.path)).toEqual([API.profile, API.guest]);
		// The new token is what later calls carry.
		await c.profile();
		expect(calls[calls.length - 1].auth).toBe('Bearer tok-new');
	});

	it('does not replace the token on other failures', async () => {
		const storage = new MemoryStorage();
		storage.setItem(AUTH_STORAGE_KEY, 'tok-keep');
		const { fn } = fakeFetch(() => json(500, errorBody('server')));
		await expect(client(fn, storage as unknown as Storage).ensureGuest()).rejects.toMatchObject({ status: 500, code: 'server' });
		expect(storage.data.get(AUTH_STORAGE_KEY)).toBe('tok-keep');
	});

	it('works when storage throws (private mode)', async () => {
		const broken = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		} as unknown as Storage;
		const { fn, calls } = fakeFetch((c) => (c.path === API.guest ? json(200, { token: 't', profile: profile() }) : json(200, { profile: profile('again') })));
		const c = client(fn, broken);
		await c.ensureGuest();
		await expect(c.profile()).resolves.toMatchObject({ name: 'again' });
		expect(calls[calls.length - 1].auth).toBe('Bearer t');
	});
});

describe('ApiClient requests', () => {
	it('sends bodies and the bearer token for the profile and shop calls', async () => {
		const storage = new MemoryStorage();
		storage.setItem(AUTH_STORAGE_KEY, 'tok');
		const { fn, calls } = fakeFetch(() => json(200, { profile: profile() }));
		const c = client(fn, storage as unknown as Storage);
		await c.rename('Ann');
		await c.buy('rune-a');
		await c.equip('rune-b');
		expect(calls.map((x) => [x.method, x.path, x.body])).toEqual([
			['POST', API.name, { name: 'Ann' }],
			['POST', API.buy, { runeId: 'rune-a' }],
			['POST', API.equip, { runeId: 'rune-b' }]
		]);
		expect(calls.every((x) => x.auth === 'Bearer tok')).toBe(true);
	});

	it('returns the quickplay ticket', async () => {
		const storage = new MemoryStorage();
		storage.setItem(AUTH_STORAGE_KEY, 'tok');
		const { fn, calls } = fakeFetch(() => json(200, { matchId: 'a'.repeat(64), ticket: 'tk' }));
		await expect(client(fn, storage as unknown as Storage).quickplay()).resolves.toEqual({ matchId: 'a'.repeat(64), ticket: 'tk' });
		expect(calls[0]).toMatchObject({ method: 'POST', path: API.quickplay });
	});

	it('maps error bodies to ApiRequestError with status and code', async () => {
		const { fn } = fakeFetch(() => json(409, errorBody('coins')));
		const err = await client(fn).buy('x').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiRequestError);
		expect(err).toMatchObject({ status: 409, code: 'coins', message: 'coins happened' });
	});

	it('maps a non-JSON failure by status', async () => {
		const { fn } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
		await expect(client(fn).profile()).rejects.toMatchObject({ status: 502, code: 'server' });
	});

	it('maps network failures to the network code', async () => {
		const fn = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		await expect(client(fn).profile()).rejects.toMatchObject({ code: 'network' });
	});

	it('times out a request that never answers', async () => {
		const fn = ((_: unknown, init?: RequestInit) =>
			new Promise((_res, rej) => {
				init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
			})) as typeof fetch;
		const err = await client(fn, undefined, { timeoutMs: 20 }).quickplay().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiRequestError);
		expect(err).toMatchObject({ code: 'network' });
	});
});

describe('ApiClient health', () => {
	it('returns the response when protocol and data hash match', async () => {
		const body = { ok: true, protocol: PROTOCOL_VERSION, dataHash: DATA_HASH };
		const { fn } = fakeFetch(() => json(200, body));
		await expect(client(fn).health()).resolves.toEqual(body);
	});

	it('is null on a protocol or data mismatch', async () => {
		const { fn: badProtocol } = fakeFetch(() => json(200, { ok: true, protocol: PROTOCOL_VERSION + 1, dataHash: DATA_HASH }));
		const { fn: badHash } = fakeFetch(() => json(200, { ok: true, protocol: PROTOCOL_VERSION, dataHash: 'deadbeef' }));
		await expect(client(badProtocol).health()).resolves.toBeNull();
		await expect(client(badHash).health()).resolves.toBeNull();
	});

	it('is null when unreachable, failing or too slow', async () => {
		const down = (async () => {
			throw new TypeError('offline');
		}) as typeof fetch;
		const { fn: notFound } = fakeFetch(() => new Response('nope', { status: 404 }));
		const hang = ((_: unknown, init?: RequestInit) =>
			new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
		await expect(client(down).health()).resolves.toBeNull();
		await expect(client(notFound).health()).resolves.toBeNull();
		await expect(client(hang, undefined, { timeoutMs: 20 }).health()).resolves.toBeNull();
	});
});

describe('wsUrl', () => {
	const id = 'b'.repeat(64);
	const { fn } = fakeFetch(() => json(200, {}));

	it('uses wss for https origins and carries ticket, version and data hash', () => {
		expect(client(fn).wsUrl(id, 'a.b')).toBe(`wss://ofa.test/api/match/${id}/ws?ticket=a.b&v=${PROTOCOL_VERSION}&h=${DATA_HASH}`);
	});

	it('uses ws for http origins, ignores a trailing slash and encodes the ticket', () => {
		const c = new ApiClient({ origin: 'http://localhost:8787/', fetch: fn });
		expect(c.origin).toBe('http://localhost:8787');
		expect(c.wsUrl(id, 'a b&c')).toBe(`ws://localhost:8787/api/match/${id}/ws?ticket=a%20b%26c&v=${PROTOCOL_VERSION}&h=${DATA_HASH}`);
	});

	it('goes to the standalone match server when quickplay names one', () => {
		expect(client(fn).wsUrl(id, 'a.b', 'wss://match.example/')).toBe(`wss://match.example/match/${id}/ws?ticket=a.b&v=${PROTOCOL_VERSION}&h=${DATA_HASH}`);
	});
});
