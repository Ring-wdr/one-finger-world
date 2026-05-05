import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PhysicsFeedbackActor } from './PhysicsFeedbackActor';

describe('PhysicsFeedbackActor', () => {
	it('places pointer feedback on an untilted screen-space layer', () => {
		const actor = new PhysicsFeedbackActor();
		actor.setViewportSize(200, 100);

		actor.handlePointerFeedback({
			event: {
				type: 'press',
				start: { x: 60, y: 70 },
				thumb: { x: 60, y: 70 },
				timeStamp: 0
			},
			startScreen: { x: 60, y: 70 },
			thumbScreen: { x: 60, y: 70 }
		});

		const startAnchor = actor.group.getObjectByName('start-anchor') as THREE.Mesh;

		expect(startAnchor.position.x).toBe(-40);
		expect(startAnchor.position.y).toBe(-20);
		expect(startAnchor.position.z).toBe(0);
		expect(startAnchor.rotation.x).toBe(0);
		expect(startAnchor.rotation.y).toBe(0);

		actor.dispose();
	});

	it('keeps the tether flat in the screen layer while dragging', () => {
		const actor = new PhysicsFeedbackActor();
		actor.setViewportSize(200, 200);

		actor.handlePointerFeedback({
			event: {
				type: 'press',
				start: { x: 100, y: 100 },
				thumb: { x: 100, y: 100 },
				timeStamp: 0
			},
			startScreen: { x: 100, y: 100 },
			thumbScreen: { x: 100, y: 100 }
		});
		actor.handlePointerFeedback({
			event: {
				type: 'drag',
				start: { x: 100, y: 100 },
				thumb: { x: 140, y: 100 },
				direction: { x: 1, y: 0 },
				mode: 'walk',
				timeStamp: 16
			},
			startScreen: { x: 100, y: 100 },
			thumbScreen: { x: 140, y: 100 }
		});
		actor.update(0.016);

		const tether = actor.group.getObjectByName('feedback-tether') as THREE.Mesh;

		expect(tether.visible).toBe(true);
		expect(tether.rotation.x).toBe(0);
		expect(tether.rotation.y).toBe(0);

		actor.dispose();
	});
});
