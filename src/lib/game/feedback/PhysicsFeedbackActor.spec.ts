import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PhysicsFeedbackActor } from './PhysicsFeedbackActor';

describe('PhysicsFeedbackActor', () => {
	it('shows skill buttons in the screen-space layer with stable slot names', () => {
		const actor = new PhysicsFeedbackActor();

		actor.handlePointerFeedback({
			event: {
				type: 'skill-buttons',
				buttons: [
					{ slot: 1, center: { x: 20, y: 30 }, radius: 24 },
					{ slot: 2, center: { x: 40, y: 50 }, radius: 24 },
					{ slot: 3, center: { x: 60, y: 70 }, radius: 24 },
					{ slot: 4, center: { x: 80, y: 90 }, radius: 24 }
				],
				timeStamp: 0
			},
			startScreen: { x: 0, y: 0 },
			thumbScreen: { x: 0, y: 0 }
		});

		for (const slot of [1, 2, 3, 4]) {
			const skillButton = actor.group.getObjectByName(`skill-button-${slot}`) as THREE.Mesh;

			expect(skillButton).toBeInstanceOf(THREE.Mesh);
			expect(skillButton.visible).toBe(true);
			expect(skillButton.parent).toBe(actor.group);
			expect(actor.worldGroup.getObjectByName(`skill-button-${slot}`)).toBeUndefined();
		}

		actor.dispose();
	});

	it('maps skill button feedback-screen centers into the screen-space layer', () => {
		const actor = new PhysicsFeedbackActor();
		actor.setViewportSize(200, 100);

		actor.handlePointerFeedback({
			event: {
				type: 'skill-buttons',
				buttons: [{ slot: 1, center: { x: 60, y: 70 }, radius: 24 }],
				timeStamp: 0
			},
			startScreen: { x: 0, y: 0 },
			thumbScreen: { x: 0, y: 0 }
		});

		const skillButton = actor.group.getObjectByName('skill-button-1') as THREE.Mesh;

		expect(skillButton.visible).toBe(true);
		expect(skillButton.position.x).toBe(-40);
		expect(skillButton.position.y).toBe(-20);
		expect(skillButton.position.z).toBe(0);
		expect(skillButton.rotation.x).toBe(0);
		expect(skillButton.rotation.y).toBe(0);
		expect(actor.group.getObjectByName('skill-button-2')?.visible).toBe(false);
		expect(actor.group.getObjectByName('skill-button-3')?.visible).toBe(false);
		expect(actor.group.getObjectByName('skill-button-4')?.visible).toBe(false);

		actor.dispose();
	});

	it('hides skill buttons without hiding the start anchor or run halo', () => {
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
				thumb: { x: 180, y: 100 },
				direction: { x: 1, y: 0 },
				mode: 'run',
				timeStamp: 16
			},
			startScreen: { x: 100, y: 100 },
			thumbScreen: { x: 180, y: 100 }
		});
		actor.update(0.016);
		actor.update(0.016);
		actor.handlePointerFeedback({
			event: {
				type: 'skill-buttons',
				buttons: [
					{ slot: 1, center: { x: 180, y: 20 }, radius: 24 },
					{ slot: 2, center: { x: 20, y: 20 }, radius: 24 }
				],
				timeStamp: 20
			},
			startScreen: { x: 0, y: 0 },
			thumbScreen: { x: 0, y: 0 }
		});

		actor.handlePointerFeedback({
			event: { type: 'skill-buttons-hidden', timeStamp: 24 },
			startScreen: { x: 0, y: 0 },
			thumbScreen: { x: 0, y: 0 }
		});

		const startAnchor = actor.group.getObjectByName('start-anchor') as THREE.Mesh;
		const runHalo = actor.group.getObjectByName('run-halo') as THREE.Mesh;

		expect(actor.group.getObjectByName('skill-button-1')?.visible).toBe(false);
		expect(actor.group.getObjectByName('skill-button-2')?.visible).toBe(false);
		expect(startAnchor.visible).toBe(true);
		expect(runHalo.visible).toBe(true);

		actor.dispose();
	});

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
