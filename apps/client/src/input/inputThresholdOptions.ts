import type { InputThresholds } from './InputController';

export interface InputThresholdOptions {
	tapMs: number;
	dragStartPx: number;
	fastDragPxPerMs: number;
}

export type InputThresholdPresetId = 'comfortable' | 'standard' | 'fast';
export type InputThresholdPreset = Readonly<{
	label: string;
	values: Readonly<InputThresholdOptions>;
}>;

export const INPUT_THRESHOLD_STORAGE_KEY = 'one-finger-world.input-thresholds.v1';

export const DEFAULT_INPUT_THRESHOLD_OPTIONS: Readonly<InputThresholdOptions> = Object.freeze({
	tapMs: 180,
	dragStartPx: 14,
	fastDragPxPerMs: 0.9
});

export const INPUT_THRESHOLD_PRESETS: Readonly<Record<InputThresholdPresetId, InputThresholdPreset>> =
	Object.freeze({
		comfortable: Object.freeze({
			label: '편안',
			values: Object.freeze({
				tapMs: 240,
				dragStartPx: 20,
				fastDragPxPerMs: 0.7
			})
		}),
		standard: Object.freeze({
			label: '표준',
			values: Object.freeze({
				tapMs: 180,
				dragStartPx: 14,
				fastDragPxPerMs: 0.9
			})
		}),
		fast: Object.freeze({
			label: '빠름',
			values: Object.freeze({
				tapMs: 140,
				dragStartPx: 10,
				fastDragPxPerMs: 1.1
			})
		})
	});

export const INPUT_THRESHOLD_RANGES = Object.freeze({
	tapMs: Object.freeze({ min: 120, max: 280, step: 1, unit: 'ms' }),
	dragStartPx: Object.freeze({ min: 8, max: 24, step: 1, unit: 'px' }),
	fastDragPxPerMs: Object.freeze({ min: 0.6, max: 1.2, step: 0.1, unit: 'px/ms' })
});

const FIXED_RUN_DISTANCE_PX = 72;
const FIXED_DASH_WINDOW_MS = 320;

export function clampInputThresholdOptions(
	options: Partial<InputThresholdOptions>
): InputThresholdOptions {
	return {
		tapMs: clamp(
			options.tapMs,
			INPUT_THRESHOLD_RANGES.tapMs,
			DEFAULT_INPUT_THRESHOLD_OPTIONS.tapMs
		),
		dragStartPx: clamp(
			options.dragStartPx,
			INPUT_THRESHOLD_RANGES.dragStartPx,
			DEFAULT_INPUT_THRESHOLD_OPTIONS.dragStartPx
		),
		fastDragPxPerMs: clamp(
			options.fastDragPxPerMs,
			INPUT_THRESHOLD_RANGES.fastDragPxPerMs,
			DEFAULT_INPUT_THRESHOLD_OPTIONS.fastDragPxPerMs
		)
	};
}

export function inputThresholdOptionsToThresholds(options: InputThresholdOptions): InputThresholds {
	const clamped = clampInputThresholdOptions(options);
	return {
		tapMs: clamped.tapMs,
		dragStartPx: clamped.dragStartPx,
		runDistancePx: FIXED_RUN_DISTANCE_PX,
		fastDragPxPerMs: clamped.fastDragPxPerMs,
		dashWindowMs: FIXED_DASH_WINDOW_MS
	};
}

export function loadInputThresholdOptions(storage: Storage | undefined): InputThresholdOptions {
	if (!storage) return defaultInputThresholdOptions();

	try {
		const raw = storage.getItem(INPUT_THRESHOLD_STORAGE_KEY);
		if (!raw) return defaultInputThresholdOptions();

		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) return defaultInputThresholdOptions();

		return clampInputThresholdOptions(parsed);
	} catch {
		return defaultInputThresholdOptions();
	}
}

export function saveInputThresholdOptions(
	storage: Storage | undefined,
	options: InputThresholdOptions
): void {
	if (!storage) return;

	try {
		storage.setItem(INPUT_THRESHOLD_STORAGE_KEY, JSON.stringify(clampInputThresholdOptions(options)));
	} catch {
		// Storage can fail in private browsing or quota-limited contexts.
	}
}

function defaultInputThresholdOptions(): InputThresholdOptions {
	return { ...DEFAULT_INPUT_THRESHOLD_OPTIONS };
}

function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {
	const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return Math.min(range.max, Math.max(range.min, numeric));
}

function isObject(value: unknown): value is Partial<InputThresholdOptions> {
	return typeof value === 'object' && value !== null;
}
