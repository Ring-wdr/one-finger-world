# One-Finger Skill Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four fixed diagonal skill buttons to the one-finger control scheme and fire a 3 second forward beam without interrupting movement.

**Architecture:** `InputController` owns skill hit detection because it already owns active pointer state and thresholds. `PhysicsFeedbackActor` renders skill buttons as separate screen-space feedback meshes without changing existing drag feedback meshes. `GameRuntime` handles the new `skill` gesture by starting a dedicated `BeamActor` visual effect while preserving movement state.

**Tech Stack:** SvelteKit, TypeScript, Three.js, Vitest, Playwright browser verification.

---

## File Structure

- Modify: `src/lib/game/types.ts`
  - Add `SkillSlot`, `SkillButtonFeedback`, dedicated skill feedback events, and `InputGesture` skill variant.
- Modify: `src/lib/game/input/InputController.ts`
  - Add skill button constants, per-pointer button layout, slot hit testing, and one-shot slot triggering.
- Modify: `src/lib/game/input/InputController.spec.ts`
  - Add focused unit coverage for skill layout, skill triggering, one-shot behavior, cleanup, and secondary pointer isolation.
- Modify: `src/lib/game/feedback/PhysicsFeedbackActor.ts`
  - Add separate skill button screen-space meshes and hide/show handling for new feedback events.
- Modify: `src/lib/game/feedback/PhysicsFeedbackActor.spec.ts`
  - Add tests proving skill buttons are screen-space, use separate meshes, and hide without touching run/drag feedback.
- Create: `src/lib/game/actors/BeamActor.ts`
  - Runtime-owned transient beam effect with explicit start, update, visibility, and disposal behavior.
- Create: `src/lib/game/actors/BeamActor.spec.ts`
  - Deterministic tests for direction capture, 3 second expiry, refresh, movement-independent placement, and disposal.
- Modify: `src/lib/game/runtime/GameRuntime.ts`
  - Instantiate/dispose `BeamActor`, route `skill` gestures, preserve movement state, and update the beam each frame.
- Modify: `scripts/verify-browser.mjs`
  - Add a smoke check that enters a fixed diagonal skill target, sees a canvas change near the player, and observes movement HUD state remains visible.

## Constants And Slot Mapping

Use these constants in `InputController.ts`:

```ts
const SKILL_BUTTON_DISTANCE_PX = 112;
const SKILL_BUTTON_RADIUS_PX = 24;
```

Slot mapping is fixed in screen coordinates:

```ts
const SKILL_BUTTON_DIRECTIONS: Record<SkillSlot, Direction2> = {
	1: { x: 1, y: -1 },
	2: { x: -1, y: -1 },
	3: { x: 1, y: 1 },
	4: { x: -1, y: 1 }
};
```

The `Direction2` values above are screen axis signs, not game movement vectors. Positive `y` means lower on the screen for button placement.

---

### Task 1: Extend Shared Types And Write Input Contract Tests

**Files:**
- Modify: `src/lib/game/types.ts`
- Modify: `src/lib/game/input/InputController.spec.ts`

- [ ] **Step 1: Extend shared type declarations**

In `src/lib/game/types.ts`, add `SkillSlot` after `ComboStep`:

```ts
export type ComboStep = 1 | 2 | 3;
export type SkillSlot = 1 | 2 | 3 | 4;
```

Add this interface after `ScreenPoint`:

```ts
export interface SkillButtonFeedback {
	slot: SkillSlot;
	center: ScreenPoint;
	radius: number;
}
```

Extend `InputFeedbackEvent` with these variants before the final semicolon:

```ts
	| {
			type: 'skill-buttons';
			buttons: SkillButtonFeedback[];
			timeStamp: number;
	  }
	| {
			type: 'skill-buttons-hidden';
			timeStamp: number;
	  };
```

Extend `InputGesture` with the `skill` variant:

```ts
export type InputGesture =
	| { type: 'attack'; comboStep: ComboStep }
	| { type: 'move'; mode: MoveMode; direction: Direction2 }
	| { type: 'dash'; direction: Direction2 }
	| { type: 'skill'; slot: SkillSlot }
	| { type: 'idle' };
```

- [ ] **Step 2: Add failing tests for skill button layout and triggering**

Append these tests inside the existing `describe('InputController', () => { ... })` block in `src/lib/game/input/InputController.spec.ts`, before the dispose test:

```ts
	it('shows fixed diagonal skill buttons on press outside the run threshold', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 5 });

		expect(feedback.at(0)).toEqual({
			type: 'press',
			start: { x: 100, y: 120 },
			thumb: { x: 100, y: 120 },
			timeStamp: 5
		});
		expect(feedback.at(1)).toEqual({
			type: 'skill-buttons',
			buttons: [
				{ slot: 1, center: { x: 212, y: 8 }, radius: 24 },
				{ slot: 2, center: { x: -12, y: 8 }, radius: 24 },
				{ slot: 3, center: { x: 212, y: 232 }, radius: 24 },
				{ slot: 4, center: { x: -12, y: 232 }, radius: 24 }
			],
			timeStamp: 5
		});

		const skillButtons = feedback.at(1);
		expect(skillButtons?.type).toBe('skill-buttons');
		if (skillButtons?.type === 'skill-buttons') {
			for (const button of skillButtons.buttons) {
				const distance = Math.hypot(button.center.x - 100, button.center.y - 120);
				expect(distance - button.radius).toBeGreaterThan(72);
			}
		}
	});

	it('emits one skill gesture and hides skill buttons when the thumb enters a slot', () => {
		const { target, gestures, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 100 });
		target.fire('pointermove', { pointerId: 1, clientX: 210, clientY: 10, timeStamp: 120 });

		expect(gestures).toEqual([
			{
				type: 'move',
				mode: 'run',
				direction: {
					x: expect.closeTo(0.7071067811865475, 10),
					y: expect.closeTo(0.7071067811865475, 10)
				}
			},
			{ type: 'skill', slot: 1 },
			{
				type: 'move',
				mode: 'run',
				direction: {
					x: expect.closeTo(0.7071067811865475, 10),
					y: expect.closeTo(0.7071067811865475, 10)
				}
			}
		]);
		expect(feedback.at(-1)).toEqual({
			type: 'drag',
			start: { x: 100, y: 120 },
			thumb: { x: 210, y: 10 },
			direction: {
				x: expect.closeTo(0.7071067811865475, 10),
				y: expect.closeTo(0.7071067811865475, 10)
			},
			mode: 'run',
			timeStamp: 120
		});
		expect(feedback).toContainEqual({ type: 'skill-buttons-hidden', timeStamp: 100 });
		expect(feedback.filter((event) => event.type === 'skill-buttons-hidden')).toHaveLength(1);
	});

	it('allows different slots once each during a single touch but never repeats a slot', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 100 });
		target.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 140 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 180 });
		target.fire('pointermove', { pointerId: 1, clientX: -12, clientY: 8, timeStamp: 220 });

		expect(gestures.filter((gesture) => gesture.type === 'skill')).toEqual([
			{ type: 'skill', slot: 1 },
			{ type: 'skill', slot: 2 }
		]);
	});

	it('does not trigger skills from release-only swipes or ignored secondary pointers', () => {
		const { target, gestures, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointerdown', { pointerId: 2, clientX: 100, clientY: 120, timeStamp: 10 });
		target.fire('pointermove', { pointerId: 2, clientX: 212, clientY: 8, timeStamp: 40 });
		target.fire('pointerup', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 80 });

		expect(gestures).toEqual([{ type: 'idle' }]);
		expect(feedback.filter((event) => event.type === 'skill-buttons-hidden')).toHaveLength(1);
	});
```

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: FAIL with missing `skill-buttons` feedback and missing `skill` gesture behavior.

- [ ] **Step 4: Commit the type contract and failing tests only if your workflow requires RED commits**

Default for this repository: do not commit the RED state. Keep changes unstaged and proceed to Task 2.

---

### Task 2: Implement Skill Recognition In InputController

**Files:**
- Modify: `src/lib/game/input/InputController.ts`
- Test: `src/lib/game/input/InputController.spec.ts`

- [ ] **Step 1: Update imports and constants**

In `src/lib/game/input/InputController.ts`, add `SkillButtonFeedback` and `SkillSlot` to the type import:

```ts
	SkillButtonFeedback,
	SkillSlot
```

Add constants after `DEFAULT_THRESHOLDS`:

```ts
const SKILL_BUTTON_DISTANCE_PX = 112;
const SKILL_BUTTON_RADIUS_PX = 24;
const SKILL_BUTTON_DIRECTIONS: Record<SkillSlot, Direction2> = {
	1: { x: 1, y: -1 },
	2: { x: -1, y: -1 },
	3: { x: 1, y: 1 },
	4: { x: -1, y: 1 }
};
```

- [ ] **Step 2: Extend active pointer state**

Add these fields to `ActivePointer`:

```ts
	skillButtons: SkillButtonFeedback[];
	triggeredSkillSlots: Set<SkillSlot>;
	skillButtonsVisible: boolean;
```

In `handlePointerDown`, add these fields when assigning `this.active`:

```ts
			skillButtons: this.createSkillButtons(event.clientX, event.clientY),
			triggeredSkillSlots: new Set<SkillSlot>(),
			skillButtonsVisible: true
```

- [ ] **Step 3: Emit skill buttons on press**

In `handlePointerDown`, after the existing `press` feedback event, add:

```ts
		this.safeEmitFeedback({
			type: 'skill-buttons',
			buttons: this.active.skillButtons,
			timeStamp: event.timeStamp
		});
```

Because `this.active` is known to be non-null in this block, do not use a fallback layout.

- [ ] **Step 4: Trigger skills after existing movement emission**

In `handlePointerMove`, immediately after:

```ts
		this.emit({ type: 'move', mode, direction: active.lastDirection });
```

add:

```ts
		this.emitSkillIfNeeded(active, event.timeStamp);
```

- [ ] **Step 5: Hide skill buttons on release and cancel cleanup**

Add this helper inside the class:

```ts
	private hideSkillButtons(active: ActivePointer, timeStamp: number) {
		if (!active.skillButtonsVisible) return;

		active.skillButtonsVisible = false;
		this.safeEmitFeedback({
			type: 'skill-buttons-hidden',
			timeStamp
		});
	}
```

Call it before `this.releaseActivePointer();` in both branches of `handlePointerUp`, and before `this.releaseActivePointer();` in `handlePointerCancel` and `handleLostPointerCapture`:

```ts
		this.hideSkillButtons(active, event.timeStamp);
```

- [ ] **Step 6: Add layout and hit-test helpers**

Add these methods inside `InputController`:

```ts
	private createSkillButtons(startX: number, startY: number): SkillButtonFeedback[] {
		return ([1, 2, 3, 4] as SkillSlot[]).map((slot) => {
			const direction = SKILL_BUTTON_DIRECTIONS[slot];
			return {
				slot,
				center: {
					x: startX + direction.x * SKILL_BUTTON_DISTANCE_PX,
					y: startY + direction.y * SKILL_BUTTON_DISTANCE_PX
				},
				radius: SKILL_BUTTON_RADIUS_PX
			};
		});
	}

	private emitSkillIfNeeded(active: ActivePointer, timeStamp: number) {
		for (const button of active.skillButtons) {
			if (active.triggeredSkillSlots.has(button.slot)) continue;
			if (!this.isThumbInsideSkillButton(active, button)) continue;

			active.triggeredSkillSlots.add(button.slot);
			this.hideSkillButtons(active, timeStamp);
			this.emit({ type: 'skill', slot: button.slot });
			return;
		}
	}

	private isThumbInsideSkillButton(active: ActivePointer, button: SkillButtonFeedback) {
		return (
			Math.hypot(active.currentX - button.center.x, active.currentY - button.center.y) <=
			button.radius
		);
	}
```

This implementation intentionally places centers at `start +/- 112` on x/y axes, matching the approved visual layout and the tests. The radial distance from touch start is `Math.hypot(112, 112)`, so the nearest edge remains outside the run threshold.

- [ ] **Step 7: Run focused input tests**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run typecheck for input/type changes**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit input skill recognition**

Run:

```bash
git add src/lib/game/types.ts src/lib/game/input/InputController.ts src/lib/game/input/InputController.spec.ts
git commit -m "feat: recognize one-finger skill buttons"
```

---

### Task 3: Render Skill Buttons In PhysicsFeedbackActor

**Files:**
- Modify: `src/lib/game/feedback/PhysicsFeedbackActor.ts`
- Modify: `src/lib/game/feedback/PhysicsFeedbackActor.spec.ts`

- [ ] **Step 1: Add failing feedback actor tests**

Append these tests inside `describe('PhysicsFeedbackActor', () => { ... })`:

```ts
	it('shows skill buttons on the screen-space feedback layer', () => {
		const actor = new PhysicsFeedbackActor();
		actor.setViewportSize(300, 200);

		actor.handlePointerFeedback({
			event: {
				type: 'skill-buttons',
				buttons: [
					{ slot: 1, center: { x: 220, y: 20 }, radius: 24 },
					{ slot: 2, center: { x: 80, y: 20 }, radius: 24 },
					{ slot: 3, center: { x: 220, y: 180 }, radius: 24 },
					{ slot: 4, center: { x: 80, y: 180 }, radius: 24 }
				],
				timeStamp: 0
			},
			startScreen: { x: 150, y: 100 },
			thumbScreen: { x: 150, y: 100 }
		});

		const slot1 = actor.group.getObjectByName('skill-button-1') as THREE.Mesh;
		const slot4 = actor.group.getObjectByName('skill-button-4') as THREE.Mesh;

		expect(slot1.visible).toBe(true);
		expect(slot1.position.x).toBe(70);
		expect(slot1.position.y).toBe(80);
		expect(slot1.rotation.x).toBe(0);
		expect(slot4.visible).toBe(true);
		expect(slot4.position.x).toBe(-70);
		expect(slot4.position.y).toBe(-80);

		actor.dispose();
	});

	it('hides skill buttons without hiding existing drag feedback', () => {
		const actor = new PhysicsFeedbackActor();
		actor.setViewportSize(300, 200);

		actor.handlePointerFeedback({
			event: {
				type: 'press',
				start: { x: 150, y: 100 },
				thumb: { x: 150, y: 100 },
				timeStamp: 0
			},
			startScreen: { x: 150, y: 100 },
			thumbScreen: { x: 150, y: 100 }
		});
		actor.handlePointerFeedback({
			event: {
				type: 'drag',
				start: { x: 150, y: 100 },
				thumb: { x: 230, y: 100 },
				direction: { x: 1, y: 0 },
				mode: 'run',
				timeStamp: 16
			},
			startScreen: { x: 150, y: 100 },
			thumbScreen: { x: 230, y: 100 }
		});
		actor.handlePointerFeedback({
			event: {
				type: 'skill-buttons',
				buttons: [{ slot: 1, center: { x: 230, y: 20 }, radius: 24 }],
				timeStamp: 20
			},
			startScreen: { x: 150, y: 100 },
			thumbScreen: { x: 230, y: 100 }
		});
		actor.handlePointerFeedback({
			event: { type: 'skill-buttons-hidden', timeStamp: 30 },
			startScreen: { x: 150, y: 100 },
			thumbScreen: { x: 230, y: 100 }
		});
		actor.update(0.016);

		const slot1 = actor.group.getObjectByName('skill-button-1') as THREE.Mesh;
		const startAnchor = actor.group.getObjectByName('start-anchor') as THREE.Mesh;
		const runHalo = actor.group.getObjectByName('run-halo') as THREE.Mesh;

		expect(slot1.visible).toBe(false);
		expect(startAnchor.visible).toBe(true);
		expect(runHalo.visible).toBe(true);

		actor.dispose();
	});
```

- [ ] **Step 2: Run feedback tests to verify RED**

Run:

```bash
bun run test:unit -- --run src/lib/game/feedback/PhysicsFeedbackActor.spec.ts
```

Expected: FAIL because `skill-button-1` through `skill-button-4` do not exist.

- [ ] **Step 3: Add skill button meshes and colors**

In `src/lib/game/feedback/PhysicsFeedbackActor.ts`, update the import:

```ts
import type { InputFeedbackEvent, InputGesture, ScreenPoint, SkillButtonFeedback } from '$lib/game/types';
```

Add constants near the existing color constants:

```ts
const SKILL_BUTTON_COLORS: Record<number, number> = {
	1: 0x22c55e,
	2: 0xeab308,
	3: 0xef4444,
	4: 0x8b5cf6
};
const SKILL_BUTTON_OPACITY = 0.74;
```

Add fields to the class:

```ts
	private readonly skillButtons = new Map<number, THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>>();
```

At the end of the constructor, after existing visibility setup, add:

```ts
		for (const slot of [1, 2, 3, 4]) {
			const button = this.createScreenRing(
				`skill-button-${slot}`,
				SKILL_BUTTON_COLORS[slot],
				16,
				24,
				SKILL_BUTTON_OPACITY
			);
			button.visible = false;
			this.skillButtons.set(slot, button);
		}
```

- [ ] **Step 4: Handle skill feedback events**

At the start of `handlePointerFeedback`, after converting `startScreen` and `thumbScreen`, add:

```ts
		if (event.type === 'skill-buttons') {
			this.showSkillButtons(event.buttons);
			return;
		}

		if (event.type === 'skill-buttons-hidden') {
			this.hideSkillButtons();
			return;
		}
```

Add these methods inside the class:

```ts
	private showSkillButtons(buttons: SkillButtonFeedback[]) {
		this.hideSkillButtons();

		for (const feedback of buttons) {
			const button = this.skillButtons.get(feedback.slot);
			if (!button) continue;

			const center = this.screenPointToLayer(feedback.center, this.scratch);
			button.geometry.dispose();
			const nextGeometry = this.trackGeometry(
				new THREE.RingGeometry(feedback.radius * 0.66, feedback.radius, 48)
			);
			button.geometry = nextGeometry;
			this.placeScreenObject(button, center);
			button.material.opacity = SKILL_BUTTON_OPACITY;
			button.visible = true;
		}
	}

	private hideSkillButtons() {
		for (const button of this.skillButtons.values()) {
			button.visible = false;
			button.material.opacity = 0;
		}
	}
```

When replacing geometry in `showSkillButtons`, the old geometry is explicitly disposed. The new geometry is tracked for runtime disposal. This may leave disposed geometries in the tracking array, which is acceptable because disposing an already disposed Three.js geometry is safe.

- [ ] **Step 5: Run focused feedback actor tests**

Run:

```bash
bun run test:unit -- --run src/lib/game/feedback/PhysicsFeedbackActor.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Run input tests again to catch type fallout**

Run:

```bash
bun run test:unit -- --run src/lib/game/input/InputController.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit skill feedback rendering**

Run:

```bash
git add src/lib/game/feedback/PhysicsFeedbackActor.ts src/lib/game/feedback/PhysicsFeedbackActor.spec.ts
git commit -m "feat: render skill button feedback"
```

---

### Task 4: Add BeamActor

**Files:**
- Create: `src/lib/game/actors/BeamActor.ts`
- Create: `src/lib/game/actors/BeamActor.spec.ts`

- [ ] **Step 1: Write failing BeamActor tests**

Create `src/lib/game/actors/BeamActor.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BeamActor } from './BeamActor';

describe('BeamActor', () => {
	it('starts a visible beam from the player in the captured direction', () => {
		const actor = new BeamActor();
		const origin = new THREE.Vector3(2, 0, 3);
		const direction = new THREE.Vector3(1, 0, 0);

		actor.start(origin, direction);

		expect(actor.group.visible).toBe(true);
		expect(actor.group.position.x).toBeCloseTo(2);
		expect(actor.group.position.z).toBeCloseTo(3);
		expect(actor.group.rotation.y).toBeCloseTo(Math.PI / 2);

		actor.dispose();
	});

	it('keeps the captured beam direction while the player moves', () => {
		const actor = new BeamActor();
		const origin = new THREE.Vector3(0, 0, 0);
		const direction = new THREE.Vector3(0, 0, 1);

		actor.start(origin, direction);
		actor.setOrigin(new THREE.Vector3(4, 0, 5));

		expect(actor.group.position.x).toBeCloseTo(4);
		expect(actor.group.position.z).toBeCloseTo(5);
		expect(actor.group.rotation.y).toBeCloseTo(0);

		actor.dispose();
	});

	it('expires after three seconds and refreshes on restart', () => {
		const actor = new BeamActor();

		actor.start(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
		actor.update(2.9);
		expect(actor.group.visible).toBe(true);

		actor.update(0.1);
		expect(actor.group.visible).toBe(false);

		actor.start(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
		expect(actor.group.visible).toBe(true);

		actor.dispose();
	});

	it('hides and removes itself from the scene graph on dispose', () => {
		const scene = new THREE.Scene();
		const actor = new BeamActor();
		scene.add(actor.group);

		actor.start(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
		actor.dispose();

		expect(actor.group.parent).toBeNull();
		expect(actor.group.children).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run BeamActor test to verify RED**

Run:

```bash
bun run test:unit -- --run src/lib/game/actors/BeamActor.spec.ts
```

Expected: FAIL because `BeamActor.ts` does not exist.

- [ ] **Step 3: Implement BeamActor**

Create `src/lib/game/actors/BeamActor.ts`:

```ts
import * as THREE from 'three';

const BEAM_DURATION_SECONDS = 3;
const BEAM_LENGTH = 4.2;
const BEAM_RADIUS = 0.1;
const BEAM_Y = 0.95;

export class BeamActor {
	readonly group = new THREE.Group();

	private readonly beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
	private readonly core: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
	private readonly geometries: THREE.BufferGeometry[] = [];
	private readonly materials: THREE.Material[] = [];
	private readonly capturedDirection = new THREE.Vector3(0, 0, 1);
	private remainingSeconds = 0;

	constructor() {
		this.group.name = 'BeamActor';
		this.group.visible = false;

		this.beam = new THREE.Mesh(
			this.trackGeometry(new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, BEAM_LENGTH, 18)),
			this.trackMaterial(
				new THREE.MeshBasicMaterial({
					color: 0x67e8f9,
					transparent: true,
					opacity: 0.44,
					depthWrite: false
				})
			)
		);
		this.beam.name = 'beam-shell';
		this.beam.rotation.x = Math.PI / 2;
		this.beam.position.z = BEAM_LENGTH * 0.5;
		this.group.add(this.beam);

		this.core = new THREE.Mesh(
			this.trackGeometry(new THREE.CylinderGeometry(BEAM_RADIUS * 0.42, BEAM_RADIUS * 0.42, BEAM_LENGTH, 18)),
			this.trackMaterial(
				new THREE.MeshBasicMaterial({
					color: 0xecfeff,
					transparent: true,
					opacity: 0.78,
					depthWrite: false
				})
			)
		);
		this.core.name = 'beam-core';
		this.core.rotation.x = Math.PI / 2;
		this.core.position.z = BEAM_LENGTH * 0.5;
		this.group.add(this.core);
	}

	start(origin: THREE.Vector3, direction: THREE.Vector3) {
		this.remainingSeconds = BEAM_DURATION_SECONDS;
		this.setDirection(direction);
		this.setOrigin(origin);
		this.group.visible = true;
		this.setOpacity(1);
	}

	setOrigin(origin: THREE.Vector3) {
		this.group.position.set(origin.x, origin.y + BEAM_Y, origin.z);
	}

	update(deltaSeconds: number) {
		if (this.remainingSeconds <= 0) return;

		const dt = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
		this.remainingSeconds = Math.max(0, this.remainingSeconds - dt);
		const alpha = this.remainingSeconds / BEAM_DURATION_SECONDS;
		this.setOpacity(alpha);

		if (this.remainingSeconds === 0) {
			this.group.visible = false;
		}
	}

	dispose() {
		this.group.removeFromParent();
		this.group.clear();

		for (const geometry of this.geometries) geometry.dispose();
		for (const material of this.materials) material.dispose();
	}

	private setDirection(direction: THREE.Vector3) {
		this.capturedDirection.copy(direction);
		this.capturedDirection.y = 0;

		if (this.capturedDirection.lengthSq() <= 0.000001) {
			this.capturedDirection.set(0, 0, 1);
		} else {
			this.capturedDirection.normalize();
		}

		this.group.rotation.y = Math.atan2(this.capturedDirection.x, this.capturedDirection.z);
	}

	private setOpacity(alpha: number) {
		const clamped = THREE.MathUtils.clamp(alpha, 0, 1);
		this.beam.material.opacity = 0.16 + clamped * 0.28;
		this.core.material.opacity = 0.22 + clamped * 0.56;
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

- [ ] **Step 4: Run BeamActor tests**

Run:

```bash
bun run test:unit -- --run src/lib/game/actors/BeamActor.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit BeamActor**

Run:

```bash
git add src/lib/game/actors/BeamActor.ts src/lib/game/actors/BeamActor.spec.ts
git commit -m "feat: add beam skill actor"
```

---

### Task 5: Wire Skill Gestures Into GameRuntime

**Files:**
- Modify: `src/lib/game/runtime/GameRuntime.ts`
- Test: `src/lib/game/actors/BeamActor.spec.ts`
- Test: `src/lib/game/input/InputController.spec.ts`

- [ ] **Step 1: Import BeamActor**

In `src/lib/game/runtime/GameRuntime.ts`, add:

```ts
import { BeamActor } from '$lib/game/actors/BeamActor';
```

- [ ] **Step 2: Add runtime field and initialization**

Add a field near the existing actor fields:

```ts
	private beam: BeamActor | null = null;
```

In `initialize()`, after creating and adding the player, add:

```ts
		const beam = new BeamActor();
		this.beam = beam;
		scene.add(beam.group);
```

- [ ] **Step 3: Dispose the beam actor**

In `dispose()`, after feedback disposal and before player disposal, add:

```ts
		this.beam?.dispose();
		this.beam = null;
```

- [ ] **Step 4: Update beam origin and timer each frame**

In `tick`, after `this.updatePlayer(deltaSeconds);`, add:

```ts
		this.updateBeam(deltaSeconds);
```

Add this method inside the class:

```ts
	private updateBeam(deltaSeconds: number) {
		if (!this.beam || !this.player) return;

		this.beam.setOrigin(this.player.group.position);
		this.beam.update(deltaSeconds);
	}
```

- [ ] **Step 5: Handle the skill gesture without interrupting movement**

In `handleGesture`, after the `dash` branch and before the final idle branch, add:

```ts
		if (gesture.type === 'skill') {
			this.startSkillBeam();
			return;
		}
```

Add this method inside the class:

```ts
	private startSkillBeam() {
		if (!this.player || !this.beam) return;

		const direction =
			this.latestDirection.lengthSq() > 0.000001
				? this.latestDirection
				: this.convertedDirection.set(0, 0, 1);

		this.beam.start(this.player.group.position, direction);
	}
```

Do not change `movementMode`, `movementDirection`, `dashRemainingSeconds`, or `lastPublishedLabel` in this method.

- [ ] **Step 6: Keep feedback from trying to handle skill as movement**

In `PhysicsFeedbackActor.handleGesture`, add this branch after the `move` branch:

```ts
		if (gesture.type === 'skill') {
			return;
		}
```

This avoids falling through to attack handling and keeps skill-specific visuals in `BeamActor`.

- [ ] **Step 7: Run focused unit tests**

Run:

```bash
bun run test:unit -- --run src/lib/game/actors/BeamActor.spec.ts src/lib/game/input/InputController.spec.ts src/lib/game/feedback/PhysicsFeedbackActor.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run typecheck and build**

Run:

```bash
bun run check
bun run build
```

Expected: both PASS.

- [ ] **Step 9: Commit runtime skill wiring**

Run:

```bash
git add src/lib/game/runtime/GameRuntime.ts src/lib/game/feedback/PhysicsFeedbackActor.ts
git commit -m "feat: fire beam from skill gesture"
```

---

### Task 6: Add Browser Smoke Coverage And Run Full Verification

**Files:**
- Modify: `scripts/verify-browser.mjs`

- [ ] **Step 1: Add skill smoke interaction to browser verification**

In `scripts/verify-browser.mjs`, inside `verifyViewport`, after the walk/run drag block and before the dash fast drags, add:

```js
		const skillStart = {
			x: viewport.width / 2,
			y: viewport.height * 0.58
		};
		const skillTarget = {
			x: skillStart.x + 112,
			y: skillStart.y - 112
		};
		const beforeSkillSignature = await canvasRegionSignature(page, center, 128);
		await input.startDrag(skillStart.x, skillStart.y, skillTarget.x, skillTarget.y);
		try {
			await waitForBodyTextMatch(page, /Walk|Run/);
			await page.waitForTimeout(180);
			const duringSkillSignature = await canvasRegionSignature(page, center, 128);
			assert.notEqual(
				duringSkillSignature,
				beforeSkillSignature,
				`${viewport.name} skill beam should alter the canvas near the player while movement continues`
			);
		} finally {
			await input.endDrag();
		}
```

- [ ] **Step 2: Run browser verification**

Run:

```bash
bun run verify:browser
```

Expected: PASS for mobile and desktop. If port 5173 is already in use, stop that process or run an existing compatible dev server and execute `APP_URL=http://127.0.0.1:<port> bun run verify:browser`.

- [ ] **Step 3: Run the full verification ladder**

Run:

```bash
bun run lint
bun run test
bun run check
bun run build
bun run verify:browser
```

Expected: all commands PASS.

- [ ] **Step 4: Commit browser verification**

Run:

```bash
git add scripts/verify-browser.mjs
git commit -m "test: verify skill button beam flow"
```

- [ ] **Step 5: Inspect final status**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: working tree is clean except ignored `.superpowers/` files. Recent commits include skill input recognition, skill feedback rendering, beam actor, runtime wiring, and browser verification.

---

## Self-Review Checklist

- Spec coverage:
  - Fixed screen-space diagonal buttons: Tasks 1 and 2.
  - Buttons beyond run threshold: Tasks 1 and 2.
  - One trigger per slot per touch: Tasks 1 and 2.
  - Hide skill UI on activation and cleanup: Tasks 1, 2, and 3.
  - Existing drag feedback unchanged: Tasks 3 and 5.
  - Movement continues while beam fires: Tasks 4, 5, and 6.
  - All skills share the same 3 second beam: Tasks 4 and 5.
  - Browser verification: Task 6.
- Deferred-section scan: no implementation sections are intentionally left open.
- Type consistency:
  - `SkillSlot`, `SkillButtonFeedback`, `skill-buttons`, `skill-buttons-hidden`, and `skill` are introduced before use.
  - `BeamActor.start`, `BeamActor.setOrigin`, `BeamActor.update`, and `BeamActor.dispose` are defined before runtime wiring uses them.
  - Slot mapping and test coordinates both use fixed screen offsets of 112 px on x and y from the press point.
