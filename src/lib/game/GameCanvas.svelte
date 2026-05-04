<script lang="ts">
	import type { ActionStateHandler, RuntimeErrorHandler } from '$lib/game/types';

	let {
		onActionStateChange,
		onRuntimeError
	}: {
		onActionStateChange: ActionStateHandler;
		onRuntimeError: RuntimeErrorHandler;
	} = $props();

	$effect(() => {
		void onActionStateChange;
		void onRuntimeError;
	});
</script>

<div
	class="game-canvas"
	aria-label="3D action prototype play surface"
></div>
