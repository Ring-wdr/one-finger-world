# One-Finger Skill Buttons Design

Date: 2026-05-07

## Goal

Add skill buttons to the current one-finger control prototype without changing the existing drag, run, dash, attack, or physics input feedback behavior.

The feature is a test harness for skill activation. All four skill buttons share the same temporary effect: the character keeps moving normally and fires a beam in the direction the character is currently facing for 3 seconds.

## Confirmed Scope

- Show skill buttons when a primary touch or mouse pointer starts on the play canvas.
- Place four skill buttons at fixed screen-space diagonal positions around the touch start point.
- Keep the placement screen-relative, matching the existing input feedback layer rather than rotating it by character facing or camera direction.
- Put the skill buttons outside the current run trigger distance so a normal long drag to run does not immediately overlap a skill target.
- Trigger a skill when the active thumb point enters a skill button hit area.
- Trigger at most one skill per slot during a single touch.
- Hide the skill button UI immediately after any skill starts.
- Leave existing start anchor, thumb target, tether, and run halo behavior unchanged.
- Keep movement active while the test beam is firing.
- Treat all four skill slots as the same temporary beam action for now.

Out of scope:

- Skill cooldowns, mana, damage, enemies, hit detection, targeting, animation cancel rules, and authored skill differences.
- Character-facing-relative button placement.
- DOM skill buttons or a permanent HUD skill bar.
- Reworking the existing drag feedback visuals.

## Input Model

`InputController` remains the owner of gesture recognition. It already owns the active pointer, touch start point, thumb point, run threshold, and one-pointer isolation rules, so it is the correct place to detect skill button entry.

Add a skill slot type:

```ts
export type SkillSlot = 1 | 2 | 3 | 4;
```

Extend `InputGesture` with:

```ts
{ type: 'skill'; slot: SkillSlot }
```

On `pointerdown`, the controller creates a per-pointer skill-button layout using the fixed start point. The four button centers are screen-space diagonals:

- slot 1: up-right,
- slot 2: up-left,
- slot 3: down-right,
- slot 4: down-left.

The slot mapping follows the visual prototype selected during brainstorming. The mapping is intentionally screen-fixed, not facing-relative.

Required initial constants:

- `skillButtonDistancePx`: 112
- `skillButtonRadiusPx`: 24

These values put the button centers clearly outside the existing `runDistancePx` of 72 px. The implementation must keep `skillButtonDistancePx - skillButtonRadiusPx` greater than `runDistancePx` so entering the center of run range does not also hit a skill.

On `pointermove`, after updating the active thumb point and after emitting the existing move gesture, the controller checks whether the thumb is inside any untriggered skill button radius. If it is, it marks that slot as triggered for the current pointer and emits the `skill` gesture once for that slot. This preserves the current movement update ordering before layered skill effects run.

The controller must not cancel the active drag just because a skill fired. If the thumb is still dragging, normal move gestures can continue to update walk/run direction and mode. On release, cancel, lost capture, or dispose, the per-pointer skill layout and triggered-slot set are cleared with the rest of active pointer state.

Release-only swipes do not need to trigger skills. Skill activation is based on live thumb entry during the active pointer drag so the UI can disappear immediately when activated.

## Skill UI Feedback

The skill button UI belongs to the same Three.js feedback layer as the current screen-space input feedback. This keeps the skill buttons visually aligned with the existing start anchor, thumb marker, tether, and run halo.

Extend `InputFeedbackEvent` with dedicated skill UI events rather than changing the existing event meanings:

```ts
| {
    type: 'skill-buttons';
    buttons: SkillButtonFeedback[];
    timeStamp: number;
  }
| {
    type: 'skill-buttons-hidden';
    timeStamp: number;
  }
```

`SkillButtonFeedback` contains the `slot`, `center`, and `radius` in screen coordinates. The existing `press`, `drag`, `release`, and `cancel` events keep their current shape and behavior.

Expected feedback events:

- on press: show four skill buttons at the fixed diagonal screen positions,
- on drag before activation: keep skill buttons visible unless already hidden,
- on skill activation: hide only the skill buttons,
- on release/cancel/lost capture: hide skill buttons as part of normal cleanup.

`PhysicsFeedbackActor` should create separate meshes for skill buttons. It must not reuse, remove, or alter the existing start anchor, thumb target, tether, or run halo meshes to support this feature.

The buttons are temporary circular indicators with slot numbers and distinct colors. They should be readable at mobile size but remain visually secondary to the drag feedback.

## Runtime Skill Effect

`GameRuntime` handles the new `skill` gesture.

When a skill gesture arrives:

1. Capture the current `latestDirection` as the beam direction. If it is invalid, use the player's current facing fallback.
2. Start or refresh a 3 second beam timer.
3. Do not clear `movementMode`.
4. Do not zero `movementDirection`.
5. Do not interrupt dash unless the existing dash code already determines movement for that frame.
6. Keep the current HUD action state unchanged so movement state remains visible while the beam is active.

Movement update remains governed by the existing movement and dash fields. The beam is a visual effect layered on top of movement, so a character running before skill activation keeps running while the beam is visible.

The prototype beam is implemented as a dedicated runtime-owned `BeamActor`. This keeps transient skill geometry out of `PlayerActor` and makes disposal explicit.

The beam should originate near the player, extend forward along the captured facing direction, and fade out after 3 seconds. It does not need collision or damage.

## Data Flow

1. Player presses the canvas.
2. `InputController` stores the active pointer and emits press feedback with skill button positions.
3. `PhysicsFeedbackActor` shows existing press feedback plus four separate skill buttons.
4. Player drags the thumb.
5. `InputController` continues to emit existing movement gestures and drag feedback.
6. If the thumb enters a skill button radius, `InputController` emits one `skill` gesture for that slot and emits feedback to hide skill buttons.
7. `GameRuntime` starts the test beam while preserving movement state.
8. Release or cancel cleans up active pointer and any remaining skill button UI.

## Error Handling And Lifecycle

Skill feedback must follow the same isolation rule as the current visual feedback: feedback failures must not interrupt gesture handling.

Runtime cleanup must dispose any beam geometry, materials, and skill button feedback meshes. Disposing input during an active pointer must clear the active skill layout and suppress later skill or feedback emissions.

Skill activation should be ignored if `GameRuntime` is disposed, if there is no player, or if the beam actor cannot be updated. It should not throw through the input path.

## Verification

Unit tests should cover `InputController` behavior:

- press feedback includes or is accompanied by a skill-button show event,
- skill buttons use fixed screen-space diagonal positions from the touch start point,
- the nearest edge of the skill hit area is beyond the run threshold,
- dragging into a slot emits exactly one `skill` gesture for that slot,
- re-entering the same slot during the same touch does not emit a second skill gesture,
- triggering a skill emits feedback that hides the skill button UI,
- existing move/run gestures are still emitted during the same drag,
- release, cancel, lost capture, and dispose clear skill state,
- ignored secondary pointers cannot trigger skills.

Runtime or actor tests should cover:

- a `skill` gesture starts a beam timer,
- the beam direction uses the current facing/latest direction,
- movement mode and movement direction are preserved when skill starts,
- the beam expires after 3 seconds,
- beam resources are disposed.

Browser verification should cover:

- at 390 x 844, touch start shows four diagonal skill buttons around the press point,
- a long drag to the run region still shows the existing run feedback behavior,
- dragging farther into a diagonal skill button hides the skill buttons and shows the beam,
- the character keeps moving while the beam is active,
- the canvas remains nonblank and readable on mobile and desktop viewports.

Baseline verification remains:

- `bun run lint`
- `bun run test`
- `bun run check`
- `bun run build`
- `bun run verify:browser`
