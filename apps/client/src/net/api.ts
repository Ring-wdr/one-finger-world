import {
	API,
	DATA_HASH,
	PROTOCOL_VERSION,
	serverMatchWs,
	type ApiErrorBody,
	type ApiErrorCode,
	type GuestResponse,
	type HealthResponse,
	type ProfileDto,
	type ProfileResponse,
	type QuickplayResponse
} from '@ofa/net';

/** Client for the Worker HTTP API (docs/multiplayer-server-design.md §7, §12). */

export const AUTH_STORAGE_KEY = 'ofa.auth.v1';

export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode | 'network',
		message: string
	) {
		super(message);
		this.name = 'ApiRequestError';
	}
}

export interface ApiClientOptions {
	origin: string;
	fetch?: typeof fetch;
	storage?: Storage | undefined;
	/** Per-request limit, also the health probe's. */
	timeoutMs?: number;
}

const isErrorBody = (v: unknown): v is ApiErrorBody =>
	typeof v === 'object' && v !== null && typeof (v as ApiErrorBody).error?.code === 'string';

export class ApiClient {
	readonly origin: string;
	private readonly fetchFn: typeof fetch;
	private readonly storage: Storage | undefined;
	private readonly timeoutMs: number;
	/** Kept in memory too, so a browser without usable storage still works for the session. */
	private token: string | null = null;

	constructor(opts: ApiClientOptions) {
		this.origin = opts.origin.replace(/\/+$/, '');
		this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.timeoutMs = opts.timeoutMs ?? 3000;
		if ('storage' in opts) this.storage = opts.storage;
		else {
			try {
				this.storage = globalThis.localStorage;
			} catch {
				this.storage = undefined;
			}
		}
	}

	/** null when the API is unreachable, times out or reports another protocol/data hash. */
	async health(): Promise<HealthResponse | null> {
		try {
			const h = await this.request<HealthResponse>('GET', API.health, false);
			return h.ok === true && h.protocol === PROTOCOL_VERSION && h.dataHash === DATA_HASH ? h : null;
		} catch {
			return null;
		}
	}

	/** Stored guest token → profile; missing or rejected (401) token → create a guest and store its token. */
	async ensureGuest(): Promise<ProfileDto> {
		this.token ??= this.readToken();
		if (this.token !== null) {
			try {
				return await this.profile();
			} catch (e) {
				if (!(e instanceof ApiRequestError) || e.status !== 401) throw e;
			}
		}
		const g = await this.request<GuestResponse>('POST', API.guest, false);
		this.token = g.token;
		this.writeToken(g.token);
		return g.profile;
	}

	async profile(): Promise<ProfileDto> {
		return (await this.request<ProfileResponse>('GET', API.profile, true)).profile;
	}

	async rename(name: string): Promise<ProfileDto> {
		return (await this.request<ProfileResponse>('POST', API.name, true, { name })).profile;
	}

	async buy(runeId: string): Promise<ProfileDto> {
		return (await this.request<ProfileResponse>('POST', API.buy, true, { runeId })).profile;
	}

	async equip(runeId: string): Promise<ProfileDto> {
		return (await this.request<ProfileResponse>('POST', API.equip, true, { runeId })).profile;
	}

	quickplay(): Promise<QuickplayResponse> {
		return this.request<QuickplayResponse>('POST', API.quickplay, true);
	}

	/**
	 * ws(s)://<origin>/api/match/<id>/ws?ticket=…&v=PROTOCOL_VERSION&h=DATA_HASH (ws for http origins), or
	 * <server>/match/<id>/ws?… when quickplay named a standalone match server (docs/match-server-oracle.md §9).
	 */
	wsUrl(matchId: string, ticket: string, server?: string): string {
		const query = `?ticket=${encodeURIComponent(ticket)}&v=${PROTOCOL_VERSION}&h=${DATA_HASH}`;
		if (server) return `${server.replace(/\/+$/, '')}${serverMatchWs(matchId)}${query}`;
		return `${this.origin.replace(/^http/, 'ws')}${API.matchWs(matchId)}${query}`;
	}

	private readToken(): string | null {
		try {
			return this.storage?.getItem(AUTH_STORAGE_KEY) ?? null;
		} catch {
			return null;
		}
	}

	private writeToken(token: string): void {
		try {
			this.storage?.setItem(AUTH_STORAGE_KEY, token);
		} catch {
			// Private mode: the in-memory token still carries this session.
		}
	}

	private async request<T>(method: 'GET' | 'POST', path: string, auth: boolean, body?: unknown): Promise<T> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
		const headers: Record<string, string> = {};
		if (auth) this.token ??= this.readToken();
		if (auth && this.token !== null) headers.authorization = `Bearer ${this.token}`;
		if (body !== undefined) headers['content-type'] = 'application/json';
		let res: Response;
		try {
			res = await this.fetchFn(`${this.origin}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: ctrl.signal
			});
		} catch (e) {
			throw new ApiRequestError(0, 'network', e instanceof Error ? e.message : 'network error');
		} finally {
			clearTimeout(timer);
		}
		let data: unknown;
		try {
			data = await res.json();
		} catch {
			data = null;
		}
		if (!res.ok) {
			if (isErrorBody(data)) throw new ApiRequestError(res.status, data.error.code, data.error.message);
			throw new ApiRequestError(res.status, res.status >= 500 ? 'server' : 'bad_request', `HTTP ${res.status}`);
		}
		return data as T;
	}
}
