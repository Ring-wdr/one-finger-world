import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BeamActor } from './BeamActor';

function meshMaterials(actor: BeamActor) {
	return actor.group.children
		.filter((child): child is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> => {
			return child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial;
		})
		.map((mesh) => mesh.material);
}

describe('BeamActor', () => {
	it('starts visible from player origin in captured direction', () => {
		const actor = new BeamActor();

		actor.start(new THREE.Vector3(1, 2, 3), new THREE.Vector3(1, 4, 0));

		expect(actor.group.name).toBe('BeamActor');
		expect(actor.group.visible).toBe(true);
		expect(actor.group.position.x).toBe(1);
		expect(actor.group.position.y).toBeCloseTo(2.95);
		expect(actor.group.position.z).toBe(3);
		expect(actor.group.rotation.y).toBeCloseTo(Math.PI / 2);
		expect(actor.group.children.length).toBeGreaterThan(0);

		actor.dispose();
	});

	it('keeps captured beam direction while origin follows player movement via setOrigin', () => {
		const actor = new BeamActor();
		const direction = new THREE.Vector3(0, 0, -1);

		actor.start(new THREE.Vector3(0, 0, 0), direction);
		direction.set(1, 0, 0);
		actor.setOrigin(new THREE.Vector3(4, 2, -3));

		expect(actor.group.visible).toBe(true);
		expect(actor.group.position.x).toBe(4);
		expect(actor.group.position.y).toBeCloseTo(2.95);
		expect(actor.group.position.z).toBe(-3);
		expect(actor.group.rotation.y).toBeCloseTo(Math.PI);

		actor.dispose();
	});

	it('expires after 3 seconds and can be restarted/refreshed', () => {
		const actor = new BeamActor();

		actor.start(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
		const startingOpacity = meshMaterials(actor)[0].opacity;

		actor.update(2.9);

		expect(actor.group.visible).toBe(true);
		expect(meshMaterials(actor)[0].opacity).toBeLessThan(startingOpacity);

		actor.update(0.1);

		expect(actor.group.visible).toBe(false);

		actor.start(new THREE.Vector3(2, 1, 4), new THREE.Vector3(0, 0, 0));

		expect(actor.group.visible).toBe(true);
		expect(actor.group.position.x).toBe(2);
		expect(actor.group.position.y).toBeCloseTo(1.95);
		expect(actor.group.position.z).toBe(4);
		expect(actor.group.rotation.y).toBe(0);
		expect(meshMaterials(actor)[0].opacity).toBe(startingOpacity);

		actor.dispose();
	});

	it('falls back to +Z when direction has a non-finite horizontal component', () => {
		const actor = new BeamActor();

		actor.start(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, Number.NaN));

		expect(actor.group.rotation.y).toBe(0);

		actor.dispose();
	});

	it('dispose removes from scene graph and clears children', () => {
		const scene = new THREE.Scene();
		const actor = new BeamActor();
		scene.add(actor.group);

		actor.start(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
		expect(scene.children).toContain(actor.group);
		expect(actor.group.children.length).toBeGreaterThan(0);

		actor.dispose();

		expect(scene.children).not.toContain(actor.group);
		expect(actor.group.children).toHaveLength(0);
	});
});
