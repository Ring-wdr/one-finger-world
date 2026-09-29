import { batch, signal } from '@preact/signals';
import type { ProfileDto } from '@ofa/net';
import type { Profile } from '@ofa/meta';
import { ApiClient, ApiRequestError } from '../net/api';
import type { LobbyView, NetStats, OnlineErrorCode } from '../net/onlineMatch';
import { profile, profileSource, safeStorage } from './store';

/**
 * Online availability and the server profile (docs/multiplayer-server-design.md §12).
 * Without a reachable API everything here stays inert and the app behaves as the offline game.
 */

export const onlineAvailable = signal(false);
export const playerName = signal('');
export const lobby = signal<LobbyView | null>(null);
/** performance.now() when `lobby` arrived, for the start countdown. */
export const lobbyAt = signal(0);
export const connection = signal<'open' | 'reconnecting' | null>(null);
export const onlineError = signal<string | null>(null);
export const onlineErrorCode = signal<OnlineErrorCode | null>(null);
/** Debug overlay numbers (`?net=1`), refreshed by the Game. */
export const netStats = signal<NetStats | null>(null);
/** A shop or rename request is in flight. */
export const requestBusy = signal(false);

let client: ApiClient | null = null;

/** One ApiClient for the app; created on first use so importing this module needs no `location`. */
export function getApi(): ApiClient {
	client ??= new ApiClient({ origin: import.meta.env.VITE_API_ORIGIN || location.origin, storage: safeStorage() });
	return client;
}

const toProfile = (d: ProfileDto): Profile => ({ coins: d.coins, owned: d.owned, equipped: d.equipped, best: d.best, matches: d.matches });

function applyServerProfile(d: ProfileDto) {
	batch(() => {
		// Source first: the store must not persist the server profile as the offline one.
		profileSource.value = 'server';
		profile.value = toProfile(d);
		playerName.value = d.name;
	});
}

/** Probe the API; on success switch to the server profile. Never throws. */
export async function initOnline(api: ApiClient = getApi()): Promise<void> {
	client = api;
	if ((await api.health()) === null) return;
	try {
		const d = await api.ensureGuest();
		batch(() => {
			applyServerProfile(d);
			onlineAvailable.value = true;
		});
	} catch (e) {
		console.warn('[online] unavailable, staying offline:', e);
	}
}

/** Korean text for a failed API call. */
export function apiErrorText(e: unknown): string {
	if (!(e instanceof ApiRequestError)) return '잠시 후 다시 시도해 주세요';
	switch (e.code) {
		case 'coins':
			return '코인이 부족해요';
		case 'owned':
			return '이미 가지고 있어요';
		case 'unknown_rune':
			return '알 수 없는 룬이에요';
		case 'bad_name':
			return '닉네임은 2~12자 한글·영문·숫자·_-·공백';
		case 'rate_limited':
			return '너무 빠르게 요청했어요. 잠시 후 다시 시도해 주세요';
		case 'network':
			return '서버에 연결할 수 없어요';
		default:
			return '잠시 후 다시 시도해 주세요';
	}
}

export function queueErrorText(code: OnlineErrorCode): string {
	switch (code) {
		case 'version':
			return '새 버전이 있어요';
		case 'full':
			return '방이 가득 찼어요';
		case 'started':
		case 'ended':
			return '참가할 수 있는 매치를 찾지 못했어요';
		case 'unauthorized':
			return '계정을 확인하지 못했어요. 새로고침해 주세요';
		case 'network':
			return '서버에 연결할 수 없어요';
		default:
			return '잠시 후 다시 시도해 주세요';
	}
}

/** Runs a profile-changing request; resolves to an error text, or null on success. */
async function profileRequest(run: (api: ApiClient) => Promise<ProfileDto>): Promise<string | null> {
	if (requestBusy.value) return null;
	requestBusy.value = true;
	try {
		applyServerProfile(await run(getApi()));
		return null;
	} catch (e) {
		return apiErrorText(e);
	} finally {
		requestBusy.value = false;
	}
}

export const buyRuneOnline = (id: string) => profileRequest((api) => api.buy(id));

/** Equips an owned rune; equipping the one in its slot takes it off (the server toggles). */
export const toggleRuneOnline = (id: string) => profileRequest((api) => api.equip(id));

export const renameOnline = (name: string) => profileRequest((api) => api.rename(name));
