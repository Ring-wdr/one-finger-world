<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import {
		DEFAULT_INPUT_THRESHOLD_OPTIONS,
		INPUT_THRESHOLD_PRESETS,
		INPUT_THRESHOLD_RANGES,
		clampInputThresholdOptions,
		loadInputThresholdOptions,
		saveInputThresholdOptions,
		type InputThresholdOptions,
		type InputThresholdPresetId
	} from '$lib/game/input/inputThresholdOptions';

	type OptionKey = keyof InputThresholdOptions;

	interface TestPointer {
		pointerId: number;
		startX: number;
		startY: number;
		startTime: number;
		dragStartTime: number | null;
		dragging: boolean;
	}

	const presetIds: InputThresholdPresetId[] = ['comfortable', 'standard', 'fast'];
	const optionControls: {
		key: OptionKey;
		label: string;
		range: (typeof INPUT_THRESHOLD_RANGES)[OptionKey];
		format: (value: number) => string;
	}[] = [
		{
			key: 'tapMs',
			label: '탭 인식 시간',
			range: INPUT_THRESHOLD_RANGES.tapMs,
			format: (value) => `${Math.round(value)} ms`
		},
		{
			key: 'dragStartPx',
			label: '드래그 시작 거리',
			range: INPUT_THRESHOLD_RANGES.dragStartPx,
			format: (value) => `${Math.round(value)} px`
		},
		{
			key: 'fastDragPxPerMs',
			label: '대시 빠르기',
			range: INPUT_THRESHOLD_RANGES.fastDragPxPerMs,
			format: (value) => `${value.toFixed(1)} px/ms`
		}
	];

	let options = $state<InputThresholdOptions>(clampInputThresholdOptions(DEFAULT_INPUT_THRESHOLD_OPTIONS));
	let testPointer = $state<TestPointer | null>(null);
	let testFeedback = $state('대기');
	let testDetail = $state('0 ms / 0 px');

	const activePreset = $derived(
		presetIds.find((presetId) => optionsEqual(options, INPUT_THRESHOLD_PRESETS[presetId].values)) ??
			null
	);

	onMount(() => {
		options = loadInputThresholdOptions(getStorage());
	});

	function startGame() {
		void goto(resolve('/play'));
	}

	function applyPreset(presetId: InputThresholdPresetId) {
		setOptions(INPUT_THRESHOLD_PRESETS[presetId].values);
	}

	function resetOptions() {
		setOptions(DEFAULT_INPUT_THRESHOLD_OPTIONS);
	}

	function updateOption(key: OptionKey, value: number) {
		setOptions({ ...options, [key]: value });
	}

	function setOptions(nextOptions: InputThresholdOptions) {
		options = clampInputThresholdOptions(nextOptions);
		saveInputThresholdOptions(getStorage(), options);
	}

	function handlePadPointerDown(event: PointerEvent) {
		if (event.button !== undefined && event.button !== 0) return;

		event.preventDefault();
		testPointer = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startTime: event.timeStamp,
			dragStartTime: null,
			dragging: false
		};
		testFeedback = '입력 중';
		testDetail = '0 ms / 0 px';
	}

	function handlePadPointerMove(event: PointerEvent) {
		if (!testPointer || testPointer.pointerId !== event.pointerId) return;

		event.preventDefault();
		const distance = distanceFromStart(testPointer, event);
		if (!testPointer.dragging && distance >= options.dragStartPx) {
			testPointer = {
				...testPointer,
				dragging: true,
				dragStartTime: event.timeStamp
			};
			testFeedback = '이동 시작';
			testDetail = `${Math.round(distance)} px`;
		}
	}

	function handlePadPointerUp(event: PointerEvent) {
		if (!testPointer || testPointer.pointerId !== event.pointerId) return;

		event.preventDefault();
		const pointer = testPointer;
		const distance = distanceFromStart(pointer, event);
		const duration = event.timeStamp - pointer.startTime;
		const dragging = pointer.dragging || distance >= options.dragStartPx;
		const dragStartTime = pointer.dragStartTime ?? (dragging ? event.timeStamp : null);
		testPointer = null;

		if (!dragging) {
			if (duration <= options.tapMs && distance < options.dragStartPx) {
				testFeedback = '공격 인식';
				testDetail = `${Math.round(duration)} ms`;
			} else {
				testFeedback = '탭 시간 초과';
				testDetail = `${Math.round(duration)} ms`;
			}
			return;
		}

		const dragDuration = event.timeStamp - (dragStartTime ?? pointer.startTime);
		const speed = distance / Math.max(1, dragDuration);
		if (speed >= options.fastDragPxPerMs) {
			testFeedback = '회피 인식';
		} else {
			testFeedback = '속도 부족';
		}
		testDetail = `${speed.toFixed(2)} px/ms`;
	}

	function distanceFromStart(pointer: TestPointer, event: PointerEvent) {
		return Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
	}

	function optionsEqual(left: InputThresholdOptions, right: Readonly<InputThresholdOptions>) {
		return (
			left.tapMs === right.tapMs &&
			left.dragStartPx === right.dragStartPx &&
			left.fastDragPxPerMs === right.fastDragPxPerMs
		);
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
	<title>One Finger Act</title>
</svelte:head>

<main class="title-screen">
	<section class="title-panel" aria-labelledby="title-heading">
		<div class="title-copy">
			<p class="title-kicker">Svelte + Three.js Prototype</p>
			<h1 id="title-heading">One Finger Act</h1>
			<button class="start-button" type="button" onclick={startGame}>Game Start</button>
		</div>

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
				<button class="reset-button" type="button" onclick={resetOptions}>Reset</button>
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
</main>
