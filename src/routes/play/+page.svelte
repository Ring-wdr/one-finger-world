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
