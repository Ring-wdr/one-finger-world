<script lang="ts">
	import { onMount } from 'svelte';
	import type { InputThresholds } from '$lib/game/input/InputController';
	import type { ActionStateHandler, RuntimeErrorHandler } from '$lib/game/types';

	let {
		inputThresholds,
		onActionStateChange,
		onRuntimeError
	}: {
		inputThresholds?: InputThresholds;
		onActionStateChange: ActionStateHandler;
		onRuntimeError: RuntimeErrorHandler;
	} = $props();

	let host: HTMLDivElement;

	onMount(() => {
		let cancelled = false;
		let runtime: import('$lib/game/runtime/GameRuntime').GameRuntime | null = null;

		void import('$lib/game/runtime/GameRuntime')
			.then(({ GameRuntime }) => {
				if (cancelled) return;

				runtime = new GameRuntime({
					container: host,
					inputThresholds,
					onActionStateChange,
					onRuntimeError
				});
			})
			.catch((error: unknown) => {
				if (cancelled) return;

				onRuntimeError(getRuntimeImportErrorMessage(error));
			});

		return () => {
			cancelled = true;
			runtime?.dispose();
			runtime = null;
		};
	});

	function getRuntimeImportErrorMessage(error: unknown) {
		if (error instanceof Error && error.message) {
			return `Unable to load 3D runtime: ${error.message}`;
		}

		return 'Unable to load 3D runtime.';
	}
</script>

<div
	bind:this={host}
	class="game-canvas"
	aria-label="3D action prototype play surface"
></div>
