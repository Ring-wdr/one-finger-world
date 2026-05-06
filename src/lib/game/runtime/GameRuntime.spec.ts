import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionState, InputFeedbackEvent, InputGesture, ScreenPoint } from '$lib/game/types';

class FakeDomElement {
	style: Record<string, string> = {};
	bounds = { left: 0, top: 0 };
	private readonly listeners: Record<string, ((event: PointerEvent) => void)[]> = {};

	addEventListener(type: string, listener: (event: PointerEvent) => void) {
		this.listeners[type] ??= [];
		this.listeners[type].push(listener);
	}

	removeEventListener(type: string, listener: (event: PointerEvent) => void) {
		this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener);
	}

	getBoundingClientRect() {
		return this.bounds;
	}
}

vi.mock('three', async (importOriginal) => {
	const actual = await importOriginal<typeof import('three')>();

	return {
		...actual,
		WebGLRenderer: class FakeWebGLRenderer {
			readonly domElement = new FakeDomElement();
			autoClear = false;
			outputColorSpace = '';

			setPixelRatio() {}
			setSize() {}
			clear() {}
			clearDepth() {}
			render() {}
			dispose() {}
		}
	};
});

interface RuntimeInternals {
	feedback: {
		handlePointerFeedback(event: ScreenInputFeedbackEvent): void;
		handleGesture(gesture: InputGesture, playerWorld: unknown): void;
		dispose(): void;
	};
	renderer: {
		domElement: FakeDomElement;
	};
	handleGesture(gesture: InputGesture): void;
	handleInputFeedback(event: InputFeedbackEvent): void;
}

interface ScreenInputFeedbackEvent {
	event: InputFeedbackEvent;
	startScreen: ScreenPoint;
	thumbScreen: ScreenPoint;
}

const originalWindow = globalThis.window;
const originalPerformance = globalThis.performance;

describe('GameRuntime', () => {
	beforeEach(() => {
		vi.stubGlobal('window', {
			devicePixelRatio: 1,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			requestAnimationFrame: vi.fn(() => 1),
			cancelAnimationFrame: vi.fn()
		});
		vi.stubGlobal('performance', {
			now: vi.fn(() => 0)
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalWindow === undefined) {
			delete (globalThis as { window?: Window }).window;
		} else {
			globalThis.window = originalWindow;
		}
		globalThis.performance = originalPerformance;
	});

	it('preserves the current movement action when a skill gesture arrives', async () => {
		const { GameRuntime } = await import('./GameRuntime');
		const actions: ActionState[] = [];
		const runtime = new GameRuntime({
			container: createContainer(),
			onActionStateChange: (state) => actions.push(state),
			onRuntimeError: () => undefined
		});
		const internals = runtime as unknown as RuntimeInternals;

		internals.handleGesture({ type: 'move', mode: 'run', direction: { x: 1, y: 0 } });
		internals.handleGesture({ type: 'skill', slot: 1 });

		expect(actions.map((action) => action.kind)).toEqual(['idle', 'run']);

		runtime.dispose();
	});

	it('converts skill button centers without resetting cached feedback coordinates', async () => {
		const { GameRuntime } = await import('./GameRuntime');
		const pointerFeedback: ScreenInputFeedbackEvent[] = [];
		const runtime = new GameRuntime({
			container: createContainer(),
			onActionStateChange: () => undefined,
			onRuntimeError: () => undefined
		});
		const internals = runtime as unknown as RuntimeInternals;
		internals.renderer.domElement.bounds = { left: 20, top: 30 };
		internals.feedback = {
			handlePointerFeedback: (event) => pointerFeedback.push(clonePointerFeedback(event)),
			handleGesture: () => undefined,
			dispose: () => undefined
		};

		internals.handleInputFeedback({
			type: 'press',
			start: { x: 42, y: 52 },
			thumb: { x: 62, y: 72 },
			timeStamp: 0
		});
		internals.handleInputFeedback({
			type: 'skill-buttons',
			buttons: [
				{ slot: 1, center: { x: 132, y: 142 }, radius: 24 },
				{ slot: 2, center: { x: 4, y: 18 }, radius: 18 }
			],
			timeStamp: 10
		});
		internals.handleInputFeedback({ type: 'skill-buttons-hidden', timeStamp: 20 });

		expect(pointerFeedback).toEqual([
			{
				event: {
					type: 'press',
					start: { x: 42, y: 52 },
					thumb: { x: 62, y: 72 },
					timeStamp: 0
				},
				startScreen: { x: 22, y: 22 },
				thumbScreen: { x: 42, y: 42 }
			},
			{
				event: {
					type: 'skill-buttons',
					buttons: [
						{ slot: 1, center: { x: 112, y: 112 }, radius: 24 },
						{ slot: 2, center: { x: -16, y: -12 }, radius: 18 }
					],
					timeStamp: 10
				},
				startScreen: { x: 22, y: 22 },
				thumbScreen: { x: 42, y: 42 }
			},
			{
				event: { type: 'skill-buttons-hidden', timeStamp: 20 },
				startScreen: { x: 22, y: 22 },
				thumbScreen: { x: 42, y: 42 }
			}
		]);

		runtime.dispose();
	});
});

function createContainer() {
	return {
		clientWidth: 320,
		clientHeight: 240,
		appendChild: vi.fn(),
		removeChild: vi.fn(),
		getBoundingClientRect: () => ({ width: 320, height: 240 })
	} as unknown as HTMLElement;
}

function clonePointerFeedback(event: ScreenInputFeedbackEvent): ScreenInputFeedbackEvent {
	return {
		event: structuredClone(event.event),
		startScreen: { ...event.startScreen },
		thumbScreen: { ...event.thumbScreen }
	};
}
