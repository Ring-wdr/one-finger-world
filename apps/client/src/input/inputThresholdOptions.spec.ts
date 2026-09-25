import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_INPUT_THRESHOLD_OPTIONS,
	INPUT_THRESHOLD_PRESETS,
	INPUT_THRESHOLD_RANGES,
	INPUT_THRESHOLD_STORAGE_KEY,
	clampInputThresholdOptions,
	inputThresholdOptionsToThresholds,
	loadInputThresholdOptions,
	saveInputThresholdOptions
} from './inputThresholdOptions';

describe('inputThresholdOptions', () => {
	it('defines the three spec presets that map onto current main thresholds', () => {
		expect(INPUT_THRESHOLD_PRESETS.comfortable.values).toEqual({
			tapMs: 240,
			dragStartPx: 20,
			fastDragPxPerMs: 0.7
		});
		expect(INPUT_THRESHOLD_PRESETS.standard.values).toEqual({
			tapMs: 180,
			dragStartPx: 14,
			fastDragPxPerMs: 0.9
		});
		expect(INPUT_THRESHOLD_PRESETS.fast.values).toEqual({
			tapMs: 140,
			dragStartPx: 10,
			fastDragPxPerMs: 1.1
		});
		expect(INPUT_THRESHOLD_RANGES).toEqual({
			tapMs: { min: 120, max: 280, step: 1, unit: 'ms' },
			dragStartPx: { min: 8, max: 24, step: 1, unit: 'px' },
			fastDragPxPerMs: { min: 0.6, max: 1.2, step: 0.1, unit: 'px/ms' }
		});
	});

	it('clamps user-facing values and preserves current fixed internal thresholds', () => {
		const thresholds = inputThresholdOptionsToThresholds({
			tapMs: 999,
			dragStartPx: -4,
			fastDragPxPerMs: 0.2
		});

		expect(thresholds).toEqual({
			tapMs: 280,
			dragStartPx: 8,
			runDistancePx: 72,
			fastDragPxPerMs: 0.6,
			dashWindowMs: 320
		});
	});

	it('falls back to defaults for missing or non-finite user-facing values', () => {
		expect(clampInputThresholdOptions({ tapMs: Number.POSITIVE_INFINITY })).toEqual({
			tapMs: 180,
			dragStartPx: 14,
			fastDragPxPerMs: 0.9
		});
	});

	it('loads defaults when storage is unavailable or malformed', () => {
		expect(loadInputThresholdOptions(undefined)).toEqual(DEFAULT_INPUT_THRESHOLD_OPTIONS);

		const storage = createStorage();
		storage.setItem(INPUT_THRESHOLD_STORAGE_KEY, '{bad json');

		expect(loadInputThresholdOptions(storage)).toEqual(DEFAULT_INPUT_THRESHOLD_OPTIONS);
	});

	it('returns fresh fallback option objects without sharing exported defaults or presets', () => {
		expect(INPUT_THRESHOLD_PRESETS.standard.values).toEqual(DEFAULT_INPUT_THRESHOLD_OPTIONS);
		expect(INPUT_THRESHOLD_PRESETS.standard.values).not.toBe(DEFAULT_INPUT_THRESHOLD_OPTIONS);

		const missingStorageOptions = loadInputThresholdOptions(undefined);
		missingStorageOptions.tapMs = 120;

		expect(DEFAULT_INPUT_THRESHOLD_OPTIONS.tapMs).toBe(180);
		expect(INPUT_THRESHOLD_PRESETS.standard.values.tapMs).toBe(180);

		const storage = createStorage();
		storage.setItem(INPUT_THRESHOLD_STORAGE_KEY, '{bad json');

		const malformedOptions = loadInputThresholdOptions(storage);
		malformedOptions.dragStartPx = 24;

		expect(DEFAULT_INPUT_THRESHOLD_OPTIONS.dragStartPx).toBe(14);
		expect(INPUT_THRESHOLD_PRESETS.standard.values.dragStartPx).toBe(14);
	});

	it('freezes exported config objects and preset values', () => {
		expect(Object.isFrozen(DEFAULT_INPUT_THRESHOLD_OPTIONS)).toBe(true);
		expect(Object.isFrozen(INPUT_THRESHOLD_PRESETS)).toBe(true);

		for (const preset of Object.values(INPUT_THRESHOLD_PRESETS)) {
			expect(Object.isFrozen(preset)).toBe(true);
			expect(Object.isFrozen(preset.values)).toBe(true);
		}
	});

	it('keeps helper-returned option objects mutable for UI state', () => {
		const clampedOptions = clampInputThresholdOptions({});
		clampedOptions.tapMs = 120;
		expect(clampedOptions.tapMs).toBe(120);

		const loadedOptions = loadInputThresholdOptions(undefined);
		loadedOptions.dragStartPx = 24;
		expect(loadedOptions.dragStartPx).toBe(24);
	});

	it('loads partial stored values with defaults for missing options', () => {
		const storage = createStorage();
		storage.setItem(INPUT_THRESHOLD_STORAGE_KEY, JSON.stringify({ tapMs: 240 }));

		expect(loadInputThresholdOptions(storage)).toEqual({
			tapMs: 240,
			dragStartPx: 14,
			fastDragPxPerMs: 0.9
		});
	});

	it('saves and reloads clamped values', () => {
		const storage = createStorage();

		saveInputThresholdOptions(storage, {
			tapMs: 999,
			dragStartPx: -4,
			fastDragPxPerMs: 0.2
		});

		expect(loadInputThresholdOptions(storage)).toEqual({
			tapMs: 280,
			dragStartPx: 8,
			fastDragPxPerMs: 0.6
		});
	});

	it('ignores storage write failures when saving options', () => {
		const storage = createStorage();
		vi.mocked(storage.setItem).mockImplementationOnce(() => {
			throw new Error('storage unavailable');
		});

		expect(() => {
			saveInputThresholdOptions(storage, {
				tapMs: 120,
				dragStartPx: 24,
				fastDragPxPerMs: 1.2
			});
		}).not.toThrow();
	});
});

function createStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: vi.fn(() => values.clear()),
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
		removeItem: vi.fn((key: string) => values.delete(key)),
		setItem: vi.fn((key: string, value: string) => values.set(key, value))
	};
}
