# Main Menu Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current prototype-like title page into a production-feeling One Finger Act main menu with a key visual background, animated clouds, and an overlay settings panel.

**Architecture:** Keep `src/routes/+page.svelte` as the main menu route and keep the existing input-threshold state there. Move the existing preset/slider/test-pad UI into a dialog overlay controlled by `settingsOpen`, add a generated static background asset under `static/assets/main-menu/`, and update browser verification to exercise the new `환경설정` flow before starting `/play`.

**Tech Stack:** SvelteKit, Svelte 5 runes, TypeScript, CSS, Bun, Playwright verification, `npx @google/design.md`.

---

## File Structure

- Keep: `DESIGN.md`
  - Root design system document for this feature. It must pass `npx @google/design.md lint DESIGN.md` with 0 errors and 0 warnings.
- Create: `static/assets/main-menu/outer-temple-key-visual.png`
  - Generated full-screen menu background. It is a project-bound raster asset created with the `$imagegen` built-in workflow and saved in the repo.
- Modify: `src/routes/+page.svelte`
  - Removes prototype copy from the first screen, adds `settingsOpen`, adds the full-screen main menu layout, and moves existing input option controls into a dialog overlay.
- Modify: `src/routes/layout.css`
  - Replaces prototype title-page styles with production menu styles, animated cloud layers, responsive settings panel, and reduced-motion handling.
- Modify: `scripts/verify-browser.mjs`
  - Updates the smoke flow from always-visible options to `환경설정` dialog interactions, then starts the game through the new `게임 시작` button.
- Modify: `docs/superpowers/specs/2026-05-09-main-menu-production-design.md`
  - Already updated to require `DESIGN.md` linting; keep it committed with this implementation plan.

## Task 1: Finalize Design System Document

**Files:**
- Keep: `DESIGN.md`
- Modify: `docs/superpowers/specs/2026-05-09-main-menu-production-design.md`

- [ ] **Step 1: Verify the spec contains DESIGN.md lint requirements**

Run:

```bash
rg -n "npx @google/design.md lint DESIGN.md|warnings: 0|errors: 0" docs/superpowers/specs/2026-05-09-main-menu-production-design.md
```

Expected: at least three matches, including the exact command `npx @google/design.md lint DESIGN.md`, `errors: 0`, and `warnings: 0`.

- [ ] **Step 2: Run DESIGN.md lint**

Run:

```bash
npx @google/design.md lint DESIGN.md
```

Expected: exit code 0 and JSON summary equivalent to:

```json
{
  "summary": {
    "errors": 0,
    "warnings": 0
  }
}
```

- [ ] **Step 3: Confirm npx did not leave dependency changes**

Run:

```bash
git status --short
```

Expected: `package.json` and `bun.lock` are not listed. If either file is listed because `npx` modified dependencies, restore only those files:

```bash
git restore package.json bun.lock
```

## Task 2: Generate Main Menu Background Asset

**Files:**
- Create: `static/assets/main-menu/outer-temple-key-visual.png`

- [ ] **Step 1: Generate the background with `$imagegen` built-in mode**

Use the `imagegen` skill in built-in tool mode with this exact prompt:

```text
Use case: stylized-concept
Asset type: full-screen game main menu background
Primary request: a melancholic dark-fantasy ruined outer temple with a large sacred cathedral-like stone structure and open sky
Scene/backdrop: cold blue-gray ruined temple courtyard, broken stone arches, distant larger cathedral silhouette, mist, wide sky
Style/medium: polished painterly game key visual, no text
Composition/framing: vertical-safe composition that also crops well on desktop, large architecture visible behind the title area, readable negative space at center and lower center for UI
Lighting/mood: quiet sadness with one narrow warm golden beam through broken glass or cloud, not heroic
Color palette: cold blue-gray dominant, muted gray stone, one warm golden accent only
Constraints: no characters, no logos, no watermark, no readable text, no modern objects, no red lighting, no strong green, no purple, no hot pink
```

Expected: a painterly dark-fantasy background with a large ruined sacred structure, visible sky, no text, and no modern objects.

- [ ] **Step 2: Save the generated project asset**

Create the destination directory and copy the selected generated image into the workspace:

```bash
mkdir -p static/assets/main-menu
```

Move or copy the selected image from the imagegen output location to:

```text
static/assets/main-menu/outer-temple-key-visual.png
```

Expected: `test -f static/assets/main-menu/outer-temple-key-visual.png` succeeds.

- [ ] **Step 3: Inspect asset dimensions and presence**

Run:

```bash
file static/assets/main-menu/outer-temple-key-visual.png
du -h static/assets/main-menu/outer-temple-key-visual.png
```

Expected: `file` reports a PNG image and `du` reports a non-zero file size.

- [ ] **Step 4: Regenerate once if the asset violates the spec**

Regenerate exactly once with the same prompt plus this additional line if any of the following are true: architecture is too small, sky is barely visible, UI center is too busy, text/logo/watermark appears, or red/green/purple dominates.

```text
Revision constraint: make the architecture larger and the sky clearer while keeping the center and lower center calm enough for title and button readability.
```

Expected after the optional regeneration: the selected image satisfies the visual checks in the spec.

- [ ] **Step 5: Commit the asset**

Run:

```bash
git add static/assets/main-menu/outer-temple-key-visual.png
git commit -m "assets: add main menu key visual"
```

Expected: commit succeeds with only the generated image asset.

## Task 3: Update Browser Verification for the Settings Dialog Flow

**Files:**
- Modify: `scripts/verify-browser.mjs`

- [ ] **Step 1: Update the verification script before changing the UI**

In `scripts/verify-browser.mjs`, make these edits.

Replace the old Korean/English visible-options assumptions in `startGame`, `selectComfortablePreset`, and the final back-navigation check with the following exact implementations.

Replace `startGame` with:

```js
async function startGame(page, viewport) {
	const deadline = Date.now() + START_NAVIGATION_TIMEOUT_MS;
	let attempts = 0;
	let lastError = null;
	let optionsVerified = false;

	while (Date.now() < deadline) {
		if (isPathname(page.url(), PLAY_PATHNAME)) return;

		const remaining = Math.max(1, deadline - Date.now());
		const startButton = page.getByRole('button', { name: '게임 시작' });

		try {
			await startButton.waitFor({
				state: 'visible',
				timeout: Math.min(1000, remaining)
			});

			if (!optionsVerified) {
				await selectComfortablePreset(page, viewport, remaining);
				optionsVerified = true;
			}

			attempts += 1;

			if (viewport.touch) {
				await startButton.tap({ timeout: Math.min(1000, remaining) });
			} else {
				await startButton.click({ timeout: Math.min(1000, remaining) });
			}

			if (await waitForPlayRoute(page, Math.min(START_RETRY_INTERVAL_MS, remaining))) {
				return;
			}
		} catch (error) {
			lastError = error;
		}

		await delay(Math.min(START_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
	}

	const details = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(
		`게임 시작 did not navigate to ${PLAY_PATHNAME} within ${START_NAVIGATION_TIMEOUT_MS}ms after ${attempts} attempts. Current URL: ${page.url()}.${details}`
	);
}
```

Replace `selectComfortablePreset` with:

```js
async function selectComfortablePreset(page, viewport, timeoutMs) {
	const settingsButton = page.getByRole('button', { name: '환경설정' });
	await settingsButton.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });

	if (viewport.touch) {
		await settingsButton.tap({ timeout: Math.min(1000, timeoutMs) });
	} else {
		await settingsButton.click({ timeout: Math.min(1000, timeoutMs) });
	}

	const dialog = page.getByRole('dialog', { name: '환경설정' });
	await dialog.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });

	const comfortableButton = dialog.getByRole('button', { name: '편안' });
	await comfortableButton.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });

	if (viewport.touch) {
		await comfortableButton.tap({ timeout: Math.min(1000, timeoutMs) });
	} else {
		await comfortableButton.click({ timeout: Math.min(1000, timeoutMs) });
	}

	const tapControl = dialog.locator('.option-slider').filter({ hasText: '탭 인식 시간' });
	await tapControl.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });
	await tapControl.getByText('240 ms').waitFor({
		state: 'visible',
		timeout: Math.min(1000, timeoutMs)
	});
	await assert.equal(
		await tapControl.locator('input[type="range"]').inputValue(),
		'240',
		`${viewport.name} comfortable preset should set tap recognition slider to 240 ms`
	);

	const closeButton = dialog.getByRole('button', { name: '닫기' });
	if (viewport.touch) {
		await closeButton.tap({ timeout: Math.min(1000, timeoutMs) });
	} else {
		await closeButton.click({ timeout: Math.min(1000, timeoutMs) });
	}
	await dialog.waitFor({ state: 'hidden', timeout: Math.min(1000, timeoutMs) });
}
```

Replace the final home-screen assertion inside `verifyViewport`:

```js
await page.getByRole('button', { name: 'Game Start' }).waitFor({ state: 'visible' });
```

with:

```js
await page.getByRole('button', { name: '게임 시작' }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '환경설정' }).waitFor({ state: 'visible' });
```

- [ ] **Step 2: Run browser verification to verify RED**

Run:

```bash
bun run verify:browser
```

Expected: FAIL because the current page still exposes `Game Start` and the option controls directly, and it does not have an `환경설정` dialog.

- [ ] **Step 3: Commit the failing verification update**

Run:

```bash
git add scripts/verify-browser.mjs
git commit -m "test: expect settings dialog on main menu"
```

Expected: commit succeeds. This commit intentionally contains a failing verification expectation until Task 4 is implemented.

## Task 4: Implement the Production Main Menu Markup

**Files:**
- Modify: `src/routes/+page.svelte`

- [ ] **Step 1: Add dialog state and handlers**

In `src/routes/+page.svelte`, change the import from:

```ts
import { onMount } from 'svelte';
```

to:

```ts
import { tick, onMount } from 'svelte';
```

Add these state declarations after `testDetail`:

```ts
let settingsOpen = $state(false);
let closeSettingsButton = $state<HTMLButtonElement | null>(null);
```

Add these functions after `startGame()`:

```ts
async function openSettings() {
	settingsOpen = true;
	await tick();
	closeSettingsButton?.focus();
}

function closeSettings() {
	settingsOpen = false;
	testPointer = null;
}

function handleSettingsKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape' && settingsOpen) {
		closeSettings();
	}
}
```

- [ ] **Step 2: Replace the current main markup**

Replace everything from `<main class="title-screen">` through `</main>` with:

```svelte
<svelte:window onkeydown={handleSettingsKeydown} />

<main class="title-screen" class:settings-open={settingsOpen}>
	<img
		class="title-background"
		src={resolve('/assets/main-menu/outer-temple-key-visual.png')}
		alt=""
		aria-hidden="true"
	/>
	<div class="title-clouds" aria-hidden="true">
		<span class="cloud-band cloud-band-a"></span>
		<span class="cloud-band cloud-band-b"></span>
		<span class="cloud-band cloud-band-c"></span>
	</div>
	<div class="title-vignette" aria-hidden="true"></div>

	<section class="title-panel" aria-labelledby="title-heading">
		<h1 id="title-heading">One Finger Act</h1>
		<div class="menu-actions" aria-label="Main menu">
			<button class="start-button" type="button" onclick={startGame}>게임 시작</button>
			<button class="settings-button" type="button" onclick={openSettings}>환경설정</button>
		</div>
	</section>

	{#if settingsOpen}
		<div class="settings-backdrop" role="presentation" onclick={closeSettings}>
			<section
				class="settings-panel"
				role="dialog"
				aria-modal="true"
				aria-labelledby="settings-heading"
				onclick={(event) => event.stopPropagation()}
			>
				<header class="settings-header">
					<h2 id="settings-heading">환경설정</h2>
					<button
						bind:this={closeSettingsButton}
						class="close-settings-button"
						type="button"
						onclick={closeSettings}
					>
						닫기
					</button>
				</header>

				<div class="options-panel" aria-label="Input options">
					<div class="preset-row" aria-label="Input presets">
						{#each presetIds as presetId (presetId)}
							<button
								class:active={activePreset === presetId}
								type="button"
								aria-pressed={activePreset === presetId}
								onclick={() => applyPreset(presetId)}
							>
								{INPUT_THRESHOLD_PRESETS[presetId].label}
							</button>
						{/each}
					</div>

					<div class="slider-list">
						{#each optionControls as control (control.key)}
							<label class="option-slider">
								<span>{control.label}</span>
								<strong>{control.format(options[control.key])}</strong>
								<input
									type="range"
									min={control.range.min}
									max={control.range.max}
									step={control.range.step}
									value={options[control.key]}
									oninput={(event) =>
										updateOption(control.key, Number(event.currentTarget.value))}
								/>
							</label>
						{/each}
					</div>

					<div class="options-footer">
						<button class="reset-button" type="button" onclick={resetOptions}>
							기본값으로 되돌리기
						</button>
						<button
							class="test-pad"
							type="button"
							aria-label="Input test pad"
							onpointerdown={handlePadPointerDown}
							onpointermove={handlePadPointerMove}
							onpointerup={handlePadPointerUp}
						>
							<span>{testFeedback}</span>
							<small>{testDetail}</small>
						</button>
					</div>
				</div>
			</section>
		</div>
	{/if}
</main>
```

Expected: the first screen contains only the background layers, `One Finger Act`, `게임 시작`, and `환경설정`. Input controls exist only inside the dialog.

- [ ] **Step 3: Run Svelte check to catch markup/type errors**

Run:

```bash
bun run check
```

Expected: PASS. If it fails on Svelte event syntax, keep the existing Svelte 5 property-event style already used in the file (`onclick`, `oninput`, `onpointerdown`) and correct the reported line.

- [ ] **Step 4: Commit the route markup**

Run:

```bash
git add src/routes/+page.svelte
git commit -m "feat: move input options into settings dialog"
```

Expected: commit succeeds with only `src/routes/+page.svelte`.

## Task 5: Implement Production Main Menu Styling

**Files:**
- Modify: `src/routes/layout.css`

- [ ] **Step 1: Replace title-page styles**

In `src/routes/layout.css`, replace the current title-screen/title-panel/title-copy/title-kicker/start-button/options-panel/preset-row/slider-list/options-footer/reset-button/test-pad media-query styles with the following CSS. Leave `.play-screen`, `.game-canvas`, `.hud`, and `.runtime-error` styles intact.

```css
.title-screen {
	display: grid;
	place-items: center;
	padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
		max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
	background:
		linear-gradient(180deg, rgba(184, 202, 210, 0.28), rgba(16, 22, 23, 0.9)),
		#24343b;
}

.title-background,
.title-vignette,
.title-clouds,
.settings-backdrop {
	position: absolute;
	inset: 0;
}

.title-background {
	width: 100%;
	height: 100%;
	object-fit: cover;
	object-position: center;
	z-index: 0;
}

.title-clouds {
	z-index: 1;
	overflow: hidden;
	pointer-events: none;
}

.cloud-band {
	position: absolute;
	left: -45vw;
	display: block;
	width: 48vw;
	min-width: 320px;
	height: 86px;
	border-radius: 999px;
	background:
		radial-gradient(circle at 18% 55%, rgba(247, 241, 223, 0.36), transparent 34%),
		radial-gradient(circle at 46% 42%, rgba(184, 202, 210, 0.32), transparent 38%),
		radial-gradient(circle at 74% 58%, rgba(247, 241, 223, 0.24), transparent 34%);
	filter: blur(9px);
	opacity: 0.62;
	animation-name: cloud-drift;
	animation-timing-function: linear;
	animation-iteration-count: infinite;
}

.cloud-band-a {
	top: 12%;
	animation-duration: 46s;
}

.cloud-band-b {
	top: 22%;
	height: 70px;
	opacity: 0.48;
	animation-duration: 64s;
	animation-delay: -22s;
}

.cloud-band-c {
	top: 34%;
	height: 58px;
	opacity: 0.34;
	animation-duration: 82s;
	animation-delay: -44s;
}

@keyframes cloud-drift {
	from {
		transform: translateX(0);
	}
	to {
		transform: translateX(150vw);
	}
}

.title-vignette {
	z-index: 2;
	background:
		radial-gradient(circle at 50% 36%, rgba(16, 22, 23, 0.1), rgba(16, 22, 23, 0.72) 76%),
		linear-gradient(180deg, rgba(16, 22, 23, 0.04), rgba(16, 22, 23, 0.72) 64%, rgba(16, 22, 23, 0.92));
	pointer-events: none;
}

.title-panel {
	position: relative;
	z-index: 3;
	display: grid;
	gap: clamp(76px, 15vh, 132px);
	justify-items: center;
	width: min(680px, 100%);
	text-align: center;
}

.title-panel h1 {
	margin: 0;
	color: #f7f1df;
	font-size: clamp(3.1rem, 10vw, 6.4rem);
	line-height: 0.9;
	font-weight: 900;
	text-shadow: 0 4px 28px rgba(0, 0, 0, 0.72);
}

.menu-actions {
	display: grid;
	gap: 10px;
	width: min(220px, 100%);
}

.start-button,
.settings-button,
.close-settings-button,
.preset-row button,
.reset-button {
	border-radius: 8px;
	cursor: pointer;
}

.start-button,
.settings-button {
	min-height: 48px;
	border: 1px solid rgba(247, 241, 223, 0.28);
	padding: 12px 18px;
	font-weight: 800;
}

.start-button {
	color: #101617;
	background: #e6c76a;
	box-shadow: 0 16px 44px rgba(0, 0, 0, 0.38);
}

.settings-button {
	color: #f7f1df;
	background: rgba(8, 13, 14, 0.54);
	backdrop-filter: blur(10px);
}

.settings-backdrop {
	z-index: 5;
	display: grid;
	place-items: center;
	padding: 24px;
	background: rgba(8, 13, 14, 0.66);
	backdrop-filter: blur(8px);
}

.settings-panel {
	display: grid;
	gap: 14px;
	width: min(420px, calc(100vw - 48px));
	max-height: min(680px, calc(100dvh - 48px));
	overflow: auto;
	border: 1px solid rgba(247, 241, 223, 0.18);
	border-radius: 8px;
	padding: 16px;
	background: rgba(23, 32, 34, 0.94);
	box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
	text-align: left;
}

.settings-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.settings-header h2 {
	margin: 0;
	color: #f7f1df;
	font-size: 1.35rem;
	line-height: 1.15;
}

.close-settings-button {
	min-height: 36px;
	border: 1px solid rgba(247, 241, 223, 0.2);
	padding: 0 12px;
	color: #f7f1df;
	background: rgba(247, 241, 223, 0.08);
}

.options-panel {
	display: grid;
	gap: 14px;
	width: 100%;
	text-align: left;
}

.preset-row {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
}

.preset-row button,
.reset-button {
	min-height: 38px;
	border: 1px solid rgba(247, 241, 223, 0.18);
	color: #f7f1df;
	background: rgba(247, 241, 223, 0.08);
}

.preset-row button.active {
	border-color: rgba(230, 199, 106, 0.9);
	color: #101617;
	background: #e6c76a;
}

.slider-list {
	display: grid;
	gap: 12px;
}

.option-slider {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 6px 12px;
	align-items: center;
	color: #dce6dd;
	font-size: 0.88rem;
}

.option-slider strong {
	color: #e6c76a;
	font-size: 0.84rem;
	font-variant-numeric: tabular-nums;
}

.option-slider input {
	grid-column: 1 / -1;
	width: 100%;
	accent-color: #e6c76a;
}

.options-footer {
	display: grid;
	grid-template-columns: 132px minmax(0, 1fr);
	gap: 10px;
	align-items: stretch;
}

.reset-button {
	padding: 0 10px;
	font-size: 0.82rem;
	line-height: 1.15;
}

.test-pad {
	display: grid;
	place-items: center;
	min-height: 76px;
	border: 1px dashed rgba(230, 199, 106, 0.54);
	border-radius: 8px;
	padding: 10px;
	color: #f7f1df;
	background: rgba(247, 241, 223, 0.06);
	text-align: center;
	touch-action: none;
	user-select: none;
	cursor: crosshair;
}

.test-pad span {
	font-size: 0.95rem;
	font-weight: 800;
	line-height: 1.15;
}

.test-pad small {
	color: #bac8c5;
	font-size: 0.72rem;
	line-height: 1.1;
}

button:focus-visible,
input:focus-visible {
	outline: 2px solid #f4d982;
	outline-offset: 3px;
}

@media (prefers-reduced-motion: reduce) {
	.cloud-band {
		animation: none;
		transform: translateX(42vw);
	}
}

@media (max-width: 760px) {
	.title-screen {
		align-items: center;
		padding: 18px;
	}

	.title-panel {
		gap: clamp(68px, 16vh, 112px);
	}

	.title-panel h1 {
		font-size: clamp(2.8rem, 17vw, 4.6rem);
	}

	.settings-backdrop {
		align-items: end;
		padding: 12px;
	}

	.settings-panel {
		width: 100%;
		max-height: min(720px, calc(100dvh - 24px));
	}
}

@media (max-width: 420px) {
	.options-footer {
		grid-template-columns: 1fr;
	}
}
```

- [ ] **Step 2: Run browser verification to verify GREEN for the menu flow**

Run:

```bash
bun run verify:browser
```

Expected: PASS through both mobile and desktop viewports. It should open `환경설정`, select `편안`, close the dialog, click `게임 시작`, verify play interactions, go back, and find `게임 시작` plus `환경설정` again.

- [ ] **Step 3: Commit the CSS**

Run:

```bash
git add src/routes/layout.css
git commit -m "style: productionize main menu"
```

Expected: commit succeeds with only `src/routes/layout.css`.

## Task 6: Final Verification

**Files:**
- Verify only. No source edits expected unless a command fails.

- [ ] **Step 1: Verify DESIGN.md**

Run:

```bash
npx @google/design.md lint DESIGN.md
```

Expected: exit code 0, `errors: 0`, `warnings: 0`.

- [ ] **Step 2: Run Svelte and TypeScript checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Run unit and browser component tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 4: Run production build**

Run:

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 5: Run browser smoke verification**

Run:

```bash
bun run verify:browser
```

Expected: PASS.

- [ ] **Step 6: Inspect git status**

Run:

```bash
git status --short
```

Expected: no uncommitted source changes except intentional final documentation updates.

## Self-Review

- Spec coverage: `DESIGN.md` creation and linting are covered by Task 1 and Task 6. Background asset creation is covered by Task 2. Main menu layout, settings overlay, data flow preservation, cloud motion, reduced motion, and browser verification are covered by Tasks 3-6.
- Red-flag scan: no incomplete implementation markers or unspecified steps remain.
- Type consistency: all code snippets use existing `options`, `testPointer`, `testFeedback`, `testDetail`, `presetIds`, `optionControls`, `activePreset`, `applyPreset`, `resetOptions`, `updateOption`, and existing Svelte 5 event property style.
