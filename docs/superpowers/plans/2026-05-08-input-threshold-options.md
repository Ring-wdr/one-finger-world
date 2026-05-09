# Input Threshold Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-facing input threshold presets and sliders while preserving the current `main` branch one-finger control behavior.

**Architecture:** Treat the current `main` implementation of `InputController` as authoritative for controls. Do not add new gesture semantics, do not change skill-button behavior, and do not add time-based run promotion. Add a pure options module that maps user settings onto the three already-supported runtime thresholds: `tapMs`, `dragStartPx`, and `fastDragPxPerMs`; keep `runDistancePx` and `dashWindowMs` fixed at current `main` values.

**Tech Stack:** SvelteKit, TypeScript, Three.js, Vitest, Playwright browser verification.

---

## Control Authority

This plan intentionally follows `main` for all control behavior:

- Tap attack, drag movement, run promotion, fast-drag dash, double-fast-drag dash window, diagonal skill buttons, one-shot skill activation, hidden skill retrigger prevention, and beam firing stay as currently implemented on `main`.
- The input-threshold option feature may only change numeric values that `main` already supports through `InputController` thresholds.
- This plan must not implement the older spec-only "run hold promotion" behavior. `runHoldMs` is not part of this plan.
- This plan must not add runtime `setThresholds()` or active-pointer cancellation on option changes. Options live on the title screen; play runtime receives thresholds only when created.

## File Structure

- Create: `src/lib/game/input/inputThresholdOptions.ts`
  - Owns exposed option keys, ranges, presets, defaults, storage helpers, and conversion to the current `InputController` threshold shape.
- Create: `src/lib/game/input/inputThresholdOptions.spec.ts`
  - Covers preset values, clamping, storage fallback, and conversion while preserving current fixed internal thresholds.
- Modify: `src/lib/game/input/InputController.ts`
  - Export `InputThresholds` only. Do not change gesture logic.
- Modify: `src/lib/game/input/InputController.spec.ts`
  - Add tests proving constructor-supplied `tapMs`, `dragStartPx`, and `fastDragPxPerMs` affect existing behavior without adding new behavior.
- Modify: `src/lib/game/GameCanvas.svelte`
  - Accept `inputThresholds` and pass them into `GameRuntime`.
- Modify: `src/lib/game/runtime/GameRuntime.ts`
  - Accept optional `inputThresholds` and pass them into `InputController`.
- Modify: `src/lib/game/runtime/GameRuntime.spec.ts`
  - Verify configured thresholds reach the input controller path.
- Modify: `src/routes/+page.svelte`
  - Add an input settings section with three preset buttons, three sliders, reset action, and a small local test pad.
- Modify: `src/routes/play/+page.svelte`
  - Load saved thresholds and pass them to `GameCanvas`.
- Modify: `src/routes/layout.css`
  - Style the options controls with compact, utilitarian UI.
- Modify: `scripts/verify-browser.mjs`
  - Smoke-check that selecting the relaxed preset does not break the existing play, movement, skill, or dash flow.

## Task 1: Options Module Without Control Changes

**Files:**
- Create: `src/lib/game/input/inputThresholdOptions.ts`
- Create: `src/lib/game/input/inputThresholdOptions.spec.ts`
- Modify: `src/lib/game/input/InputController.ts`

- [ ] **Step 1: Write failing tests for option data and storage**

Create `src/lib/game/input/inputThresholdOptions.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_INPUT_THRESHOLD_OPTIONS,
	INPUT_THRESHOLD_PRESETS,
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
	});

	it('clamps user-facing values and preserves current fixed internal thresholds', () => {
		const thresholds = inputThresholdOptionsToThresholds(
			clampInputThresholdOptions({ tapMs: 999, dragStartPx: -4, fastDragPxPerMs: 0.2 })
		);

		expect(thresholds).toEqual({
			tapMs: 280,
			dragStartPx: 8,
			runDistancePx: 72,
			fastDragPxPerMs: 0.6,
			dashWindowMs: 320
		});
	});

	it('loads defaults when storage is unavailable or malformed', () => {
		expect(loadInputThresholdOptions(undefined)).toEqual(DEFAULT_INPUT_THRESHOLD_OPTIONS);

		const storage = createStorage();
		storage.setItem('one-finger-world.input-thresholds.v1', '{bad json');

		expect(loadInputThresholdOptions(storage)).toEqual(DEFAULT_INPUT_THRESHOLD_OPTIONS);
	});

	it('saves and reloads clamped values', () => {
		const storage = createStorage();

		saveInputThresholdOptions(storage, {
			tapMs: 120,
			dragStartPx: 24,
			fastDragPxPerMs: 1.2
		});

		expect(loadInputThresholdOptions(storage)).toEqual({
			tapMs: 120,
			dragStartPx: 24,
			fastDragPxPerMs: 1.2
		});
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
```

- [ ] **Step 2: Run module test to verify RED**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/inputThresholdOptions.spec.ts
```

Expected: FAIL because `inputThresholdOptions.ts` does not exist.

- [ ] **Step 3: Export the existing threshold type**

In `src/lib/game/input/InputController.ts`, change only the threshold interface declaration:

```ts
export interface InputThresholds {
	tapMs: number;
	dragStartPx: number;
	runDistancePx: number;
	fastDragPxPerMs: number;
	dashWindowMs: number;
}
```

Do not add fields. Do not change `DEFAULT_THRESHOLDS`. Do not change `getMoveMode()`.

- [ ] **Step 4: Implement the options module**

Create `src/lib/game/input/inputThresholdOptions.ts`:

```ts
import type { InputThresholds } from './InputController';

export interface InputThresholdOptions {
	tapMs: number;
	dragStartPx: number;
	fastDragPxPerMs: number;
}

export type InputThresholdPresetId = 'comfortable' | 'standard' | 'fast';

interface InputThresholdPreset {
	label: string;
	values: InputThresholdOptions;
}

export const INPUT_THRESHOLD_STORAGE_KEY = 'one-finger-world.input-thresholds.v1';

export const DEFAULT_INPUT_THRESHOLD_OPTIONS: InputThresholdOptions = {
	tapMs: 180,
	dragStartPx: 14,
	fastDragPxPerMs: 0.9
};

export const INPUT_THRESHOLD_PRESETS: Record<InputThresholdPresetId, InputThresholdPreset> = {
	comfortable: {
		label: '편안',
		values: { tapMs: 240, dragStartPx: 20, fastDragPxPerMs: 0.7 }
	},
	standard: {
		label: '표준',
		values: DEFAULT_INPUT_THRESHOLD_OPTIONS
	},
	fast: {
		label: '빠름',
		values: { tapMs: 140, dragStartPx: 10, fastDragPxPerMs: 1.1 }
	}
};

export const INPUT_THRESHOLD_RANGES = {
	tapMs: { min: 120, max: 280, step: 1, unit: 'ms' },
	dragStartPx: { min: 8, max: 24, step: 1, unit: 'px' },
	fastDragPxPerMs: { min: 0.6, max: 1.2, step: 0.1, unit: 'px/ms' }
} as const;

const FIXED_MAIN_THRESHOLDS = {
	runDistancePx: 72,
	dashWindowMs: 320
} as const;

export function clampInputThresholdOptions(options: Partial<InputThresholdOptions>): InputThresholdOptions {
	return {
		tapMs: clampNumber(options.tapMs, INPUT_THRESHOLD_RANGES.tapMs, DEFAULT_INPUT_THRESHOLD_OPTIONS.tapMs),
		dragStartPx: clampNumber(
			options.dragStartPx,
			INPUT_THRESHOLD_RANGES.dragStartPx,
			DEFAULT_INPUT_THRESHOLD_OPTIONS.dragStartPx
		),
		fastDragPxPerMs: clampNumber(
			options.fastDragPxPerMs,
			INPUT_THRESHOLD_RANGES.fastDragPxPerMs,
			DEFAULT_INPUT_THRESHOLD_OPTIONS.fastDragPxPerMs
		)
	};
}

export function inputThresholdOptionsToThresholds(options: InputThresholdOptions): InputThresholds {
	return {
		...clampInputThresholdOptions(options),
		...FIXED_MAIN_THRESHOLDS
	};
}

export function loadInputThresholdOptions(storage: Storage | undefined): InputThresholdOptions {
	if (!storage) return DEFAULT_INPUT_THRESHOLD_OPTIONS;

	try {
		const stored = storage.getItem(INPUT_THRESHOLD_STORAGE_KEY);
		if (!stored) return DEFAULT_INPUT_THRESHOLD_OPTIONS;
		return clampInputThresholdOptions(JSON.parse(stored) as Partial<InputThresholdOptions>);
	} catch {
		return DEFAULT_INPUT_THRESHOLD_OPTIONS;
	}
}

export function saveInputThresholdOptions(storage: Storage | undefined, options: InputThresholdOptions) {
	if (!storage) return;

	storage.setItem(INPUT_THRESHOLD_STORAGE_KEY, JSON.stringify(clampInputThresholdOptions(options)));
}

function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
	const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return Math.min(range.max, Math.max(range.min, numeric));
}
```

- [ ] **Step 5: Run module test to verify GREEN**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/inputThresholdOptions.spec.ts
```

Expected: PASS.

## Task 2: Existing Input Behavior With Custom Thresholds

**Files:**
- Modify: `src/lib/game/input/InputController.spec.ts`

- [ ] **Step 1: Add tests for constructor-supplied thresholds**

Append focused tests to `src/lib/game/input/InputController.spec.ts`:

```ts
it('uses custom tap timing thresholds for existing attack recognition', () => {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	new InputController(target, (gesture) => gestures.push(gesture), {
		tapMs: 240,
		dragStartPx: 14,
		runDistancePx: 72,
		fastDragPxPerMs: 0.9,
		dashWindowMs: 320
	});

	target.fire('pointerdown', { pointerId: 1, clientX: 20, clientY: 30, timeStamp: 0 });
	target.fire('pointerup', { pointerId: 1, clientX: 20, clientY: 30, timeStamp: 220 });

	expect(gestures).toEqual([{ type: 'attack', comboStep: 1 }]);
});

it('uses custom drag start distance without changing run promotion semantics', () => {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	new InputController(target, (gesture) => gestures.push(gesture), {
		tapMs: 180,
		dragStartPx: 20,
		runDistancePx: 72,
		fastDragPxPerMs: 0.9,
		dashWindowMs: 320
	});

	target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: 0 });
	target.fire('pointermove', { pointerId: 1, clientX: 116, clientY: 100, timeStamp: 20 });
	target.fire('pointermove', { pointerId: 1, clientX: 121, clientY: 100, timeStamp: 40 });
	target.fire('pointermove', { pointerId: 1, clientX: 180, clientY: 100, timeStamp: 60 });

	expect(gestures).toEqual([
		{ type: 'move', mode: 'walk', direction: { x: 1, y: 0 } },
		{ type: 'move', mode: 'run', direction: { x: 1, y: 0 } }
	]);
});

it('uses custom fast drag speed for the existing double-drag dash', () => {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	new InputController(target, (gesture) => gestures.push(gesture), {
		tapMs: 180,
		dragStartPx: 14,
		runDistancePx: 72,
		fastDragPxPerMs: 0.6,
		dashWindowMs: 320
	});

	target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
	target.fire('pointermove', { pointerId: 1, clientX: 60, clientY: 0, timeStamp: 30 });
	target.fire('pointerup', { pointerId: 1, clientX: 60, clientY: 0, timeStamp: 110 });
	target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 180 });
	target.fire('pointermove', { pointerId: 1, clientX: 60, clientY: 0, timeStamp: 210 });
	target.fire('pointerup', { pointerId: 1, clientX: 60, clientY: 0, timeStamp: 290 });

	expect(gestures.at(-1)).toEqual({ type: 'dash', direction: { x: 1, y: 0 } });
});
```

- [ ] **Step 2: Run input tests**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: PASS. If this fails because implementation changed beyond current `main`, remove that implementation change rather than adapting tests to new behavior.

## Task 3: Pass Saved Thresholds Into Runtime

**Files:**
- Modify: `src/lib/game/GameCanvas.svelte`
- Modify: `src/lib/game/runtime/GameRuntime.ts`
- Modify: `src/lib/game/runtime/GameRuntime.spec.ts`
- Modify: `src/routes/play/+page.svelte`

- [ ] **Step 1: Add runtime wiring**

Add `inputThresholds?: InputThresholds` to `GameRuntimeOptions`, pass it to the `InputController` constructor, add an `inputThresholds` prop to `GameCanvas`, and load saved options in `src/routes/play/+page.svelte`.

- [ ] **Step 2: Add a runtime test**

Add a runtime spec that constructs `GameRuntime` with `inputThresholds: { tapMs: 240, dragStartPx: 20, runDistancePx: 72, fastDragPxPerMs: 0.7, dashWindowMs: 320 }`, fires a 220 ms same-point pointer down/up through the fake renderer `domElement`, and expects `Attack 1`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/inputThresholdOptions.spec.ts src/lib/game/input/InputController.spec.ts src/lib/game/runtime/GameRuntime.spec.ts
```

Expected: PASS.

## Task 4: Options UI And Browser Smoke

**Files:**
- Modify: `src/routes/+page.svelte`
- Modify: `src/routes/layout.css`
- Modify: `scripts/verify-browser.mjs`

- [ ] **Step 1: Add title-screen options UI**

Add compact controls for presets (`편안`, `표준`, `빠름`), sliders for `탭 인식 시간`, `드래그 시작 거리`, and `대시 빠르기`, a reset action, and a small test pad. The test pad should mirror current `main` input logic only: tap duration, drag start distance, and fast-drag speed feedback.

- [ ] **Step 2: Extend browser smoke**

Before starting the game, click `편안`, verify the `탭 인식 시간` value shows `240 ms`, then start the game and keep the existing canvas, attack, movement, skill, and dash checks.

- [ ] **Step 3: Run full verification ladder**

Run:

```bash
bun run lint
bun run test
bun run check
bun run build
bun run verify:browser
```

Expected: all commands PASS.

## Self-Review Checklist

- `main` control behavior is authoritative.
- No `runHoldMs` field is added.
- No time-based run promotion is added.
- No runtime `setThresholds()` or active pointer cancellation policy is added.
- Skill-button behavior remains unchanged.
- Exposed options are exactly tap recognition time, drag start distance, and dash speed.
- Fixed internal thresholds remain current `main` values: `runDistancePx = 72`, `dashWindowMs = 320`.
- Presets match `편안` 240/20/0.7, `표준` 180/14/0.9, and `빠름` 140/10/1.1.
- Min/default/max clamp to 120/180/280, 8/14/24, and 0.6/0.9/1.2.
- Browser verification touches the options UI before play and still covers existing skill controls.
