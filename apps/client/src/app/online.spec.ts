import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileDto } from '@ofa/net';
import { ApiRequestError, type ApiClient } from '../net/api';
import { apiErrorText, buyRuneOnline, initOnline, onlineAvailable, playerName, renameOnline, requestBusy, toggleRuneOnline } from './online';
import { profile, profileSource } from './store';

const dto = (over: Partial<ProfileDto> = {}): ProfileDto => ({
	uid: 'u1',
	name: '날쌘여우27',
	coins: 120,
	owned: [],
	equipped: { offense: null, defense: null, utility: null },
	best: 900,
	matches: 4,
	...over
});

type FakeApi = Pick<ApiClient, 'health' | 'ensureGuest' | 'buy' | 'equip' | 'rename'>;
const fake = (over: Partial<Record<keyof FakeApi, unknown>> = {}) =>
	({
		health: vi.fn(async () => ({ ok: true })),
		ensureGuest: vi.fn(async () => dto()),
		buy: vi.fn(async () => dto()),
		equip: vi.fn(async () => dto()),
		rename: vi.fn(async () => dto()),
		...over
	}) as unknown as ApiClient;

const localProfile = { coins: 7, owned: [], equipped: { offense: null, defense: null, utility: null }, best: 1, matches: 1 };

beforeEach(() => {
	onlineAvailable.value = false;
	profileSource.value = 'local';
	profile.value = localProfile;
	playerName.value = '';
	requestBusy.value = false;
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('initOnline', () => {
	it('stays offline when the health probe fails and keeps the local profile', async () => {
		const api = fake({ health: vi.fn(async () => null) });
		await initOnline(api);
		expect(onlineAvailable.value).toBe(false);
		expect(profileSource.value).toBe('local');
		expect(profile.value).toEqual(localProfile);
		expect(api.ensureGuest).not.toHaveBeenCalled();
	});

	it('takes the server profile and name when the API answers', async () => {
		await initOnline(fake({ ensureGuest: vi.fn(async () => dto({ coins: 55, owned: ['x'], matches: 9 })) }));
		expect(onlineAvailable.value).toBe(true);
		expect(profileSource.value).toBe('server');
		expect(profile.value).toEqual({ coins: 55, owned: ['x'], equipped: { offense: null, defense: null, utility: null }, best: 900, matches: 9 });
		expect(playerName.value).toBe('날쌘여우27');
	});

	it('stays offline (and does not throw) when the guest cannot be created', async () => {
		await initOnline(fake({ ensureGuest: vi.fn(async () => Promise.reject(new ApiRequestError(0, 'network', 'down'))) }));
		expect(onlineAvailable.value).toBe(false);
		expect(profileSource.value).toBe('local');
		expect(profile.value).toEqual(localProfile);
	});
});

describe('server-mode requests', () => {
	it('replace the profile with the response and report success as null', async () => {
		await initOnline(fake({ buy: vi.fn(async () => dto({ coins: 10, owned: ['r'] })) }));
		expect(await buyRuneOnline('r')).toBeNull();
		expect(profile.value.coins).toBe(10);
		expect(profile.value.owned).toEqual(['r']);
		expect(requestBusy.value).toBe(false);
	});

	it('map error codes to Korean messages and leave the profile alone', async () => {
		const reject = (code: ApiRequestError['code']) => vi.fn(async () => Promise.reject(new ApiRequestError(400, code, 'x')));
		await initOnline(fake({ buy: reject('coins'), equip: reject('owned'), rename: reject('bad_name') }));
		const before = profile.value;
		expect(await buyRuneOnline('r')).toBe('코인이 부족해요');
		expect(await toggleRuneOnline('r')).toBe('이미 가지고 있어요');
		expect(await renameOnline('a')).toBe('닉네임은 2~12자 한글·영문·숫자·_-·공백');
		expect(profile.value).toBe(before);
		expect(requestBusy.value).toBe(false);
	});

	it('rename updates the shown name', async () => {
		await initOnline(fake({ rename: vi.fn(async () => dto({ name: '새이름' })) }));
		expect(await renameOnline('새이름')).toBeNull();
		expect(playerName.value).toBe('새이름');
	});

	it('map network and unexpected errors', () => {
		expect(apiErrorText(new ApiRequestError(0, 'network', 'x'))).toBe('서버에 연결할 수 없어요');
		expect(apiErrorText(new ApiRequestError(500, 'server', 'x'))).toBe('잠시 후 다시 시도해 주세요');
		expect(apiErrorText(new ApiRequestError(429, 'rate_limited', 'x'))).toContain('잠시 후');
		expect(apiErrorText(new Error('boom'))).toBe('잠시 후 다시 시도해 주세요');
	});

	it('ignore a second request while one is running', async () => {
		let release!: (d: ProfileDto) => void;
		const buy = vi.fn(() => new Promise<ProfileDto>((r) => (release = r)));
		await initOnline(fake({ buy }));
		const first = buyRuneOnline('a');
		expect(requestBusy.value).toBe(true);
		expect(await buyRuneOnline('b')).toBeNull();
		expect(buy).toHaveBeenCalledTimes(1);
		release(dto());
		await first;
	});
});
