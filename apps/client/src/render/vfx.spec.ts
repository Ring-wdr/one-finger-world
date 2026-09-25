import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { glowTexture, Particles } from './vfx';

const alphas = (p: Particles) => Array.from(p.points.geometry.getAttribute('aAlpha').array as Float32Array);

describe('Particles', () => {
	it('fades a particle over its life, then hides it', () => {
		const p = new Particles(4);
		p.emit(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), 1, 0.5, new THREE.Color(1, 1, 1));
		p.update(0.5);
		expect(alphas(p)[0]).toBeCloseTo(0.5);
		const x = p.points.geometry.getAttribute('position').getX(0);
		expect(x).toBeGreaterThan(0);
		p.update(0.6);
		expect(alphas(p)[0]).toBe(0);
	});

	it('recycles the oldest particle once the pool is full', () => {
		const p = new Particles(2);
		const at = (x: number) => new THREE.Vector3(x, 0, 0);
		for (const x of [1, 2, 3]) p.emit(at(x), new THREE.Vector3(), 1, 0.5, new THREE.Color());
		const pos = p.points.geometry.getAttribute('position');
		expect([pos.getX(0), pos.getX(1)]).toEqual([3, 2]);
	});

	it('bursts the requested number of sparks', () => {
		const p = new Particles(64);
		p.burst(new THREE.Vector3(), 10, 3, [new THREE.Color(1, 0.5, 0)]);
		expect(alphas(p).filter((a) => a > 0)).toHaveLength(10);
		p.clear();
		expect(alphas(p).every((a) => a === 0)).toBe(true);
	});
});

describe('glowTexture', () => {
	it('is opaque at the centre and clear at the corners', () => {
		const size = 16;
		const data = glowTexture(size).image.data as Uint8Array;
		const alpha = (x: number, y: number) => data[(y * size + x) * 4 + 3];
		expect(alpha(size / 2, size / 2)).toBeGreaterThan(200);
		expect(alpha(0, 0)).toBe(0);
	});
});
