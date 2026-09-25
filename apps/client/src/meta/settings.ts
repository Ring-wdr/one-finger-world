import {
	clampInputThresholdOptions,
	DEFAULT_INPUT_THRESHOLD_OPTIONS,
	INPUT_THRESHOLD_STORAGE_KEY,
	type InputThresholdOptions
} from '../input/inputThresholdOptions';

/** Volume is 0–1 (only sound effects exist so far). Touch sensitivity reuses the input-threshold options. */
export interface Settings {
	volume: number;
	muted: boolean;
	vibrate: boolean;
	input: InputThresholdOptions;
}

export const SETTINGS_STORAGE_KEY = 'ofa.settings.v1';
export function defaultSettings(): Settings {
	return { volume: 0.7, muted: false, vibrate: true, input: { ...DEFAULT_INPUT_THRESHOLD_OPTIONS } };
}

const unit = (v: unknown, fallback: number) =>
	typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

export function parseSettings(raw: unknown): Settings {
	const d = defaultSettings();
	if (typeof raw !== 'object' || raw === null) return d;
	const r = raw as Partial<Record<keyof Settings, unknown>>;
	return {
		volume: unit(r.volume, d.volume),
		muted: typeof r.muted === 'boolean' ? r.muted : d.muted,
		vibrate: typeof r.vibrate === 'boolean' ? r.vibrate : d.vibrate,
		input:
			typeof r.input === 'object' && r.input !== null
				? clampInputThresholdOptions(r.input as Partial<InputThresholdOptions>)
				: d.input
	};
}

export function loadSettings(storage: Storage | undefined): Settings {
	try {
		const raw = storage?.getItem(SETTINGS_STORAGE_KEY);
		if (raw) return parseSettings(JSON.parse(raw));
		// Carry over a sensitivity picked on the old start screen.
		const legacy = storage?.getItem(INPUT_THRESHOLD_STORAGE_KEY);
		return parseSettings(legacy ? { input: JSON.parse(legacy) } : null);
	} catch {
		return defaultSettings();
	}
}

export function saveSettings(storage: Storage | undefined, s: Settings) {
	try {
		storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
	} catch {
		// Settings fall back to defaults next launch.
	}
}

/** Effective gain for sound effects. */
export function sfxGain(s: Settings) {
	return s.muted ? 0 : s.volume;
}
