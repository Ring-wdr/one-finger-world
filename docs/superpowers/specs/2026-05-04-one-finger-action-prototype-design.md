# One-Finger 3D Action Prototype Design

Date: 2026-05-04

## Goal

Build a first Svelte + Three.js prototype that validates a one-finger action control scheme in a 3D space.

This is not a complete game slice. It is a control sandbox for checking whether tap, drag movement, run, attack combo, and dash/evade inputs feel readable on a simple SD character in a simple 3D field.

## Confirmed Scope

- Use Svelte for title screen and HUD only.
- Use Three.js as the owner of the character, field, camera, render loop, and play interaction.
- Use a mobile-touch-first input model, while keeping desktop mouse testing available through the same Pointer Events path.
- Use a top-down rear quarter camera similar in intent to mobile action RPG controls.
- Use a textureless SD three-heads-tall character made from primitive geometry.
- Use a temporary Minecraft-like low-poly box field for fast prototyping.
- Include only title screen and play screen.
- Exclude enemies, HP, damage, stage progression, inventory, save data, and authored combat content.

## Routes

The title and play contexts are separate routes so browser Back behavior and Three.js lifecycle cleanup are explicit.

- `/`: title route with a single `Game Start` action.
- `/play`: play route that mounts the Three runtime and displays the current action state HUD.

Pressing `Game Start` navigates from `/` to `/play`. Browser Back returns to `/`. Leaving `/play` disposes the Three runtime, renderer, event listeners, animation frame, and resize handlers.

## Architecture

Svelte owns DOM screens and HUD state. Three.js owns all real-time game runtime behavior.

Planned file boundaries:

- `src/routes/+page.svelte`: title screen.
- `src/routes/play/+page.svelte`: play screen and HUD state display.
- `src/lib/game/GameCanvas.svelte`: Svelte-to-Three mount bridge.
- `src/lib/game/runtime/GameRuntime.ts`: renderer, scene, camera, clock, loop, resize, and disposal.
- `src/lib/game/input/InputController.ts`: one-finger Pointer Events recognizer.
- `src/lib/game/actors/PlayerActor.ts`: SD character mesh and motion reactions.
- `src/lib/game/world/BlockWorld.ts`: prototype low-poly field.
- `src/lib/game/types.ts`: shared action-state and input event types.

`GameCanvas.svelte` creates `GameRuntime` when mounted and calls `dispose()` when destroyed. `GameRuntime` emits the current action state to Svelte through a callback so the HUD can remain DOM-based without owning game logic.

## Input Model

The input surface is the whole play canvas. It is designed for touch first. Desktop mouse input is accepted for development convenience, but no desktop-only UI is introduced.

Gesture rules:

- Short tap: attack when the pointer is released within 180 ms and 12 px of the press point.
- Tap attacks advance a looping combo step, shown as `Attack 1`, `Attack 2`, or `Attack 3`.
- Drag start: movement begins as soon as the pointer moves at least 14 px from the press point.
- Drag hold or longer drag vector: movement upgrades from walk to run after 450 ms of drag hold or 72 px of drag distance.
- Fast drag: a drag release with at least 0.9 px/ms average pointer speed.
- Dash/evade: two fast drags within 320 ms trigger a dash in the latest drag direction.

These numeric thresholds are initial tuning values. They should live in `InputController.ts` as named constants so browser testing can adjust them without changing the recognizer shape.

## Player Actor

The player is an SD three-heads-tall character made from Three.js primitive meshes and materials.

Expected visual parts:

- large head,
- compact body,
- short arms and legs,
- a small primitive direction marker on the face side,
- a temporary attack arc mesh shown only during attack feedback.

Motion feedback:

- Idle: subtle stance.
- Walk/run: body leans toward movement direction and limbs swing.
- Attack: short forward pulse plus a visible arc mesh.
- Combo: arc or pose changes slightly by combo step.
- Dash: short speed burst in the input direction with HUD state feedback.

No textures are planned for this prototype.

## World

The field is a temporary low-poly box map, not the long-term world art direction.

The first map contains:

- a flat playable floor,
- several box props with different heights,
- simple material colors for ground and blocks,
- lighting sufficient to read the character silhouette.

Collision is intentionally minimal in the first pass. The player remains inside a rectangular playable floor boundary. Blocking collision against individual cubes is out of scope.

## Camera

The camera uses a top-down rear quarter perspective.

Behavior:

- follow the player smoothly,
- keep a fixed high/rear offset,
- do not expose camera rotation controls,
- rotate the player model toward movement direction instead of rotating the camera from input.

This keeps the first prototype focused on one-finger movement and attack recognition instead of camera-control design.

## HUD

The HUD is Svelte-rendered DOM on the `/play` route.

Initial HUD:

- current action state, such as `Idle`, `Walk`, `Run`, `Attack 2`, or `Dash`.

No virtual joystick, buttons, minimap, HP bar, or help overlay is included in the first pass. The title route is deliberately sparse and only contains `Game Start`.

## Error Handling And Lifecycle

`GameRuntime` must fail gracefully if WebGL cannot initialize, surfacing a simple Svelte-visible error state instead of leaving a blank screen.

Runtime cleanup must include:

- canceling `requestAnimationFrame`,
- removing pointer and resize listeners,
- disposing Three geometries and materials owned by the runtime,
- disposing the renderer,
- clearing DOM references created by the renderer.

Route separation is the main guard against leaked Three contexts.

## Verification

Baseline verification:

- `bun run check`
- `bun run build`

Browser verification after implementation:

- `/` loads the title screen.
- `Game Start` navigates to `/play`.
- Browser Back returns from `/play` to `/`.
- Re-entering `/play` creates a working new Three runtime.
- Tap shows attack combo state changes.
- Drag moves the character.
- Longer drag or hold transitions to run.
- Two quick fast drags trigger dash.
- The canvas is nonblank and the character, field, HUD, and camera are readable on a mobile-sized viewport.

## Out Of Scope

- enemy AI,
- hit detection against enemies,
- HP and damage,
- stage clear or failure state,
- inventory or progression,
- persistent save data,
- authored level design,
- texture pipeline,
- audio,
- gamepad or keyboard-first controls,
- virtual joystick UI.
