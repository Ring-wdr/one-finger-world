import { describe, expect, it } from 'vitest';
import type { InputFeedbackEvent, InputGesture } from '$lib/game/types';
import { InputController, type PointerSurface } from './InputController';

type Listener = (event: PointerEvent) => void;
type ListenerMap = Record<string, Listener[]>;
type CoreInputFeedbackEvent = Extract<
	InputFeedbackEvent,
	{ type: 'press' | 'drag' | 'release' | 'cancel' }
>;

const CORE_FEEDBACK_TYPES = new Set<InputFeedbackEvent['type']>([
	'press',
	'drag',
	'release',
	'cancel'
]);

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

	listenerCount(type: string) {
		return this.listeners[type]?.length ?? 0;
	}
}

function setup() {
	const target = new FakePointerSurface();
	const gestures: InputGesture[] = [];
	const feedback: InputFeedbackEvent[] = [];
	const controller = new InputController(
		target,
		(gesture) => gestures.push(gesture),
		undefined,
		(event) => feedback.push(event)
	);

	return { target, gestures, feedback, controller };
}

function coreFeedback(feedback: InputFeedbackEvent[]): CoreInputFeedbackEvent[] {
	return feedback.filter((event): event is CoreInputFeedbackEvent =>
		CORE_FEEDBACK_TYPES.has(event.type)
	);
}

describe('InputController', () => {
	it('emits press feedback with the fixed start point and initial thumb point', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 40, clientY: 60, timeStamp: 12 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 40, y: 60 },
				thumb: { x: 40, y: 60 },
				timeStamp: 12
			}
		]);
	});

	it('emits drag feedback with fixed start and moving thumb points', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 120, clientY: 86, timeStamp: 60 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 100, y: 100 },
				thumb: { x: 100, y: 100 },
				timeStamp: 0
			},
			{
				type: 'drag',
				start: { x: 100, y: 100 },
				thumb: { x: 120, y: 86 },
				direction: expect.objectContaining({
					x: expect.closeTo(0.8192319205190405, 10),
					y: expect.closeTo(0.5734623443633283, 10)
				}),
				mode: 'walk',
				timeStamp: 60
			}
		]);
	});

	it('emits release feedback even when the thumb point never leaves the start point', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 24, clientY: 36, timeStamp: 0 });
		target.fire('pointerup', { pointerId: 1, clientX: 24, clientY: 36, timeStamp: 80 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 24, y: 36 },
				thumb: { x: 24, y: 36 },
				timeStamp: 0
			},
			{
				type: 'release',
				start: { x: 24, y: 36 },
				thumb: { x: 24, y: 36 },
				wasDragging: false,
				timeStamp: 80
			}
		]);
	});

	it('emits cancel feedback for active drag cleanup', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 4, clientX: 10, clientY: 20, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 4, clientX: 40, clientY: 20, timeStamp: 30 });
		target.fire('pointercancel', { pointerId: 4, clientX: 40, clientY: 20, timeStamp: 40 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 10, y: 20 },
				thumb: { x: 10, y: 20 },
				timeStamp: 0
			},
			{
				type: 'drag',
				start: { x: 10, y: 20 },
				thumb: { x: 40, y: 20 },
				direction: { x: 1, y: 0 },
				mode: 'walk',
				timeStamp: 30
			},
			{
				type: 'cancel',
				start: { x: 10, y: 20 },
				thumb: { x: 40, y: 20 },
				wasDragging: true,
				timeStamp: 40
			}
		]);
	});

	it('does not emit feedback for ignored secondary pointers', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointerdown', { pointerId: 2, clientX: 80, clientY: 80, timeStamp: 10 });
		target.fire('pointermove', { pointerId: 2, clientX: 120, clientY: 80, timeStamp: 20 });
		target.fire('pointerup', { pointerId: 2, clientX: 120, clientY: 80, timeStamp: 30 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 0, y: 0 },
				thumb: { x: 0, y: 0 },
				timeStamp: 0
			}
		]);
		expect(feedback.filter((event) => event.type === 'skill-buttons')).toHaveLength(1);
	});

	it('isolates feedback handler errors from gesture emission and cleanup', () => {
		const target = new FakePointerSurface();
		const gestures: InputGesture[] = [];
		new InputController(
			target,
			(gesture) => gestures.push(gesture),
			undefined,
			() => {
				throw new Error('feedback failed');
			}
		);

		expect(() => {
			target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
			target.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 0, timeStamp: 30 });
			target.fire('pointerup', { pointerId: 1, clientX: 20, clientY: 0, timeStamp: 60 });
		}).not.toThrow();
		expect(target.releaseCalls).toEqual([1]);
		expect(gestures).toEqual([
			{ type: 'move', mode: 'walk', direction: { x: 1, y: 0 } },
			{ type: 'idle' }
		]);
	});

	it('emits cancel feedback with the cancel event thumb point', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 3, clientX: 10, clientY: 20, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 3, clientX: 40, clientY: 20, timeStamp: 30 });
		target.fire('pointercancel', { pointerId: 3, clientX: 70, clientY: 90, timeStamp: 40 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 10, y: 20 },
				thumb: { x: 10, y: 20 },
				timeStamp: 0
			},
			{
				type: 'drag',
				start: { x: 10, y: 20 },
				thumb: { x: 40, y: 20 },
				direction: { x: 1, y: 0 },
				mode: 'walk',
				timeStamp: 30
			},
			{
				type: 'cancel',
				start: { x: 10, y: 20 },
				thumb: { x: 70, y: 90 },
				wasDragging: true,
				timeStamp: 40
			}
		]);
	});

	it('emits lost capture feedback with the lost capture event thumb point', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 5, clientX: 10, clientY: 20, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 5, clientX: 40, clientY: 20, timeStamp: 30 });
		target.fire('lostpointercapture', { pointerId: 5, clientX: 72, clientY: 96, timeStamp: 40 });

		expect(coreFeedback(feedback)).toEqual([
			{
				type: 'press',
				start: { x: 10, y: 20 },
				thumb: { x: 10, y: 20 },
				timeStamp: 0
			},
			{
				type: 'drag',
				start: { x: 10, y: 20 },
				thumb: { x: 40, y: 20 },
				direction: { x: 1, y: 0 },
				mode: 'walk',
				timeStamp: 30
			},
			{
				type: 'cancel',
				start: { x: 10, y: 20 },
				thumb: { x: 72, y: 96 },
				wasDragging: true,
				timeStamp: 40
			}
		]);
	});

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
			{ type: 'move', mode: 'walk', direction: { x: 1, y: 0 } },
			{ type: 'idle' }
		]);
	});

	it('keeps a held short drag in walk mode', () => {
		const { target, gestures, controller } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 0, timeStamp: 100 });
		controller.update();
		controller.update();

		expect(gestures).toEqual([{ type: 'move', mode: 'walk', direction: { x: 1, y: 0 } }]);
	});

	it('keeps short drags in walk mode', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 70, clientY: 0, timeStamp: 140 });

		expect(gestures).toEqual([{ type: 'move', mode: 'walk', direction: { x: 1, y: 0 } }]);
	});

	it('upgrades drag to run by clear long drag distance', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 72, clientY: 0, timeStamp: 140 });

		expect(gestures).toEqual([{ type: 'move', mode: 'run', direction: { x: 1, y: 0 } }]);
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
			{ type: 'move', mode: 'run', direction: { x: 1, y: 0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'run', direction: { x: 0, y: 1 } },
			{ type: 'dash', direction: { x: 0, y: 1 } }
		]);
	});

	it('measures fast drag speed from drag start instead of pointer down latency', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 110, clientY: 0, timeStamp: 170 });
		target.fire('pointerup', { pointerId: 1, clientX: 110, clientY: 0, timeStamp: 260 });

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 420 });
		target.fire('pointermove', { pointerId: 1, clientX: 110, clientY: 0, timeStamp: 530 });
		target.fire('pointerup', { pointerId: 1, clientX: 110, clientY: 0, timeStamp: 560 });

		expect(gestures).toEqual([
			{ type: 'move', mode: 'run', direction: { x: 1, y: 0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'run', direction: { x: 1, y: 0 } },
			{ type: 'dash', direction: { x: 1, y: 0 } }
		]);
	});

	it('treats release-only swipes as fast drags for dash detection', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 80 });

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 260 });
		target.fire('pointerup', { pointerId: 1, clientX: 0, clientY: -80, timeStamp: 340 });

		expect(gestures).toEqual([{ type: 'idle' }, { type: 'dash', direction: { x: 0, y: 1 } }]);
	});

	it('does not dash when a skill drag releases inside a prior fast-drag window', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 60 });
		target.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 80 });

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 260 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 280 });
		target.fire('pointerup', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 300 });

		expect(gestures.filter((gesture) => gesture.type === 'dash')).toEqual([]);
		expect(gestures.at(-2)).toEqual({ type: 'skill', slot: 1 });
		expect(gestures.at(-1)).toEqual({ type: 'idle' });
	});

	it('does not let a skill drag release arm the next fast drag into a dash', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 40 });
		target.fire('pointerup', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 80 });

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 220 });
		target.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 260 });
		target.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 0, timeStamp: 280 });

		expect(gestures.filter((gesture) => gesture.type === 'dash')).toEqual([]);
		expect(gestures).toContainEqual({ type: 'skill', slot: 1 });
		expect(gestures.at(-1)).toEqual({ type: 'idle' });
	});

	it('does not expose signed zero in direction payloads', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 14, clientY: 0, timeStamp: 80 });

		expect(gestures).toHaveLength(1);
		const [gesture] = gestures;
		expect(gesture.type).toBe('move');

		if (gesture.type === 'move') {
			expect(gesture.direction).toEqual({ x: 1, y: 0 });
			expect(Object.is(gesture.direction.x, -0)).toBe(false);
			expect(Object.is(gesture.direction.y, -0)).toBe(false);
		}
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
			{ type: 'move', mode: 'walk', direction: { x: 1, y: 0 } },
			{ type: 'idle' },
			{ type: 'move', mode: 'walk', direction: { x: 0, y: 1 } },
			{ type: 'idle' }
		]);
	});

	it('shows fixed diagonal skill buttons on press outside the run threshold', () => {
		const { target, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 5 });

		expect(feedback.at(0)).toEqual({
			type: 'press',
			start: { x: 100, y: 120 },
			thumb: { x: 100, y: 120 },
			timeStamp: 5
		});
		expect(feedback.at(1)).toEqual({
			type: 'skill-buttons',
			buttons: [
				{ slot: 1, center: { x: 212, y: 8 }, radius: 24 },
				{ slot: 2, center: { x: -12, y: 8 }, radius: 24 },
				{ slot: 3, center: { x: 212, y: 232 }, radius: 24 },
				{ slot: 4, center: { x: -12, y: 232 }, radius: 24 }
			],
			timeStamp: 5
		});

		const skillButtons = feedback.at(1);
		expect(skillButtons?.type).toBe('skill-buttons');
		if (skillButtons?.type === 'skill-buttons') {
			for (const button of skillButtons.buttons) {
				const distance = Math.hypot(button.center.x - 100, button.center.y - 120);
				expect(distance - button.radius).toBeGreaterThan(72);
			}
		}
	});

	it('emits one skill gesture and hides skill buttons when the thumb enters a slot', () => {
		const { target, gestures, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 100 });
		target.fire('pointermove', { pointerId: 1, clientX: 210, clientY: 10, timeStamp: 120 });

		expect(gestures).toEqual([
			{
				type: 'move',
				mode: 'run',
				direction: {
					x: expect.closeTo(0.7071067811865475, 10),
					y: expect.closeTo(0.7071067811865475, 10)
				}
			},
			{ type: 'skill', slot: 1 },
			{
				type: 'move',
				mode: 'run',
				direction: {
					x: expect.closeTo(0.7071067811865475, 10),
					y: expect.closeTo(0.7071067811865475, 10)
				}
			}
		]);
		expect(feedback.at(-1)).toEqual({
			type: 'drag',
			start: { x: 100, y: 120 },
			thumb: { x: 210, y: 10 },
			direction: {
				x: expect.closeTo(0.7071067811865475, 10),
				y: expect.closeTo(0.7071067811865475, 10)
			},
			mode: 'run',
			timeStamp: 120
		});
		expect(feedback).toContainEqual({ type: 'skill-buttons-hidden', timeStamp: 100 });
		expect(feedback.filter((event) => event.type === 'skill-buttons-hidden')).toHaveLength(1);
	});

	it('fires only the first skill during a single touch after buttons hide', () => {
		const { target, gestures } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 100 });
		target.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 140 });
		target.fire('pointermove', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 180 });
		target.fire('pointermove', { pointerId: 1, clientX: -12, clientY: 8, timeStamp: 220 });

		expect(gestures.filter((gesture) => gesture.type === 'skill')).toEqual([
			{ type: 'skill', slot: 1 }
		]);
	});

	it('does not trigger skills from release-only swipes or ignored secondary pointers', () => {
		const { target, gestures, feedback } = setup();

		target.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 120, timeStamp: 0 });
		target.fire('pointerdown', { pointerId: 2, clientX: 100, clientY: 120, timeStamp: 10 });
		target.fire('pointermove', { pointerId: 2, clientX: 212, clientY: 8, timeStamp: 40 });
		target.fire('pointerup', { pointerId: 1, clientX: 212, clientY: 8, timeStamp: 80 });

		expect(gestures).toEqual([{ type: 'idle' }]);
		expect(feedback.filter((event) => event.type === 'skill-buttons-hidden')).toHaveLength(1);
	});

	it('dispose releases active capture, removes listeners, and suppresses later emissions', () => {
		const { target, gestures, controller } = setup();

		expect(target.listenerCount('pointerdown')).toBe(1);
		target.fire('pointerdown', { pointerId: 5, clientX: 0, clientY: 0, timeStamp: 0 });

		controller.dispose();
		controller.dispose();
		target.fire('pointermove', { pointerId: 5, clientX: 80, clientY: 0, timeStamp: 100 });
		target.fire('pointerup', { pointerId: 5, clientX: 80, clientY: 0, timeStamp: 120 });
		controller.update();

		expect(target.releaseCalls).toEqual([5]);
		expect(target.listenerCount('pointerdown')).toBe(0);
		expect(target.listenerCount('pointermove')).toBe(0);
		expect(target.listenerCount('pointerup')).toBe(0);
		expect(target.listenerCount('pointercancel')).toBe(0);
		expect(target.listenerCount('lostpointercapture')).toBe(0);
		expect(gestures).toEqual([]);
	});
});
