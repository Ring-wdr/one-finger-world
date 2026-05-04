<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	function startGame() {
		void goto(resolve('/play'));
	}
</script>

<svelte:head>
	<title>One Finger Act</title>
</svelte:head>

<main class="title-screen">
	<section class="title-panel" aria-labelledby="title-heading">
		<p class="title-kicker">Svelte + Three.js Prototype</p>
		<h1 id="title-heading">One Finger Act</h1>
		<button class="start-button" type="button" onclick={startGame}>Game Start</button>
	</section>
</main>
