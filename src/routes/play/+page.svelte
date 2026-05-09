<script lang="ts">
	import GameCanvas from '$lib/game/GameCanvas.svelte';
	import {
		DEFAULT_INPUT_THRESHOLD_OPTIONS,
		inputThresholdOptionsToThresholds,
		loadInputThresholdOptions
	} from '$lib/game/input/inputThresholdOptions';
	import { IDLE_ACTION, type ActionState } from '$lib/game/types';
	import { onMount } from 'svelte';

	let actionState = $state<ActionState>(IDLE_ACTION);
	let runtimeError = $state<string | null>(null);
	let inputThresholds = $state(inputThresholdOptionsToThresholds(DEFAULT_INPUT_THRESHOLD_OPTIONS));
	let runtimeReady = $state(false);

	onMount(() => {
		inputThresholds = inputThresholdOptionsToThresholds(loadInputThresholdOptions(getStorage()));
		runtimeReady = true;
	});

	function handleActionStateChange(nextState: ActionState) {
		actionState = nextState;
	}

	function handleRuntimeError(message: string) {
		runtimeError = message;
	}

	function getStorage(): Storage | undefined {
		try {
			return typeof window === 'undefined' ? undefined : window.localStorage;
		} catch {
			return undefined;
		}
	}
</script>

<svelte:head>
	<title>Play - One Finger Act</title>
</svelte:head>

<main class="play-screen">
	{#if runtimeReady}
		<GameCanvas
			{inputThresholds}
			onActionStateChange={handleActionStateChange}
			onRuntimeError={handleRuntimeError}
		/>
	{/if}

	<div class="hud" aria-live="polite">
		<span class="hud-label">State</span>
		<strong>{actionState.label}</strong>
	</div>

	{#if runtimeError}
		<div class="runtime-error" role="alert">{runtimeError}</div>
	{/if}
</main>
