# Physics Input Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual-only physics feedback layer for one-finger controls, showing the fixed input start anchor, current thumb target, spring tether, run charge, dash readiness, dash burst, and attack pulse without changing gameplay input decisions.

**Architecture:** `InputController` keeps owning gesture recognition, but it also emits raw pointer feedback events for visual rendering. `GameRuntime` converts screen-space start/thumb points to ground-plane world positions and forwards them to a new `PhysicsFeedbackActor`. `PhysicsFeedbackActor` owns Three.js feedback meshes and uses spring-damper integration for smooth, clear motion. The red/green rings in the user reference image are explanatory only; the in-game palette uses warm amber/ivory for the fixed start anchor and electric blue/cyan for the thumb/tether feedback, never literal red/green status colors.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript, Bun, Vitest, Playwright, Three.js. No new runtime dependency is planned.

---

## File Structure

- `src/lib/game/types.ts`: add screen-point and input-feedback event types.
- `src/lib/game/input/InputController.ts`: emit visual-only pointer feedback events alongside existing gesture events.
- `src/lib/game/input/InputController.spec.ts`: add unit coverage for press, same-point release, drag feedback, cancel feedback, and secondary pointer suppression.
- `src/lib/game/feedback/feedbackPhysics.ts`: pure spring/damping helpers and thumb visibility threshold logic.
- `src/lib/game/feedback/feedbackPhysics.spec.ts`: deterministic unit tests for spring stepping and same-point skip logic.
- `src/lib/game/feedback/PhysicsFeedbackActor.ts`: Three.js meshes for the visual-only physics feedback layer.
- `src/lib/game/runtime/GameRuntime.ts`: instantiate/dispose/update the feedback actor, map screen points to world ground, and forward gesture/pointer feedback events.
- `scripts/verify-browser.mjs`: extend smoke verification with a press-hold visual-change check.

---

### Task 1: Add Raw Pointer Feedback Contracts

**Files:**
- Modify: `src/lib/game/types.ts`

- [ ] **Step 1: Add visual feedback event types**

Append these types after `Direction2` in `src/lib/game/types.ts`:

```ts
export interface ScreenPoint {
	x: number;
	y: number;
}

export type InputFeedbackEvent =
	| {
			type: 'press';
			start: ScreenPoint;
			thumb: ScreenPoint;
			timeStamp: number;
	  }
	| {
			type: 'drag';
			start: ScreenPoint;
			thumb: ScreenPoint;
			direction: Direction2;
			mode: MoveMode;
			timeStamp: number;
	  }
	| {
			type: 'release';
			start: ScreenPoint;
			thumb: ScreenPoint;
			wasDragging: boolean;
			timeStamp: number;
	  }
	| {
			type: 'cancel';
			start: ScreenPoint;
			thumb: ScreenPoint;
			wasDragging: boolean;
			timeStamp: number;
	  };

export type InputFeedbackHandler = (event: InputFeedbackEvent) => void;
```

- [ ] **Step 2: Run typecheck to capture the current baseline**

Run:

```powershell
bun run check
```

Expected: PASS. The new types are not wired yet, but they should not break existing code.

- [ ] **Step 3: Commit the contracts**

Run:

```powershell
git add -- src/lib/game/types.ts
git commit -m "feat: add input feedback event contracts"
```

---

### Task 2: Emit Pointer Feedback From `InputController`

**Files:**
- Modify: `src/lib/game/input/InputController.spec.ts`
- Modify: `src/lib/game/input/InputController.ts`

- [ ] **Step 1: Add failing tests for visual pointer feedback**

In `src/lib/game/input/InputController.spec.ts`, update the imports:

```ts
import type { InputFeedbackEvent, InputGesture } from '$lib/game/types';
```

Update `setup()` so tests can observe feedback events:

```ts
function setup() {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	const feedback: InputFeedbackEvent[] = [];
	const controller = new InputController(
		target,
		(gesture) => gestures.push(gesture),
		undefined,
		(event) => feedback.push(event)
	);

	return { target, gestures, feedback, controller };
}
```

Add these tests inside `describe('InputController', () => { ... })`:

```ts
it('emits press feedback with the fixed start point and initial thumb point', () => {
	const { target, feedback } = setup();

	target.fire('pointerdown', { pointerId: 1, clientX: 40, clientY: 60, timeStamp: 12 });

	expect(feedback).toEqual([
		{
			type: 'press',
			start: { x: 40, y: 60 },
			thumb: { x: 40, y: 60 },
			timeStamp: 12
		}
	]);
});

it('emits drag feedback with fixed start and moving thumb points', () => {
	const { target, feedback } = setup();

	target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: 0 });
	target.fire('pointermove', { pointerId: 1, clientX: 120, clientY: 86, timeStamp: 60 });

	expect(feedback).toEqual([
		{
			type: 'press',
			start: { x: 100, y: 100 },
			thumb: { x: 100, y: 100 },
			timeStamp: 0
		},
		{
			type: 'drag',
			start: { x: 100, y: 100 },
			thumb: { x: 120, y: 86 },
			direction: expect.objectContaining({
				x: expect.closeTo(0.8192319205190405, 10),
				y: expect.closeTo(0.5734623443633283, 10)
			}),
			mode: 'walk',
			timeStamp: 60
		}
	]);
});

it('emits release feedback even when the thumb point never leaves the start point', () => {
	const { target, feedback } = setup();

	target.fire('pointerdown', { pointerId: 1, clientX: 24, clientY: 36, timeStamp: 0 });
	target.fire('pointerup', { pointerId: 1, clientX: 24, clientY: 36, timeStamp: 80 });

	expect(feedback).toEqual([
		{
			type: 'press',
			start: { x: 24, y: 36 },
			thumb: { x: 24, y: 36 },
			timeStamp: 0
		},
		{
			type: 'release',
			start: { x: 24, y: 36 },
			thumb: { x: 24, y: 36 },
			wasDragging: false,
			timeStamp: 80
		}
	]);
});

it('emits cancel feedback for active drag cleanup', () => {
	const { target, feedback } = setup();

	target.fire('pointerdown', { pointerId: 4, clientX: 10, clientY: 20, timeStamp: 0 });
	target.fire('pointermove', { pointerId: 4, clientX: 40, clientY: 20, timeStamp: 30 });
	target.fire('pointercancel', { pointerId: 4, clientX: 40, clientY: 20, timeStamp: 40 });

	expect(feedback.at(-1)).toEqual({
		type: 'cancel',
		start: { x: 10, y: 20 },
		thumb: { x: 40, y: 20 },
		wasDragging: true,
		timeStamp: 40
	});
});

it('does not emit feedback for ignored secondary pointers', () => {
	const { target, feedback } = setup();

	target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
	target.fire('pointerdown', { pointerId: 2, clientX: 80, clientY: 80, timeStamp: 10 });
	target.fire('pointermove', { pointerId: 2, clientX: 120, clientY: 80, timeStamp: 20 });
	target.fire('pointerup', { pointerId: 2, clientX: 120, clientY: 80, timeStamp: 30 });

	expect(feedback).toEqual([
		{
			type: 'press',
			start: { x: 0, y: 0 },
			thumb: { x: 0, y: 0 },
			timeStamp: 0
		}
	]);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: FAIL because `InputController` does not accept the feedback callback yet.

- [ ] **Step 3: Implement feedback emission**

In `src/lib/game/input/InputController.ts`, update imports:

```ts
import type {
	ComboStep,
	Direction2,
	InputFeedbackHandler,
	InputGesture,
	MoveMode,
	ScreenPoint
} from '$lib/game/types';
```

Update the constructor signature:

```ts
constructor(
	private readonly target: PointerSurface,
	private readonly emit: (gesture: InputGesture) => void,
	private readonly thresholds: InputThresholds = DEFAULT_THRESHOLDS,
	private readonly emitFeedback: InputFeedbackHandler = () => undefined
) {
	this.target.addEventListener('pointerdown', this.handlePointerDown);
	this.target.addEventListener('pointermove', this.handlePointerMove);
	this.target.addEventListener('pointerup', this.handlePointerUp);
	this.target.addEventListener('pointercancel', this.handlePointerCancel);
	this.target.addEventListener('lostpointercapture', this.handleLostPointerCapture);
}
```

Add these helpers inside the class:

```ts
private pointFromEvent(event: PointerEvent): ScreenPoint {
	return { x: event.clientX, y: event.clientY };
}

private startPoint(active: ActivePointer): ScreenPoint {
	return { x: active.startX, y: active.startY };
}

private thumbPoint(active: ActivePointer): ScreenPoint {
	return { x: active.currentX, y: active.currentY };
}
```

At the end of `handlePointerDown`, after pointer capture:

```ts
this.emitFeedback({
	type: 'press',
	start: this.pointFromEvent(event),
	thumb: this.pointFromEvent(event),
	timeStamp: event.timeStamp
});
```

In `handlePointerMove`, after `const mode = this.getMoveMode(active, event.timeStamp);` and before emitting the existing move gesture:

```ts
this.emitFeedback({
	type: 'drag',
	start: this.startPoint(active),
	thumb: this.thumbPoint(active),
	direction: active.lastDirection,
	mode,
	timeStamp: event.timeStamp
});
```

In `handlePointerUp`, capture release feedback before `releaseActivePointer()`:

```ts
const releaseFeedback = {
	type: 'release' as const,
	start: this.startPoint(active),
	thumb: this.thumbPoint(active),
	wasDragging: active.dragging,
	timeStamp: event.timeStamp
};
```

Then call it immediately after `this.releaseActivePointer();` in both pointer-up branches:

```ts
this.emitFeedback(releaseFeedback);
```

Replace `handlePointerCancel` with:

```ts
private readonly handlePointerCancel = (event: PointerEvent) => {
	const active = this.getMatchingActivePointer(event);
	if (!active) return;

	this.emitFeedback({
		type: 'cancel',
		start: this.startPoint(active),
		thumb: this.thumbPoint(active),
		wasDragging: active.dragging,
		timeStamp: event.timeStamp
	});
	this.releaseActivePointer();
	this.active = null;
	this.emit({ type: 'idle' });
};
```

Replace `handleLostPointerCapture` with:

```ts
private readonly handleLostPointerCapture = (event: PointerEvent) => {
	const active = this.getMatchingActivePointer(event);
	if (!active) return;

	this.emitFeedback({
		type: 'cancel',
		start: this.startPoint(active),
		thumb: this.thumbPoint(active),
		wasDragging: active.dragging,
		timeStamp: event.timeStamp
	});
	this.releaseActivePointer();
	this.active = null;
	this.emit({ type: 'idle' });
};
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```powershell
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit input feedback emission**

Run:

```powershell
git add -- src/lib/game/input/InputController.ts src/lib/game/input/InputController.spec.ts
git commit -m "feat: emit visual input feedback events"
```

---

### Task 3: Add Pure Physics Feedback Helpers

**Files:**
- Create: `src/lib/game/feedback/feedbackPhysics.spec.ts`
- Create: `src/lib/game/feedback/feedbackPhysics.ts`

- [ ] **Step 1: Write failing tests for spring and same-point logic**

Create `src/lib/game/feedback/feedbackPhysics.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FEEDBACK_SPRING,
	createSpringPoint,
	isThumbPointVisible,
	stepSpringPoint
} from './feedbackPhysics';

describe('feedbackPhysics', () => {
	it('hides the thumb marker when it is effectively the same as the start point', () => {
		expect(isThumbPointVisible({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false);
		expect(isThumbPointVisible({ x: 100, y: 100 }, { x: 104, y: 103 })).toBe(false);
		expect(isThumbPointVisible({ x: 100, y: 100 }, { x: 107, y: 100 })).toBe(true);
	});

	it('moves a spring point toward the target with deterministic damping', () => {
		const point = createSpringPoint(0, 0);

		stepSpringPoint(point, { x: 1, y: 0 }, 0.016, DEFAULT_FEEDBACK_SPRING);

		expect(point.x).toBeCloseTo(0.03072, 5);
		expect(point.y).toBe(0);
		expect(point.vx).toBeCloseTo(1.92, 5);
		expect(point.vy).toBe(0);
	});

	it('ignores non-positive or invalid delta time', () => {
		const point = createSpringPoint(0, 0);

		stepSpringPoint(point, { x: 5, y: 5 }, 0, DEFAULT_FEEDBACK_SPRING);
		stepSpringPoint(point, { x: 5, y: 5 }, Number.NaN, DEFAULT_FEEDBACK_SPRING);

		expect(point).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
	});
});
```

- [ ] **Step 2: Run the helper test to verify RED**

Run:

```powershell
bun run test:unit -- --run src/lib/game/feedback/feedbackPhysics.spec.ts
```

Expected: FAIL because `feedbackPhysics.ts` does not exist.

- [ ] **Step 3: Implement pure spring helpers**

Create `src/lib/game/feedback/feedbackPhysics.ts`:

```ts
import type { ScreenPoint } from '$lib/game/types';

export interface SpringPoint {
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface SpringConfig {
	stiffness: number;
	damping: number;
}

export const SAME_POINT_EPSILON_PX = 6;

export const DEFAULT_FEEDBACK_SPRING: SpringConfig = {
	stiffness: 120,
	damping: 18
};

export function createSpringPoint(x = 0, y = 0): SpringPoint {
	return { x, y, vx: 0, vy: 0 };
}

export function isThumbPointVisible(
	start: ScreenPoint,
	thumb: ScreenPoint,
	epsilonPx = SAME_POINT_EPSILON_PX
) {
	return Math.hypot(thumb.x - start.x, thumb.y - start.y) >= epsilonPx;
}

export function stepSpringPoint(
	point: SpringPoint,
	target: ScreenPoint,
	deltaSeconds: number,
	config: SpringConfig
) {
	if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return point;

	const ax = (target.x - point.x) * config.stiffness - point.vx * config.damping;
	const ay = (target.y - point.y) * config.stiffness - point.vy * config.damping;

	point.vx += ax * deltaSeconds;
	point.vy += ay * deltaSeconds;
	point.x += point.vx * deltaSeconds;
	point.y += point.vy * deltaSeconds;

	return point;
}
```

- [ ] **Step 4: Run helper tests to verify GREEN**

Run:

```powershell
bun run test:unit -- --run src/lib/game/feedback/feedbackPhysics.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit physics helpers**

Run:

```powershell
git add -- src/lib/game/feedback/feedbackPhysics.ts src/lib/game/feedback/feedbackPhysics.spec.ts
git commit -m "feat: add visual feedback spring helpers"
```

---

### Task 4: Build `PhysicsFeedbackActor`

**Files:**
- Create: `src/lib/game/feedback/PhysicsFeedbackActor.ts`

- [ ] **Step 1: Create the actor with visual-only meshes**

Create `src/lib/game/feedback/PhysicsFeedbackActor.ts`:

```ts
import type { InputFeedbackEvent, InputGesture } from '$lib/game/types';
import * as THREE from 'three';
import { isThumbPointVisible } from './feedbackPhysics';

export interface WorldInputFeedbackEvent {
	event: InputFeedbackEvent;
	startWorld: THREE.Vector3;
	thumbWorld: THREE.Vector3;
}

const START_ANCHOR_COLOR = 0xf6d365;
const THUMB_TARGET_COLOR = 0x7dd3fc;
const TETHER_COLOR = 0xe0f2fe;
const DASH_COLOR = 0x93c5fd;
const ATTACK_COLOR = 0xfff7ad;
const GROUND_Y = 0.035;

export class PhysicsFeedbackActor {
	readonly group = new THREE.Group();

	private readonly startAnchor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly thumbTarget: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly tether: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private readonly runHalo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly dashWave: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly attackPulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];
	private readonly startWorld = new THREE.Vector3();
	private readonly thumbTargetWorld = new THREE.Vector3();
	private readonly thumbVisualWorld = new THREE.Vector3();
	private readonly thumbVelocity = new THREE.Vector3();
	private readonly scratch = new THREE.Vector3();
	private active = false;
	private thumbVisible = false;
	private runIntensity = 0;
	private runVelocity = 0;
	private dashWaveAge = 1;
	private attackPulseAge = 1;

	constructor() {
		this.group.name = 'PhysicsFeedbackActor';

		this.startAnchor = this.createGroundRing('start-anchor', START_ANCHOR_COLOR, 0.32, 0.42, 0.75);
		this.thumbTarget = this.createGroundRing('thumb-target', THUMB_TARGET_COLOR, 0.24, 0.34, 0.72);
		this.runHalo = this.createGroundRing('run-halo', TETHER_COLOR, 0.52, 0.58, 0.36);
		this.dashWave = this.createGroundRing('dash-wave', DASH_COLOR, 0.34, 0.42, 0);
		this.attackPulse = this.createGroundRing('attack-pulse', ATTACK_COLOR, 0.42, 0.5, 0);

		const tetherGeometry = this.trackGeometry(new THREE.PlaneGeometry(1, 0.075));
		const tetherMaterial = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color: TETHER_COLOR,
				opacity: 0.5,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		this.tether = new THREE.Mesh(tetherGeometry, tetherMaterial);
		this.tether.name = 'feedback-tether';
		this.tether.rotation.x = -Math.PI / 2;
		this.tether.visible = false;
		this.group.add(this.tether);

		this.startAnchor.visible = false;
		this.thumbTarget.visible = false;
		this.runHalo.visible = false;
		this.dashWave.visible = false;
		this.attackPulse.visible = false;
		this.runHalo.scale.setScalar(0);
		this.dashWave.scale.setScalar(0);
		this.attackPulse.scale.setScalar(0);
	}

	handlePointerFeedback({ event, startWorld, thumbWorld }: WorldInputFeedbackEvent) {
		this.startWorld.copy(startWorld);
		this.thumbTargetWorld.copy(thumbWorld);

		if (event.type === 'press') {
			this.active = true;
			this.thumbVisible = false;
			this.runIntensity = 0;
			this.runVelocity = 0;
			this.thumbVisualWorld.copy(thumbWorld);
			this.thumbVelocity.set(0, 0, 0);
			this.startAnchor.visible = true;
			this.startAnchor.scale.setScalar(0.72);
			this.placeGroundObject(this.startAnchor, this.startWorld);
			this.hideThumbAndTether();
			return;
		}

		if (event.type === 'drag') {
			this.active = true;
			this.thumbVisible = isThumbPointVisible(event.start, event.thumb);
			this.runIntensity = event.mode === 'run' ? 1 : 0.35;
			this.startAnchor.visible = true;
			this.placeGroundObject(this.startAnchor, this.startWorld);
			return;
		}

		if (event.type === 'release' || event.type === 'cancel') {
			this.active = false;
			this.runIntensity = 0;
			this.thumbVisible = false;
		}
	}

	handleGesture(gesture: InputGesture, playerWorld: THREE.Vector3) {
		if (gesture.type === 'dash') {
			this.dashWaveAge = 0;
			this.placeGroundObject(this.dashWave, playerWorld);
			this.dashWave.visible = true;
			return;
		}

		if (gesture.type === 'attack') {
			this.attackPulseAge = 0;
			this.placeGroundObject(this.attackPulse, playerWorld);
			this.attackPulse.visible = true;
		}
	}

	update(deltaSeconds: number) {
		const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.05)) : 0;
		this.updateAnchor(dt);
		this.updateThumb(dt);
		this.updateTether();
		this.updateRunHalo(dt);
		this.updateDashWave(dt);
		this.updateAttackPulse(dt);
	}

	dispose() {
		this.group.removeFromParent();
		this.group.clear();

		for (const geometry of this.geometries) geometry.dispose();
		for (const material of this.materials) material.dispose();
	}

	private updateAnchor(deltaSeconds: number) {
		if (!this.startAnchor.visible) return;

		const targetScale = this.active ? 1 : 0.92;
		const scale = THREE.MathUtils.damp(this.startAnchor.scale.x, targetScale, 18, deltaSeconds);
		this.startAnchor.scale.setScalar(scale);

		const material = this.startAnchor.material;
		material.opacity = THREE.MathUtils.damp(material.opacity, this.active ? 0.75 : 0, 10, deltaSeconds);
		if (!this.active && material.opacity < 0.02) this.startAnchor.visible = false;
	}

	private updateThumb(deltaSeconds: number) {
		if (!this.thumbVisible) {
			this.thumbTarget.material.opacity = THREE.MathUtils.damp(
				this.thumbTarget.material.opacity,
				0,
				14,
				deltaSeconds
			);
			if (this.thumbTarget.material.opacity < 0.02) this.thumbTarget.visible = false;
			return;
		}

		this.springVector(this.thumbVisualWorld, this.thumbTargetWorld, this.thumbVelocity, deltaSeconds);
		this.placeGroundObject(this.thumbTarget, this.thumbVisualWorld);
		this.thumbTarget.visible = true;
		this.thumbTarget.material.opacity = THREE.MathUtils.damp(
			this.thumbTarget.material.opacity,
			0.72,
			16,
			deltaSeconds
		);
	}

	private updateTether() {
		if (!this.thumbVisible || !this.thumbTarget.visible) {
			this.tether.visible = false;
			return;
		}

		this.scratch.copy(this.thumbVisualWorld).sub(this.startWorld);
		const length = Math.hypot(this.scratch.x, this.scratch.z);
		if (length < 0.08) {
			this.tether.visible = false;
			return;
		}

		this.tether.visible = true;
		this.tether.position.set(
			(this.startWorld.x + this.thumbVisualWorld.x) * 0.5,
			GROUND_Y + 0.012,
			(this.startWorld.z + this.thumbVisualWorld.z) * 0.5
		);
		this.tether.scale.set(length, 1, 1);
		this.tether.rotation.z = -Math.atan2(this.scratch.z, this.scratch.x);
		this.tether.material.opacity = THREE.MathUtils.clamp(length / 2.5, 0.18, 0.62);
	}

	private updateRunHalo(deltaSeconds: number) {
		const target = this.active ? this.runIntensity : 0;
		const acceleration = (target - this.runHalo.scale.x) * 140 - this.runVelocity * 20;
		this.runVelocity += acceleration * deltaSeconds;
		const next = Math.max(0, this.runHalo.scale.x + this.runVelocity * deltaSeconds);
		this.runHalo.scale.setScalar(next);
		this.runHalo.visible = next > 0.05;
		this.runHalo.material.opacity = THREE.MathUtils.clamp(next * 0.42, 0, 0.42);
		this.placeGroundObject(this.runHalo, this.startWorld);
	}

	private updateDashWave(deltaSeconds: number) {
		if (!this.dashWave.visible) return;

		this.dashWaveAge += deltaSeconds / 0.34;
		const progress = THREE.MathUtils.clamp(this.dashWaveAge, 0, 1);
		this.dashWave.scale.setScalar(1 + progress * 3.2);
		this.dashWave.material.opacity = (1 - progress) * 0.68;
		if (progress >= 1) this.dashWave.visible = false;
	}

	private updateAttackPulse(deltaSeconds: number) {
		if (!this.attackPulse.visible) return;

		this.attackPulseAge += deltaSeconds / 0.24;
		const progress = THREE.MathUtils.clamp(this.attackPulseAge, 0, 1);
		this.attackPulse.scale.setScalar(0.8 + progress * 1.2);
		this.attackPulse.material.opacity = (1 - progress) * 0.58;
		if (progress >= 1) this.attackPulse.visible = false;
	}

	private springVector(
		current: THREE.Vector3,
		target: THREE.Vector3,
		velocity: THREE.Vector3,
		deltaSeconds: number
	) {
		const stiffness = 130;
		const damping = 19;
		velocity.x += ((target.x - current.x) * stiffness - velocity.x * damping) * deltaSeconds;
		velocity.z += ((target.z - current.z) * stiffness - velocity.z * damping) * deltaSeconds;
		current.x += velocity.x * deltaSeconds;
		current.z += velocity.z * deltaSeconds;
		current.y = GROUND_Y;
	}

	private hideThumbAndTether() {
		this.thumbTarget.visible = false;
		this.tether.visible = false;
		this.runHalo.visible = false;
	}

	private createGroundRing(name: string, color: number, innerRadius: number, outerRadius: number, opacity: number) {
		const geometry = this.trackGeometry(new THREE.RingGeometry(innerRadius, outerRadius, 48));
		const material = this.trackMaterial(
			new THREE.MeshBasicMaterial({
				color,
				opacity,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = name;
		mesh.rotation.x = -Math.PI / 2;
		this.group.add(mesh);
		return mesh;
	}

	private placeGroundObject(object: THREE.Object3D, position: THREE.Vector3) {
		object.position.set(position.x, GROUND_Y, position.z);
	}

	private trackGeometry<T extends THREE.BufferGeometry>(geometry: T) {
		this.geometries.push(geometry);
		return geometry;
	}

	private trackMaterial<T extends THREE.Material>(material: T) {
		this.materials.push(material);
		return material;
	}
}
```

- [ ] **Step 2: Run typecheck and lint for the new actor**

Run:

```powershell
bun run check
bun run lint
```

Expected: both PASS.

- [ ] **Step 3: Commit the actor**

Run:

```powershell
git add -- src/lib/game/feedback/PhysicsFeedbackActor.ts
git commit -m "feat: add physics input feedback actor"
```

---

### Task 5: Wire Feedback Actor Into `GameRuntime`

**Files:**
- Modify: `src/lib/game/runtime/GameRuntime.ts`

- [ ] **Step 1: Import feedback actor and input feedback event type**

Update imports in `src/lib/game/runtime/GameRuntime.ts`:

```ts
import { PhysicsFeedbackActor } from '$lib/game/feedback/PhysicsFeedbackActor';
```

Add `type InputFeedbackEvent` to the existing types import:

```ts
type InputFeedbackEvent,
```

- [ ] **Step 2: Add runtime fields**

Add these private fields inside `GameRuntime`:

```ts
private feedback: PhysicsFeedbackActor | null = null;
private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
private readonly feedbackRaycaster = new THREE.Raycaster();
private readonly feedbackNdc = new THREE.Vector2();
private readonly feedbackStartWorld = new THREE.Vector3();
private readonly feedbackThumbWorld = new THREE.Vector3();
```

- [ ] **Step 3: Instantiate and dispose feedback actor**

After the player is added to the scene in `initialize()`:

```ts
const feedback = new PhysicsFeedbackActor();
this.feedback = feedback;
scene.add(feedback.group);
```

In `dispose()`, after input disposal and before `scene?.clear()`:

```ts
this.feedback?.dispose();
this.feedback = null;
```

- [ ] **Step 4: Pass the feedback callback to `InputController`**

Replace:

```ts
this.input = new InputController(renderer.domElement, this.handleGesture);
```

With:

```ts
this.input = new InputController(
	renderer.domElement,
	this.handleGesture,
	undefined,
	this.handleInputFeedback
);
```

- [ ] **Step 5: Update feedback every frame**

In `tick`, after `this.updateAttackState(deltaSeconds);` and before `this.updateCamera(deltaSeconds);`, add:

```ts
this.feedback?.update(deltaSeconds);
```

- [ ] **Step 6: Forward gestures to feedback actor**

At the top of `handleGesture`, after `if (this.disposed) return;`, add:

```ts
if (this.player) {
	this.feedback?.handleGesture(gesture, this.player.group.position);
}
```

- [ ] **Step 7: Add screen-to-ground mapping**

Add these methods inside `GameRuntime`:

```ts
private readonly handleInputFeedback = (event: InputFeedbackEvent) => {
	if (this.disposed || !this.feedback) return;

	this.screenPointToGround(event.start, this.feedbackStartWorld);
	this.screenPointToGround(event.thumb, this.feedbackThumbWorld);
	this.feedback.handlePointerFeedback({
		event,
		startWorld: this.feedbackStartWorld,
		thumbWorld: this.feedbackThumbWorld
	});
};

private screenPointToGround(point: { x: number; y: number }, target: THREE.Vector3) {
	if (!this.camera || !this.renderer || !this.player) {
		return target.set(0, 0, 0);
	}

	const bounds = this.renderer.domElement.getBoundingClientRect();
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);
	this.feedbackNdc.set(
		((point.x - bounds.left) / width) * 2 - 1,
		-(((point.y - bounds.top) / height) * 2 - 1)
	);

	this.feedbackRaycaster.setFromCamera(this.feedbackNdc, this.camera);
	if (this.feedbackRaycaster.ray.intersectPlane(this.groundPlane, target)) {
		return target;
	}

	return target.copy(this.player.group.position);
}
```

- [ ] **Step 8: Run verification**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
```

Expected: all four commands PASS.

- [ ] **Step 9: Commit runtime wiring**

Run:

```powershell
git add -- src/lib/game/runtime/GameRuntime.ts
git commit -m "feat: wire physics feedback into runtime"
```

---

### Task 6: Extend Browser Smoke Verification

**Files:**
- Modify: `scripts/verify-browser.mjs`

- [ ] **Step 1: Add a canvas signature helper**

Add this helper below `hasNonBlankCanvas(page)`:

```js
async function canvasSignature(page) {
	return page.locator('canvas').first().evaluate((canvas) => {
		if (!(canvas instanceof HTMLCanvasElement)) return '';

		const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
		if (!gl) return '';

		const width = gl.drawingBufferWidth;
		const height = gl.drawingBufferHeight;
		const samples = [
			[Math.floor(width * 0.38), Math.floor(height * 0.5)],
			[Math.floor(width * 0.5), Math.floor(height * 0.5)],
			[Math.floor(width * 0.62), Math.floor(height * 0.5)],
			[Math.floor(width * 0.5), Math.floor(height * 0.62)]
		];

		const values = [];
		for (const [x, y] of samples) {
			const pixel = new Uint8Array(4);
			gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
			values.push(`${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}`);
		}

		return values.join('|');
	});
}
```

- [ ] **Step 2: Verify press-hold changes the canvas before movement starts**

In `verifyViewport`, after `const input = viewport.touch ... createMouseInput(page);` and before the tap attack check, add:

```js
const beforeFeedbackSignature = await canvasSignature(page);
await input.startDrag(center.x, center.y, center.x, center.y);
await page.waitForTimeout(120);
const pressFeedbackSignature = await canvasSignature(page);
await input.endDrag();
assert.notEqual(
	pressFeedbackSignature,
	beforeFeedbackSignature,
	`${viewport.name} press feedback should alter the canvas before movement`
);
```

This uses a same-point press/hold so the thumb marker and tether should remain skipped; only the start anchor pulse should cause the visual change.

- [ ] **Step 3: Run browser verification**

Run:

```powershell
bun run verify:browser
```

Expected: PASS. The script starts and stops its own local dev server when `APP_URL` is not set.

- [ ] **Step 4: Commit browser verification**

Run:

```powershell
git add -- scripts/verify-browser.mjs
git commit -m "test: verify physics input feedback renders"
```

---

### Task 7: Final Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run the full verification ladder**

Run:

```powershell
bun run lint
bun run test
bun run check
bun run build
bun run verify:browser
```

Expected: all commands PASS.

- [ ] **Step 2: Inspect git status and recent commits**

Run:

```powershell
git status --short --branch
git log --oneline -8
```

Expected: working tree is clean except ignored `.superpowers/` companion files. Recent commits include input feedback contracts, input feedback emission, spring helpers, feedback actor, runtime wiring, and browser verification.

---

## Self-Review

Spec coverage:

- Fixed start point is represented by `press.start`, `release.start`, `cancel.start`, and the `startAnchor` mesh.
- Current thumb point is represented by `thumb` fields and the `thumbTarget` mesh.
- If thumb equals start, the actor hides the thumb marker and tether through `isThumbPointVisible`.
- The reference image's red/green circles are treated as explanatory only; implementation colors are amber/ivory and blue/cyan, not red/green.
- Visual feedback uses spring-damper physics and does not alter gesture thresholds, movement speed, dash distance, or attack decisions.
- InputController still emits the existing `InputGesture` union, so runtime action behavior remains compatible.
- Runtime teardown includes feedback actor disposal.
- Tests cover raw pointer feedback events, same-point skip logic, spring stepping, full app verification, and a same-point press visual-change smoke check.

Placeholder scan:

- No deferred implementation markers are present.
- Every task lists exact files, exact commands, and expected outcomes.

Type consistency:

- `InputFeedbackEvent` uses `MoveMode`, `Direction2`, and `ScreenPoint` defined in `types.ts`.
- `InputController` receives `InputFeedbackHandler` as an optional fourth constructor parameter, preserving current call sites.
- `GameRuntime` converts `InputFeedbackEvent` screen points to world vectors before calling `PhysicsFeedbackActor`.
