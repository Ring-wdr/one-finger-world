import { describe, expect, it } from 'vitest';
import { INPUT_THRESHOLD_STORAGE_KEY } from '../input/inputThresholdOptions';
import { defaultProfile } from '@ofa/meta';
import { loadProfile, PROFILE_STORAGE_KEY, saveProfile } from './profile';
import { defaultSettings, loadSettings, parseSettings, sfxGain } from './settings';

function memoryStorage(init: Record<string, string> = {}): Storage {
	const data = new Map(Object.entries(init));
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => data.get(k) ?? null,
		key: (i) => [...data.keys()][i] ?? null,
		removeItem: (k) => void data.delete(k),
		setItem: (k, v) => void data.set(k, v)
	};
}

describe('local profile storage', () => {
	it('round-trips through storage and survives broken data', () => {
		const storage = memoryStorage();
		const p = { ...defaultProfile(), coins: 120, best: 900, matches: 3 };
		saveProfile(storage, p);
		expect(loadProfile(storage)).toEqual(p);
		expect(loadProfile(memoryStorage({ [PROFILE_STORAGE_KEY]: '{oops' }))).toEqual(defaultProfile());
		expect(loadProfile(undefined)).toEqual(defaultProfile());
	});
});

describe('settings', () => {
	it('clamps volume and input thresholds', () => {
		const s = parseSettings({ volume: 3, muted: 'yes', input: { tapMs: 9999 } });
		expect(s.volume).toBe(1);
		expect(s.muted).toBe(false);
		expect(s.input.tapMs).toBe(280);
	});

	it('mute silences sound effects', () => {
		expect(sfxGain({ ...defaultSettings(), volume: 0.5 })).toBe(0.5);
		expect(sfxGain({ ...defaultSettings(), volume: 0.5, muted: true })).toBe(0);
	});

	it('carries over the sensitivity saved by the old start screen', () => {
		const storage = memoryStorage({
			[INPUT_THRESHOLD_STORAGE_KEY]: JSON.stringify({ tapMs: 240, dragStartPx: 20, fastDragPxPerMs: 0.7 })
		});
		expect(loadSettings(storage).input).toEqual({ tapMs: 240, dragStartPx: 20, fastDragPxPerMs: 0.7 });
	});

	it('falls back to defaults on broken storage', () => {
		expect(loadSettings(memoryStorage({ 'ofa.settings.v1': '{oops' }))).toEqual(defaultSettings());
	});
});
