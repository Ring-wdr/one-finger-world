import { describe, expect, it } from 'vitest';
import type { InputGesture } from '$lib/game/types';
import { InputController, type PointerSurface } from './InputController';

type Listener = (event: PointerEvent) => void;
type ListenerMap = Record<string, Listener[]>;

class FakePointerSurface implements PointerSurface {
	readonly listeners: ListenerMap = {};
	readonly captured = new Set<number>();
	readonly captureCalls: number[] = [];
	readonly releaseCalls: number[] = [];

	addEventListener(type: string, listener: Listener) {
		this.listeners[type] ??= [];
		this.listeners[type].push(listener);
	}

	removeEventListener(type: string, listener: Listener) {
		this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener);
	}

	setPointerCapture(pointerId: number) {
		this.captureCalls.push(pointerId);
		this.captured.add(pointerId);
	}

	releasePointerCapture(pointerId: number) {
		this.releaseCalls.push(pointerId);
		this.captured.delete(pointerId);
	}

	fire(type: string, event: Partial<PointerEvent>) {
		const sample = {
			pointerId: 1,
			clientX: 0,
			clientY: 0,
			timeStamp: 0,
			button: 0,
			preventDefault: () => undefined,
			...event
		} as PointerEvent;

		for (const listener of this.listeners[type] ?? []) {
			listener(sample);
		}
	}
}

function setup() {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	const controller = new InputController(target, (gesture) => gestures.push(gesture));

	return { target, gestures, controller };
}

describe('InputController', () => {
	it('recognizes taps and cycles attack combo steps', () => {
		const { target, gestures } = setup();

		for (let index = 0; index < 4; index += 1) {
			const start = index * 220;
			target.fire('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: start });
			target.fire('pointerup', { pointerId: 1, clientX: 22, clientY: 10, timeStamp: start + 180 });
		}

		expect(gestures).toEqual([
			{ type: 'attack', comboStep: 1 },
			{ type: 'attack', comboStep: 2 },
			{ type: 'attack', comboStep: 3 },
			{ type: 'attack', comboStep: 1 }
		]);
	});

	it('captures one active pointer and ignores secondary pointers', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointerdown', { pointerId: 2, clientX: 0, clientY: 0, timeStamp: 10 });
		target.fire('pointermove', { pointerId: 2, clientX: 80, clientY: 0, timeStamp: 40 });
		target.fire('pointerup', { pointerId: 2, clientX: 80, clientY: 0, timeStamp: 60 });
		target.fire('pointerup', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 100 });

		expect(target.captureCalls).toEqual([1]);
		expect(target.releaseCalls).toEqual([1]);
		expect(gestures).toEqual([{ type: 'attack', comboStep: 1 }]);
	});

	it('starts dragging at 14 px and prevents that press from becoming an attack', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 114, clientY: 100, timeStamp: 80 });
		target.fire('pointerup', { pointerId: 1, clientX: 114, clientY: 100, timeStamp: 120 });

		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: -0 } },
			{ type: 'idle' }
		]);
	});

	it('upgrades drag to run by hold duration', () => {
		const { target, gestures, controller } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 0, timeStamp: 100 });
		controller.update(549);
		controller.update(550);

		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: -0 } },
			{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } }
		]);
	});

	it('upgrades drag to run by drag distance', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 72, clientY: 0, timeStamp: 140 });

		expect(gestures).toEqual([{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } }]);
	});

	it('requires two fast drags inside the dash window and uses the latest direction', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 60 });
		target.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 80 });

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 260 });
		target.fire('pointermove', { pointerId: 1, clientX: 0, clientY: -80, timeStamp: 320 });
		target.fire('pointerup', { pointerId: 1, clientX: 0, clientY: -80, timeStamp: 340 });

		expect(gestures).toEqual([
			{ type: 'move', mode: 'run', direction: { x: 1, y: -0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'run', direction: { x: 0, y: 1 } },
			{ type: 'dash', direction: { x: 0, y: 1 } }
		]);
	});

	it('emits idle for a long press released under the drag threshold', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 40, clientY: 40, timeStamp: 0 });
		target.fire('pointerup', { pointerId: 1, clientX: 53, clientY: 40, timeStamp: 181 });

		expect(gestures).toEqual([{ type: 'idle' }]);
	});

	it('resets active drag state on pointercancel and lost capture', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 7, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 7, clientX: 30, clientY: 0, timeStamp: 90 });
		target.fire('pointercancel', { pointerId: 7, clientX: 30, clientY: 0, timeStamp: 100 });

		target.fire('pointerdown', { pointerId: 8, clientX: 0, clientY: 0, timeStamp: 200 });
		target.fire('pointermove', { pointerId: 8, clientX: 0, clientY: -30, timeStamp: 260 });
		target.fire('lostpointercapture', { pointerId: 8, clientX: 0, clientY: -30, timeStamp: 270 });

		expect(target.releaseCalls).toEqual([7, 8]);
		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: -0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'walk', direction: { x: 0, y: 1 } },
			{ type: 'idle' }
		]);
	});
});
