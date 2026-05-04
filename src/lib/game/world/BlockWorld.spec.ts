import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BlockWorld } from './BlockWorld';

describe('BlockWorld', () => {
	it('clamps to exact world bounds by default', () => {
		const world = new BlockWorld();
		const position = new THREE.Vector3(-20, 2, 20);

		const result = world.clampPosition(position);

		expect(result).toBe(position);
		expect(position.x).toBe(world.bounds.minX);
		expect(position.y).toBe(2);
		expect(position.z).toBe(world.bounds.maxZ);

		world.dispose();
	});

	it('applies a clamp margin only when explicitly provided', () => {
		const world = new BlockWorld();
		const position = new THREE.Vector3(20, 0, -20);

		world.clampPosition(position, 0.35);

		expect(position.x).toBe(world.bounds.maxX - 0.35);
		expect(position.z).toBe(world.bounds.minZ + 0.35);

		world.dispose();
	});
});
