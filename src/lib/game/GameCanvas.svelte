<script lang="ts">
	import type { ActionStateHandler, RuntimeErrorHandler } from '$lib/game/types';

	let {
		onActionStateChange,
		onRuntimeError
	}: {
		onActionStateChange?: ActionStateHandler;
		onRuntimeError?: RuntimeErrorHandler;
	} = $props();
</script>

<div
	class="game-canvas"
	aria-label="3D action prototype play surface"
	data-action-handler={onActionStateChange ? 'ready' : 'missing'}
	data-error-handler={onRuntimeError ? 'ready' : 'missing'}
></div>
