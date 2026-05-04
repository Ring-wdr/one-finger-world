# One-Finger 3D Action Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Svelte + Three.js prototype that validates one-finger tap, drag, run, combo attack, and dash controls in a textureless 3D sandbox.

**Architecture:** SvelteKit owns route screens and HUD. `/` is the title route, `/play` is the play route, and `GameCanvas.svelte` is the only Svelte-to-Three bridge. Three.js runtime code is created only inside client mount, owns the renderer, scene, camera, input, player, world, and cleanup, and reports action state back to Svelte through a cleared-on-dispose callback.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript, Bun, Vite/Vitest, Playwright, Three.js.

---

## File Structure

- `package.json`: add `three` dependency and `verify:browser` script.
- `bun.lock`: updated by `bun add three`.
- `src/routes/+page.svelte`: title route with `Game Start`.
- `src/routes/play/+page.svelte`: play route with HUD and `GameCanvas`.
- `src/routes/layout.css`: full-screen app, mobile gesture suppression, title/play styling.
- `src/lib/game/types.ts`: shared action, input, runtime callback, and vector types.
- `src/lib/game/GameCanvas.svelte`: client-only dynamic import and runtime mount/dispose bridge.
- `src/lib/game/input/InputController.ts`: one active pointer recognizer for tap, drag, run, fast drag, dash, cancel, and lost capture.
- `src/lib/game/input/InputController.spec.ts`: node unit tests for the recognizer.
- `src/lib/game/actors/PlayerActor.ts`: textureless SD primitive character and attack arc.
- `src/lib/game/world/BlockWorld.ts`: temporary block field and rectangular boundary clamp.
- `src/lib/game/runtime/GameRuntime.ts`: Three renderer, scene, camera follow, movement, dash, HUD state, resize, and cleanup.
- `scripts/verify-browser.mjs`: Playwright smoke check for route flow, HUD transitions, and nonblank canvas at mobile and desktop viewports.

---

### Task 1: Commit The Existing SvelteKit Scaffold

**Files:**
- Stage existing untracked scaffold files only.
- Do not stage `.superpowers/`.

- [ ] **Step 1: Confirm scaffold verification passes before taking ownership**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

- [ ] **Step 2: Commit the scaffold baseline**

Run:

```powershell
git add -- .npmrc .vscode README.md bun.lock eslint.config.js package.json src static svelte.config.js tsconfig.json vite.config.ts
git commit -m "chore: commit SvelteKit scaffold"
```

Expected: a new commit is created and the working tree contains only future implementation changes.

---

### Task 2: Add Three.js Dependency

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Install Three.js**

Run:

```powershell
bun add three
```

Expected: `package.json` contains a `dependencies.three` entry and `bun.lock` changes.

- [ ] **Step 2: Verify dependency install keeps the scaffold healthy**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

- [ ] **Step 3: Commit dependency setup**

Run:

```powershell
git add -- package.json bun.lock
git commit -m "chore: add Three.js dependency"
```

Expected: one dependency commit with only `package.json` and `bun.lock`.

---

### Task 3: Add Route Shell, Shared Types, And Global Layout

**Files:**
- Modify: `src/routes/+page.svelte`
- Create: `src/routes/play/+page.svelte`
- Modify: `src/routes/layout.css`
- Create: `src/lib/game/types.ts`
- Create: `src/lib/game/GameCanvas.svelte`

- [ ] **Step 1: Add shared game types**

Create `src/lib/game/types.ts`:

```ts
export type ComboStep = 1 | 2 | 3;

export type ActionKind = 'idle' | 'walk' | 'run' | 'attack' | 'dash';

export interface Direction2 {
	x: number;
	y: number;
}

export interface ActionState {
	kind: ActionKind;
	label: string;
	direction?: Direction2;
	comboStep?: ComboStep;
}

export type MoveMode = 'walk' | 'run';

export type InputGesture =
	| { type: 'attack'; comboStep: ComboStep }
	| { type: 'move'; mode: MoveMode; direction: Direction2 }
	| { type: 'dash'; direction: Direction2 }
	| { type: 'idle' };

export type ActionStateHandler = (state: ActionState) => void;
export type RuntimeErrorHandler = (message: string) => void;

export const IDLE_ACTION: ActionState = { kind: 'idle', label: 'Idle' };
```

- [ ] **Step 2: Replace the title route**

Replace `src/routes/+page.svelte`:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';

	function startGame() {
		void goto('/play');
	}
</script>

<svelte:head>
	<title>One Finger Act</title>
</svelte:head>

<main class="title-screen">
	<section class="title-panel" aria-labelledby="title-heading">
		<p class="title-kicker">Svelte + Three.js Prototype</p>
		<h1 id="title-heading">One Finger Act</h1>
		<button class="start-button" type="button" onclick={startGame}>Game Start</button>
	</section>
</main>
```

- [ ] **Step 3: Add the play route**

Create `src/routes/play/+page.svelte`:

```svelte
<script lang="ts">
	import GameCanvas from '$lib/game/GameCanvas.svelte';
	import { IDLE_ACTION, type ActionState } from '$lib/game/types';

	let actionState = $state<ActionState>(IDLE_ACTION);
	let runtimeError = $state<string | null>(null);

	function handleActionStateChange(nextState: ActionState) {
		actionState = nextState;
	}

	function handleRuntimeError(message: string) {
		runtimeError = message;
	}
</script>

<svelte:head>
	<title>Play - One Finger Act</title>
</svelte:head>

<main class="play-screen">
	<GameCanvas
		onActionStateChange={handleActionStateChange}
		onRuntimeError={handleRuntimeError}
	/>

	<div class="hud" aria-live="polite">
		<span class="hud-label">State</span>
		<strong>{actionState.label}</strong>
	</div>

	{#if runtimeError}
		<div class="runtime-error" role="alert">{runtimeError}</div>
	{/if}
</main>
```

- [ ] **Step 4: Add the client-only bridge shell**

Create `src/lib/game/GameCanvas.svelte`:

```svelte
<script lang="ts">
	import type { ActionStateHandler, RuntimeErrorHandler } from '$lib/game/types';

	let {
		onActionStateChange,
		onRuntimeError
	}: {
		onActionStateChange: ActionStateHandler;
		onRuntimeError: RuntimeErrorHandler;
	} = $props();
</script>

<div
	class="game-canvas"
	aria-label="3D action prototype play surface"
	data-action-handler={onActionStateChange ? 'ready' : 'missing'}
	data-error-handler={onRuntimeError ? 'ready' : 'missing'}
></div>
```

- [ ] **Step 5: Replace global CSS**

Replace `src/routes/layout.css`:

```css
@import 'tailwindcss';

:root {
	font-family:
		Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	color: #f7f3e8;
	background: #111514;
}

* {
	box-sizing: border-box;
}

html,
body {
	margin: 0;
	min-height: 100%;
	overflow: hidden;
}

body {
	min-height: 100dvh;
	touch-action: none;
	user-select: none;
	overscroll-behavior: none;
}

button {
	font: inherit;
}

.title-screen,
.play-screen {
	position: relative;
	width: 100vw;
	min-height: 100dvh;
	overflow: hidden;
}

.title-screen {
	display: grid;
	place-items: center;
	padding: 24px;
	background:
		linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0)),
		#151a18;
}

.title-panel {
	display: grid;
	gap: 18px;
	justify-items: center;
	text-align: center;
}

.title-kicker {
	margin: 0;
	font-size: 0.78rem;
	letter-spacing: 0;
	text-transform: uppercase;
	color: #a9c8b1;
}

.title-panel h1 {
	margin: 0;
	font-size: clamp(3rem, 12vw, 7rem);
	line-height: 0.9;
	font-weight: 900;
}

.start-button {
	min-width: 180px;
	border: 1px solid rgba(255, 255, 255, 0.28);
	border-radius: 8px;
	padding: 14px 22px;
	color: #101312;
	background: #f6d365;
	box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
	cursor: pointer;
}

.play-screen {
	background: #0f1412;
}

.game-canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	touch-action: none;
	user-select: none;
	overscroll-behavior: none;
}

.game-canvas canvas {
	display: block;
	width: 100%;
	height: 100%;
}

.hud {
	position: absolute;
	top: max(14px, env(safe-area-inset-top));
	left: max(14px, env(safe-area-inset-left));
	z-index: 2;
	display: inline-grid;
	gap: 2px;
	min-width: 112px;
	border: 1px solid rgba(255, 255, 255, 0.2);
	border-radius: 8px;
	padding: 10px 12px;
	background: rgba(14, 18, 17, 0.72);
	backdrop-filter: blur(10px);
	pointer-events: none;
}

.hud-label {
	font-size: 0.7rem;
	line-height: 1;
	color: #b4c9bb;
}

.hud strong {
	font-size: 1rem;
	line-height: 1.15;
}

.runtime-error {
	position: absolute;
	right: max(14px, env(safe-area-inset-right));
	bottom: max(14px, env(safe-area-inset-bottom));
	z-index: 3;
	max-width: min(420px, calc(100vw - 28px));
	border: 1px solid rgba(255, 120, 120, 0.45);
	border-radius: 8px;
	padding: 12px 14px;
	background: rgba(75, 21, 21, 0.86);
	color: #ffe6e6;
	pointer-events: none;
}
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

Run:

```powershell
git add -- src/routes/+page.svelte src/routes/play/+page.svelte src/routes/layout.css src/lib/game/types.ts src/lib/game/GameCanvas.svelte
git commit -m "feat: add title and play route shell"
```

---

### Task 4: Build The One-Finger Input Recognizer With Unit Tests

**Files:**
- Create: `src/lib/game/input/InputController.spec.ts`
- Create: `src/lib/game/input/InputController.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/game/input/InputController.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InputGesture } from '$lib/game/types';
import { InputController, type PointerSurface } from './InputController';

type Listener = (event: PointerEvent) => void;
type ListenerMap = Record<string, Listener[]>;

class FakePointerSurface implements PointerSurface {
	readonly listeners: ListenerMap = {};
	readonly captured = new Set<number>();
	readonly released = new Set<number>();

	addEventListener(type: string, listener: Listener) {
		this.listeners[type] ??= [];
		this.listeners[type].push(listener);
	}

	removeEventListener(type: string, listener: Listener) {
		this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener);
	}

	setPointerCapture(pointerId: number) {
		this.captured.add(pointerId);
	}

	releasePointerCapture(pointerId: number) {
		this.released.add(pointerId);
		this.captured.delete(pointerId);
	}

	fire(type: string, event: Partial<PointerEvent>) {
		const sample = {
			pointerId: 1,
			clientX: 0,
			clientY: 0,
			timeStamp: 0,
			button: 0,
			preventDefault: () => undefined,
			...event
		} as PointerEvent;

		for (const listener of this.listeners[type] ?? []) {
			listener(sample);
		}
	}
}

function setup() {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	const controller = new InputController(target, (gesture) => gestures.push(gesture));

	return { target, gestures, controller };
}

describe('InputController', () => {
	it('recognizes taps and cycles attack combo steps', () => {
		const { target, gestures } = setup();

		for (let index = 0; index < 4; index += 1) {
			const start = index * 220;
			target.fire('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: start });
			target.fire('pointerup', { pointerId: 1, clientX: 22, clientY: 10, timeStamp: start + 180 });
		}

		expect(gestures).toEqual([
			{ type: 'attack', comboStep: 1 },
			{ type: 'attack', comboStep: 2 },
			{ type: 'attack', comboStep: 3 },
			{ type: 'attack', comboStep: 1 }
		]);
	});

	it('starts dragging at 14 px and prevents that press from becoming an attack', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 114, clientY: 100, timeStamp: 80 });
		target.fire('pointerup', { pointerId: 1, clientX: 114, clientY: 100, timeStamp: 120 });

		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: -0 } },
			{ type: 'idle' }
		]);
	});

	it('upgrades drag to run by hold duration', () => {
		const { target, gestures, controller } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 0, timeStamp: 100 });
		controller.update(551);

		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: -0 } },
			{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } }
		]);
	});

	it('upgrades drag to run by drag distance', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 72, clientY: 0, timeStamp: 140 });

		expect(gestures).toEqual([{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } }]);
	});

	it('requires two fast drags inside the dash window', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 60 });
		target.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 80 });

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 260 });
		target.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 320 });
		target.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 340 });

		expect(gestures).toEqual([
			{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } },
			{ type: 'dash', direction: { x: 1, y: -0 } }
		]);
	});

	it('resets active drag state on pointercancel and lost capture', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 7, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 7, clientX: 30, clientY: 0, timeStamp: 90 });
		target.fire('pointercancel', { pointerId: 7, clientX: 30, clientY: 0, timeStamp: 100 });

		target.fire('pointerdown', { pointerId: 8, clientX: 0, clientY: 0, timeStamp: 200 });
		target.fire('pointermove', { pointerId: 8, clientX: 0, clientY: -30, timeStamp: 260 });
		target.fire('lostpointercapture', { pointerId: 8, clientX: 0, clientY: -30, timeStamp: 270 });

		expect(target.released.has(7)).toBe(true);
		expect(target.released.has(8)).toBe(true);
		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: -0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'walk', direction: { x: 0, y: 1 } },
			{ type: 'idle' }
		]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: FAIL because `InputController.ts` does not exist.

- [ ] **Step 3: Implement the recognizer**

Create `src/lib/game/input/InputController.ts`:

```ts
import type { ComboStep, Direction2, InputGesture, MoveMode } from '$lib/game/types';

export interface PointerSurface {
	addEventListener(type: string, listener: (event: PointerEvent) => void): void;
	removeEventListener(type: string, listener: (event: PointerEvent) => void): void;
	setPointerCapture?(pointerId: number): void;
	releasePointerCapture?(pointerId: number): void;
}

interface InputThresholds {
	tapMs: number;
	dragStartPx: number;
	runHoldMs: number;
	runDistancePx: number;
	fastDragPxPerMs: number;
	dashWindowMs: number;
}

const DEFAULT_THRESHOLDS: InputThresholds = {
	tapMs: 180,
	dragStartPx: 14,
	runHoldMs: 450,
	runDistancePx: 72,
	fastDragPxPerMs: 0.9,
	dashWindowMs: 320
};

interface ActivePointer {
	pointerId: number;
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	startTime: number;
	dragStartTime: number | null;
	dragging: boolean;
	lastDirection: Direction2;
	lastMode: MoveMode | null;
}

export class InputController {
	private active: ActivePointer | null = null;
	private comboStep: ComboStep = 1;
	private lastFastDragTime: number | null = null;
	private disposed = false;

	constructor(
		private readonly target: PointerSurface,
		private readonly emit: (gesture: InputGesture) => void,
		private readonly thresholds: InputThresholds = DEFAULT_THRESHOLDS
	) {
		this.target.addEventListener('pointerdown', this.handlePointerDown);
		this.target.addEventListener('pointermove', this.handlePointerMove);
		this.target.addEventListener('pointerup', this.handlePointerUp);
		this.target.addEventListener('pointercancel', this.handlePointerCancel);
		this.target.addEventListener('lostpointercapture', this.handleLostPointerCapture);
	}

	update(now: number) {
		if (!this.active?.dragging || this.disposed) return;

		const nextMode = this.getMoveMode(this.active, now);
		if (nextMode !== this.active.lastMode) {
			this.active.lastMode = nextMode;
			this.emit({ type: 'move', mode: nextMode, direction: this.active.lastDirection });
		}
	}

	dispose() {
		if (this.disposed) return;

		this.releaseActivePointer();
		this.target.removeEventListener('pointerdown', this.handlePointerDown);
		this.target.removeEventListener('pointermove', this.handlePointerMove);
		this.target.removeEventListener('pointerup', this.handlePointerUp);
		this.target.removeEventListener('pointercancel', this.handlePointerCancel);
		this.target.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
		this.active = null;
		this.disposed = true;
	}

	private readonly handlePointerDown = (event: PointerEvent) => {
		if (this.disposed) return;
		if (event.button !== undefined && event.button !== 0) return;
		if (this.active) return;

		event.preventDefault();
		this.active = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			currentX: event.clientX,
			currentY: event.clientY,
			startTime: event.timeStamp,
			dragStartTime: null,
			dragging: false,
			lastDirection: { x: 0, y: 1 },
			lastMode: null
		};

		this.target.setPointerCapture?.(event.pointerId);
	};

	private readonly handlePointerMove = (event: PointerEvent) => {
		const active = this.getMatchingActivePointer(event);
		if (!active) return;

		event.preventDefault();
		active.currentX = event.clientX;
		active.currentY = event.clientY;

		const distance = this.distanceFromStart(active);
		if (!active.dragging && distance >= this.thresholds.dragStartPx) {
			active.dragging = true;
			active.dragStartTime = event.timeStamp;
		}

		if (!active.dragging) return;

		active.lastDirection = this.directionFromStart(active);
		const mode = this.getMoveMode(active, event.timeStamp);
		active.lastMode = mode;
		this.emit({ type: 'move', mode, direction: active.lastDirection });
	};

	private readonly handlePointerUp = (event: PointerEvent) => {
		const active = this.getMatchingActivePointer(event);
		if (!active) return;

		event.preventDefault();
		active.currentX = event.clientX;
		active.currentY = event.clientY;

		const duration = event.timeStamp - active.startTime;
		const distance = this.distanceFromStart(active);

		if (!active.dragging) {
			this.releaseActivePointer();
			this.active = null;

			if (duration <= this.thresholds.tapMs && distance < this.thresholds.dragStartPx) {
				const comboStep = this.comboStep;
				this.comboStep = this.comboStep === 3 ? 1 : ((this.comboStep + 1) as ComboStep);
				this.emit({ type: 'attack', comboStep });
			} else {
				this.emit({ type: 'idle' });
			}
			return;
		}

		const direction = this.directionFromStart(active);
		const speed = distance / Math.max(1, duration);
		this.releaseActivePointer();
		this.active = null;

		if (speed >= this.thresholds.fastDragPxPerMs) {
			if (
				this.lastFastDragTime !== null &&
				event.timeStamp - this.lastFastDragTime <= this.thresholds.dashWindowMs
			) {
				this.lastFastDragTime = null;
				this.emit({ type: 'dash', direction });
				return;
			}

			this.lastFastDragTime = event.timeStamp;
		}

		this.emit({ type: 'idle' });
	};

	private readonly handlePointerCancel = (event: PointerEvent) => {
		if (!this.getMatchingActivePointer(event)) return;
		this.releaseActivePointer();
		this.active = null;
		this.emit({ type: 'idle' });
	};

	private readonly handleLostPointerCapture = (event: PointerEvent) => {
		if (!this.getMatchingActivePointer(event)) return;
		this.releaseActivePointer();
		this.active = null;
		this.emit({ type: 'idle' });
	};

	private getMatchingActivePointer(event: PointerEvent) {
		if (this.disposed || !this.active || this.active.pointerId !== event.pointerId) {
			return null;
		}

		return this.active;
	}

	private releaseActivePointer() {
		if (!this.active) return;
		this.target.releasePointerCapture?.(this.active.pointerId);
	}

	private distanceFromStart(active: ActivePointer) {
		return Math.hypot(active.currentX - active.startX, active.currentY - active.startY);
	}

	private directionFromStart(active: ActivePointer): Direction2 {
		const dx = active.currentX - active.startX;
		const dy = active.currentY - active.startY;
		const length = Math.hypot(dx, dy);

		if (length === 0) return { x: 0, y: 1 };

		return normalizeSignedZero({ x: dx / length, y: -dy / length });
	}

	private getMoveMode(active: ActivePointer, now: number): MoveMode {
		const distance = this.distanceFromStart(active);
		const dragStartTime = active.dragStartTime ?? active.startTime;
		const heldLongEnough = now - dragStartTime >= this.thresholds.runHoldMs;
		const draggedFarEnough = distance >= this.thresholds.runDistancePx;

		return heldLongEnough || draggedFarEnough ? 'run' : 'walk';
	}
}

function normalizeSignedZero(direction: Direction2): Direction2 {
	return {
		x: Object.is(direction.x, -0) ? 0 : direction.x,
		y: Object.is(direction.y, -0) ? -0 : direction.y
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: PASS for all six `InputController` tests.

- [ ] **Step 5: Run full verification and commit**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

Run:

```powershell
git add -- src/lib/game/input/InputController.ts src/lib/game/input/InputController.spec.ts
git commit -m "feat: add one-finger input recognizer"
```

---

### Task 5: Add The SD Player Actor And Block World

**Files:**
- Create: `src/lib/game/actors/PlayerActor.ts`
- Create: `src/lib/game/world/BlockWorld.ts`

- [ ] **Step 1: Implement the SD primitive player**

Create `src/lib/game/actors/PlayerActor.ts`:

```ts
import * as THREE from 'three';
import type { ComboStep } from '$lib/game/types';

const BODY_COLOR = 0xd84f3f;
const HEAD_COLOR = 0xf0d2b8;
const LIMB_COLOR = 0x2e4454;
const MARKER_COLOR = 0x151515;
const ARC_COLOR = 0xf6d365;

export class PlayerActor {
	readonly group = new THREE.Group();

	private readonly attackArc: THREE.Mesh;
	private readonly leftArm: THREE.Mesh;
	private readonly rightArm: THREE.Mesh;
	private readonly leftLeg: THREE.Mesh;
	private readonly rightLeg: THREE.Mesh;
	private attackTimeRemaining = 0;
	private comboStep: ComboStep = 1;

	constructor() {
		this.group.name = 'PlayerActor';

		const body = new THREE.Mesh(
			new THREE.CapsuleGeometry(0.32, 0.46, 6, 12),
			new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.62 })
		);
		body.position.y = 0.88;
		body.scale.set(0.95, 1, 0.82);
		this.group.add(body);

		const head = new THREE.Mesh(
			new THREE.SphereGeometry(0.42, 18, 12),
			new THREE.MeshStandardMaterial({ color: HEAD_COLOR, roughness: 0.72 })
		);
		head.position.y = 1.48;
		this.group.add(head);

		const faceMarker = new THREE.Mesh(
			new THREE.BoxGeometry(0.12, 0.08, 0.035),
			new THREE.MeshBasicMaterial({ color: MARKER_COLOR })
		);
		faceMarker.position.set(0, 1.5, -0.405);
		this.group.add(faceMarker);

		this.leftArm = this.createLimb(-0.39, 0.9);
		this.rightArm = this.createLimb(0.39, 0.9);
		this.leftLeg = this.createLimb(-0.18, 0.36);
		this.rightLeg = this.createLimb(0.18, 0.36);

		const arcGeometry = new THREE.RingGeometry(0.5, 0.74, 32, 1, -Math.PI / 3, (Math.PI * 2) / 3);
		this.attackArc = new THREE.Mesh(
			arcGeometry,
			new THREE.MeshBasicMaterial({
				color: ARC_COLOR,
				transparent: true,
				opacity: 0.78,
				side: THREE.DoubleSide
			})
		);
		this.attackArc.position.set(0, 0.08, -0.62);
		this.attackArc.rotation.x = -Math.PI / 2;
		this.attackArc.visible = false;
		this.group.add(this.attackArc);
	}

	setPosition(position: THREE.Vector3) {
		this.group.position.copy(position);
	}

	faceWorldDirection(direction: THREE.Vector3) {
		if (direction.lengthSq() <= 0.0001) return;
		this.group.rotation.y = Math.atan2(direction.x, direction.z);
	}

	playAttack(comboStep: ComboStep) {
		this.comboStep = comboStep;
		this.attackTimeRemaining = 0.22;
		this.attackArc.visible = true;
		this.attackArc.scale.setScalar(1 + (comboStep - 1) * 0.14);
	}

	update(deltaSeconds: number, moving: boolean, running: boolean, dashing: boolean) {
		const time = performance.now() / 1000;
		const stride = running ? 10 : 6;
		const swing = moving || dashing ? Math.sin(time * stride) * 0.38 : 0;

		this.leftArm.rotation.x = swing;
		this.rightArm.rotation.x = -swing;
		this.leftLeg.rotation.x = -swing;
		this.rightLeg.rotation.x = swing;
		this.group.rotation.z = dashing ? -0.12 : moving ? -0.04 : 0;

		if (this.attackTimeRemaining > 0) {
			this.attackTimeRemaining = Math.max(0, this.attackTimeRemaining - deltaSeconds);
			this.attackArc.visible = this.attackTimeRemaining > 0;
			this.attackArc.rotation.z = (this.comboStep - 2) * 0.18;
		}
	}

	dispose() {
		this.group.traverse((object) => {
			if (!(object instanceof THREE.Mesh)) return;
			object.geometry.dispose();

			if (Array.isArray(object.material)) {
				for (const material of object.material) material.dispose();
			} else {
				object.material.dispose();
			}
		});
	}

	private createLimb(x: number, y: number) {
		const limb = new THREE.Mesh(
			new THREE.CapsuleGeometry(0.09, 0.32, 4, 8),
			new THREE.MeshStandardMaterial({ color: LIMB_COLOR, roughness: 0.7 })
		);
		limb.position.set(x, y, 0);
		this.group.add(limb);
		return limb;
	}
}
```

- [ ] **Step 2: Implement the temporary block world**

Create `src/lib/game/world/BlockWorld.ts`:

```ts
import * as THREE from 'three';

export interface WorldBounds {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
}

const FLOOR_COLOR = 0x77a75f;
const BLOCK_COLORS = [0x8d6f4d, 0xb9aa63, 0x6d9159, 0x7a8d9d];

export class BlockWorld {
	readonly group = new THREE.Group();
	readonly bounds: WorldBounds = { minX: -7.5, maxX: 7.5, minZ: -7.5, maxZ: 7.5 };

	constructor() {
		this.group.name = 'BlockWorld';
		this.createFloor();
		this.createBlocks();
	}

	clampPosition(position: THREE.Vector3) {
		position.x = THREE.MathUtils.clamp(position.x, this.bounds.minX, this.bounds.maxX);
		position.z = THREE.MathUtils.clamp(position.z, this.bounds.minZ, this.bounds.maxZ);
		return position;
	}

	dispose() {
		this.group.traverse((object) => {
			if (!(object instanceof THREE.Mesh)) return;
			object.geometry.dispose();

			if (Array.isArray(object.material)) {
				for (const material of object.material) material.dispose();
			} else {
				object.material.dispose();
			}
		});
	}

	private createFloor() {
		const floor = new THREE.Mesh(
			new THREE.BoxGeometry(16, 0.28, 16),
			new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.86 })
		);
		floor.position.y = -0.14;
		floor.receiveShadow = true;
		this.group.add(floor);
	}

	private createBlocks() {
		const placements = [
			{ x: -3.8, z: -2.8, w: 1.2, h: 0.8, d: 1.2, color: 0 },
			{ x: 3.2, z: -3.3, w: 1.6, h: 1.4, d: 1.1, color: 1 },
			{ x: -4.8, z: 2.7, w: 1.4, h: 1.2, d: 1.8, color: 2 },
			{ x: 4.2, z: 2.4, w: 1.1, h: 0.7, d: 2.2, color: 3 },
			{ x: 0.5, z: 4.8, w: 2.2, h: 0.5, d: 1.1, color: 1 }
		];

		for (const placement of placements) {
			const block = new THREE.Mesh(
				new THREE.BoxGeometry(placement.w, placement.h, placement.d),
				new THREE.MeshStandardMaterial({
					color: BLOCK_COLORS[placement.color],
					roughness: 0.82
				})
			);
			block.position.set(placement.x, placement.h / 2, placement.z);
			block.castShadow = true;
			block.receiveShadow = true;
			this.group.add(block);
		}
	}
}
```

- [ ] **Step 3: Verify and commit**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

Run:

```powershell
git add -- src/lib/game/actors/PlayerActor.ts src/lib/game/world/BlockWorld.ts
git commit -m "feat: add prototype player and block world"
```

---

### Task 6: Implement The Three.js Runtime And Client Mount Bridge

**Files:**
- Create: `src/lib/game/runtime/GameRuntime.ts`
- Modify: `src/lib/game/GameCanvas.svelte`

- [ ] **Step 1: Implement `GameRuntime`**

Create `src/lib/game/runtime/GameRuntime.ts`:

```ts
import * as THREE from 'three';
import { PlayerActor } from '$lib/game/actors/PlayerActor';
import { InputController } from '$lib/game/input/InputController';
import type { ActionState, ActionStateHandler, Direction2, InputGesture, RuntimeErrorHandler } from '$lib/game/types';
import { IDLE_ACTION } from '$lib/game/types';
import { BlockWorld } from '$lib/game/world/BlockWorld';

interface GameRuntimeOptions {
	container: HTMLElement;
	onActionStateChange: ActionStateHandler;
	onRuntimeError: RuntimeErrorHandler;
}

const WALK_SPEED = 2.2;
const RUN_SPEED = 4.4;
const DASH_SPEED = 9.5;
const DASH_SECONDS = 0.18;
const CAMERA_DAMPING = 8;
const CAMERA_OFFSET = new THREE.Vector3(0, 7.2, 7.8);
const CAMERA_TARGET_OFFSET = new THREE.Vector3(0, 0.85, 0);

export class GameRuntime {
	private renderer: THREE.WebGLRenderer | null = null;
	private scene: THREE.Scene | null = null;
	private camera: THREE.PerspectiveCamera | null = null;
	private input: InputController | null = null;
	private player: PlayerActor | null = null;
	private world: BlockWorld | null = null;
	private animationFrame = 0;
	private disposed = false;
	private lastTime = performance.now();
	private movementDirection: THREE.Vector3 | null = null;
	private movementMode: 'walk' | 'run' | null = null;
	private dashDirection: THREE.Vector3 | null = null;
	private dashRemaining = 0;
	private attackRemaining = 0;
	private currentLabel = '';
	private onActionStateChange: ActionStateHandler | null;

	constructor(private readonly options: GameRuntimeOptions) {
		this.onActionStateChange = options.onActionStateChange;

		try {
			this.initialize();
			this.setAction(IDLE_ACTION);
			this.lastTime = performance.now();
			this.animationFrame = requestAnimationFrame(this.tick);
		} catch (error) {
			this.dispose();
			options.onRuntimeError(error instanceof Error ? error.message : 'Unable to initialize WebGL runtime.');
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;

		if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
		window.removeEventListener('resize', this.handleResize);
		this.input?.dispose();
		this.player?.dispose();
		this.world?.dispose();
		this.renderer?.dispose();

		const canvas = this.renderer?.domElement;
		canvas?.parentElement?.removeChild(canvas);

		this.input = null;
		this.player = null;
		this.world = null;
		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.onActionStateChange = null;
	}

	private initialize() {
		const { container } = this.options;
		const width = Math.max(1, container.clientWidth);
		const height = Math.max(1, container.clientHeight);

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x9fc3e6);

		this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
		this.camera.position.copy(CAMERA_OFFSET);
		this.camera.lookAt(CAMERA_TARGET_OFFSET);

		this.renderer = new THREE.WebGLRenderer({
			antialias: true,
			alpha: false,
			preserveDrawingBuffer: true
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(width, height, false);
		this.renderer.shadowMap.enabled = true;
		container.appendChild(this.renderer.domElement);

		const hemisphere = new THREE.HemisphereLight(0xffffff, 0x5f6a52, 2.2);
		this.scene.add(hemisphere);

		const directional = new THREE.DirectionalLight(0xffffff, 2.4);
		directional.position.set(-3, 7, 5);
		directional.castShadow = true;
		this.scene.add(directional);

		this.world = new BlockWorld();
		this.scene.add(this.world.group);

		this.player = new PlayerActor();
		this.player.setPosition(new THREE.Vector3(0, 0, 0));
		this.scene.add(this.player.group);

		this.input = new InputController(this.renderer.domElement, this.handleGesture);
		window.addEventListener('resize', this.handleResize);
		this.handleResize();
	}

	private readonly tick = (now: number) => {
		if (this.disposed) return;

		const deltaSeconds = Math.min(0.05, (now - this.lastTime) / 1000);
		this.lastTime = now;
		this.input?.update(now);
		this.updateMovement(deltaSeconds);
		this.updateCamera(deltaSeconds);
		this.render();
		this.animationFrame = requestAnimationFrame(this.tick);
	};

	private updateMovement(deltaSeconds: number) {
		if (!this.player || !this.world) return;

		const position = this.player.group.position.clone();
		let moving = false;
		let running = false;
		let dashing = false;
		let facingDirection: THREE.Vector3 | null = null;

		if (this.dashRemaining > 0 && this.dashDirection) {
			const step = this.dashDirection.clone().multiplyScalar(DASH_SPEED * deltaSeconds);
			position.add(step);
			this.dashRemaining = Math.max(0, this.dashRemaining - deltaSeconds);
			moving = true;
			dashing = true;
			facingDirection = this.dashDirection;
			if (this.dashRemaining === 0 && !this.movementDirection) this.setAction(IDLE_ACTION);
		} else if (this.movementDirection && this.movementMode) {
			const speed = this.movementMode === 'run' ? RUN_SPEED : WALK_SPEED;
			position.add(this.movementDirection.clone().multiplyScalar(speed * deltaSeconds));
			moving = true;
			running = this.movementMode === 'run';
			facingDirection = this.movementDirection;
		}

		this.world.clampPosition(position);
		this.player.setPosition(position);
		if (facingDirection) this.player.faceWorldDirection(facingDirection);

		if (this.attackRemaining > 0) {
			this.attackRemaining = Math.max(0, this.attackRemaining - deltaSeconds);
			if (this.attackRemaining === 0 && !moving && !dashing) this.setAction(IDLE_ACTION);
		}

		this.player.update(deltaSeconds, moving, running, dashing);
	}

	private updateCamera(deltaSeconds: number) {
		if (!this.camera || !this.player) return;

		const target = this.player.group.position.clone().add(CAMERA_TARGET_OFFSET);
		const desiredPosition = this.player.group.position.clone().add(CAMERA_OFFSET);
		const blend = 1 - Math.exp(-CAMERA_DAMPING * deltaSeconds);
		this.camera.position.lerp(desiredPosition, blend);
		this.camera.lookAt(target);
	}

	private render() {
		if (!this.renderer || !this.scene || !this.camera) return;
		this.renderer.render(this.scene, this.camera);
	}

	private readonly handleResize = () => {
		if (!this.renderer || !this.camera) return;

		const width = Math.max(1, this.options.container.clientWidth);
		const height = Math.max(1, this.options.container.clientHeight);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height, false);
	};

	private readonly handleGesture = (gesture: InputGesture) => {
		if (this.disposed) return;

		if (gesture.type === 'attack') {
			this.attackRemaining = 0.24;
			this.player?.playAttack(gesture.comboStep);
			this.setAction({ kind: 'attack', label: `Attack ${gesture.comboStep}`, comboStep: gesture.comboStep });
			return;
		}

		if (gesture.type === 'move') {
			this.movementDirection = this.screenDirectionToWorld(gesture.direction);
			this.movementMode = gesture.mode;
			this.setAction({
				kind: gesture.mode,
				label: gesture.mode === 'run' ? 'Run' : 'Walk',
				direction: gesture.direction
			});
			return;
		}

		if (gesture.type === 'dash') {
			this.dashDirection = this.screenDirectionToWorld(gesture.direction);
			this.dashRemaining = DASH_SECONDS;
			this.movementDirection = null;
			this.movementMode = null;
			this.setAction({ kind: 'dash', label: 'Dash', direction: gesture.direction });
			return;
		}

		this.movementDirection = null;
		this.movementMode = null;
		if (this.dashRemaining === 0 && this.attackRemaining === 0) this.setAction(IDLE_ACTION);
	};

	private screenDirectionToWorld(direction: Direction2) {
		if (!this.camera) return new THREE.Vector3(direction.x, 0, direction.y).normalize();

		const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
		right.y = 0;
		right.normalize();

		const forward = new THREE.Vector3();
		this.camera.getWorldDirection(forward);
		forward.y = 0;
		forward.normalize();

		const worldDirection = right.multiplyScalar(direction.x).add(forward.multiplyScalar(direction.y));
		if (worldDirection.lengthSq() <= 0.0001) return new THREE.Vector3(0, 0, -1);
		return worldDirection.normalize();
	}

	private setAction(state: ActionState) {
		if (this.disposed || !this.onActionStateChange || state.label === this.currentLabel) return;
		this.currentLabel = state.label;
		this.onActionStateChange(state);
	}
}
```

- [ ] **Step 2: Replace `GameCanvas.svelte` with the dynamic client bridge**

Replace `src/lib/game/GameCanvas.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import type { ActionStateHandler, RuntimeErrorHandler } from '$lib/game/types';

	let {
		onActionStateChange,
		onRuntimeError
	}: {
		onActionStateChange: ActionStateHandler;
		onRuntimeError: RuntimeErrorHandler;
	} = $props();

	let host: HTMLDivElement;

	onMount(() => {
		let runtime: { dispose(): void } | null = null;
		let cancelled = false;

		async function mountRuntime() {
			try {
				const { GameRuntime } = await import('$lib/game/runtime/GameRuntime');
				if (cancelled) return;
				runtime = new GameRuntime({
					container: host,
					onActionStateChange,
					onRuntimeError
				});
			} catch (error) {
				onRuntimeError(error instanceof Error ? error.message : 'Unable to load game runtime.');
			}
		}

		void mountRuntime();

		return () => {
			cancelled = true;
			runtime?.dispose();
			runtime = null;
		};
	});
</script>

<div bind:this={host} class="game-canvas" aria-label="3D action prototype play surface"></div>
```

- [ ] **Step 3: Verify and commit**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`; the build must not fail from SSR-time DOM, canvas, `window`, or WebGL access.

Run:

```powershell
git add -- src/lib/game/runtime/GameRuntime.ts src/lib/game/GameCanvas.svelte
git commit -m "feat: wire Three runtime to play route"
```

---

### Task 7: Add Browser Smoke Verification

**Files:**
- Create: `scripts/verify-browser.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the Playwright smoke script**

Create `scripts/verify-browser.mjs`:

```js
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.APP_URL ?? 'http://127.0.0.1:5173';

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'desktop', width: 1280, height: 720 }
];

for (const viewport of viewports) {
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport });

	try {
		await page.goto(baseURL, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Game Start' }).click();
		await page.waitForSelector('canvas');
		await page.waitForFunction(() => {
			const canvas = document.querySelector('canvas');
			return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
		});

		assert.equal(await hasNonBlankCanvas(page), true, `${viewport.name} canvas should be nonblank`);

		await page.mouse.click(viewport.width / 2, viewport.height / 2);
		await page.waitForFunction(() => document.body.textContent?.includes('Attack 1') === true);

		await page.mouse.move(viewport.width / 2, viewport.height / 2);
		await page.mouse.down();
		await page.mouse.move(viewport.width / 2 + 90, viewport.height / 2, { steps: 8 });
		await page.waitForFunction(() => {
			const text = document.body.textContent ?? '';
			return text.includes('Walk') || text.includes('Run');
		});
		await page.mouse.up();

		await fastDrag(page, viewport.width / 2, viewport.height / 2, viewport.width / 2 + 100, viewport.height / 2);
		await fastDrag(page, viewport.width / 2, viewport.height / 2, viewport.width / 2 + 100, viewport.height / 2);
		await page.waitForFunction(() => document.body.textContent?.includes('Dash') === true);

		await page.goBack({ waitUntil: 'networkidle' });
		assert.equal(await page.getByRole('button', { name: 'Game Start' }).isVisible(), true);
	} finally {
		await browser.close();
	}
}

async function fastDrag(page, startX, startY, endX, endY) {
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(endX, endY, { steps: 2 });
	await page.mouse.up();
}

async function hasNonBlankCanvas(page) {
	return page.locator('canvas').evaluate((canvas) => {
		if (!(canvas instanceof HTMLCanvasElement)) return false;

		const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
		if (!gl) return false;

		const width = gl.drawingBufferWidth;
		const height = gl.drawingBufferHeight;
		const samples = [
			[Math.floor(width * 0.25), Math.floor(height * 0.25)],
			[Math.floor(width * 0.5), Math.floor(height * 0.5)],
			[Math.floor(width * 0.75), Math.floor(height * 0.75)]
		];

		for (const [x, y] of samples) {
			const pixel = new Uint8Array(4);
			gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
			if (pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0 || pixel[3] !== 0) return true;
		}

		return false;
	});
}
```

- [ ] **Step 2: Add the package script**

Modify `package.json` so the `scripts` object includes this entry after `test`:

```json
"verify:browser": "node scripts/verify-browser.mjs"
```

The resulting `scripts` object should include:

```json
{
	"dev": "vite dev",
	"build": "vite build",
	"preview": "vite preview",
	"prepare": "svelte-kit sync || echo ''",
	"check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
	"check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch",
	"lint": "eslint .",
	"test:unit": "vitest",
	"test": "npm run test:unit -- --run",
	"verify:browser": "node scripts/verify-browser.mjs"
}
```

- [ ] **Step 3: Verify and commit**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

Run:

```powershell
git add -- scripts/verify-browser.mjs package.json
git commit -m "test: add browser smoke verification"
```

---

### Task 8: Run Final Browser Verification

**Files:**
- No source edits.

- [ ] **Step 1: Start the dev server**

Run:

```powershell
$server = Start-Process -FilePath "bun" -ArgumentList "run","dev","--","--host","127.0.0.1" -WorkingDirectory "D:\one-finger-act" -WindowStyle Hidden -PassThru
```

Expected: a Vite dev server starts on `http://127.0.0.1:5173` or prints an alternate port in its log. Use the printed URL for `APP_URL` when Vite chooses another port.

- [ ] **Step 2: Run browser smoke verification**

Run:

```powershell
$env:APP_URL = "http://127.0.0.1:5173"
bun run verify:browser
```

Expected: command exits `0` after checking `/`, `/play`, Back navigation, tap attack, drag movement, double-fast-drag dash, and nonblank canvas at `390 x 844` and `1280 x 720`.

- [ ] **Step 3: Run the full final verification ladder**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands exit `0`.

- [ ] **Step 4: Stop the dev server**

Run:

```powershell
if ($server -and (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) {
	Stop-Process -Id $server.Id -Force
}
```

Expected: the Vite dev server process from Step 1 is stopped.

---

### Task 9: Final Review Commit Or Status Check

**Files:**
- No planned source edits.

- [ ] **Step 1: Inspect final git state**

Run:

```powershell
git status --short --branch
git log --oneline -8
```

Expected: working tree is clean, and the recent commits show scaffold, dependency, route shell, input recognizer, Three actor/world, runtime wiring, and browser verification.

- [ ] **Step 2: Capture implementation summary**

Record these facts for the final response:

```text
- Final route flow: / -> /play -> browser Back returns to /
- Verification commands run: bun run lint, bun run test, bun run check, bun run build, bun run verify:browser
- Browser smoke viewports: 390 x 844 and 1280 x 720
- Dev server stopped: yes
```

Expected: no additional commit is required when the working tree is clean.

---

## Self-Review

Spec coverage:

- Route separation is covered by Tasks 3, 6, 7, and 8.
- Three dependency installation is covered by Task 2.
- Client-only runtime creation and disposal are covered by Task 6.
- HUD callback clearing and stale update prevention are covered by Task 6.
- One active pointer, pointer capture, cancel, lost capture, tap, drag, run, fast drag, dash, and combo cycling are covered by Task 4.
- SD primitive character and attack arc are covered by Task 5.
- Temporary block field and boundary clamp are covered by Tasks 5 and 6.
- Camera follow and screen-to-world input mapping are covered by Task 6.
- HUD non-interference is covered by Task 3 CSS.
- Baseline and browser verification are covered by Tasks 7 and 8.

Deferred-work scan:

- The plan uses concrete file paths, commands, expected outcomes, and code blocks.
- The plan contains no deferred requirements.

Type consistency:

- `ActionState`, `InputGesture`, `ComboStep`, `Direction2`, and callback types are defined in Task 3 before use in later tasks.
- `InputController` emits `InputGesture`; `GameRuntime` consumes the same union type.
- `PlayerActor`, `BlockWorld`, and `GameRuntime` use Three.js types only inside runtime-owned modules.
