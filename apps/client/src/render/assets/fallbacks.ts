import * as THREE from 'three';
import type { AssetKey, FallbackBuild, InstanceOptions } from './types';

/** Prototype primitives, used until (or instead of) a real model. Geometry is shared. */

const lazy = <T>(make: () => T) => {
	let v: T | undefined;
	return () => (v ??= make());
};

const geo = {
	capsule: lazy(() => new THREE.CapsuleGeometry(0.55, 0.8, 4, 12)),
	nose: lazy(() => new THREE.ConeGeometry(0.22, 0.5, 10).rotateX(-Math.PI / 2)),
	monster1: lazy(() => new THREE.IcosahedronGeometry(0.6, 0)),
	monster2: lazy(() => new THREE.DodecahedronGeometry(0.85, 0)),
	monster3: lazy(() => new THREE.OctahedronGeometry(1.2, 0)),
	arrow: lazy(() => new THREE.BoxGeometry(0.12, 0.12, 0.9)),
	fireball: lazy(() => new THREE.SphereGeometry(0.45, 12, 10)),
	pickup: lazy(() => new THREE.BoxGeometry(0.6, 0.6, 0.6)),
	// Squashed and half-buried, as the old per-instance transform did.
	rock: lazy(() => new THREE.DodecahedronGeometry(0.8, 0).scale(1, 0.7, 1).translate(0, 0.2, 0)),
	tree: lazy(() => new THREE.ConeGeometry(0.9, 2.6, 7).translate(0, 1.3, 0)),
	deadTree: lazy(() => new THREE.CylinderGeometry(0.06, 0.22, 2.4, 5).translate(0, 1.2, 0))
};

const mat = {
	nose: lazy(() => new THREE.MeshStandardMaterial({ color: 0x222831 })),
	arrow: lazy(() => new THREE.MeshBasicMaterial({ color: 0xe8f1ff })),
	fireball: lazy(() => new THREE.MeshBasicMaterial({ color: 0xff8a3d })),
	rock: lazy(() => new THREE.MeshStandardMaterial({ color: 0x6d7580, roughness: 1, flatShading: true })),
	tree: lazy(() => new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 1, flatShading: true })),
	deadTree: lazy(() => new THREE.MeshStandardMaterial({ color: 0x4a3b30, roughness: 1, flatShading: true }))
};

const MONSTER_COLOR = { monster1: 0x7bc96f, monster2: 0x9b6bd6, monster3: 0xd9534f } as const;

const wrap = (...children: THREE.Object3D[]) => new THREE.Group().add(...children);
const shared = (mesh: THREE.Mesh): FallbackBuild => ({ object: wrap(mesh), glow: [], owned: [] });

const monster = (key: keyof typeof MONSTER_COLOR) => (o: InstanceOptions) => {
	const m = new THREE.MeshStandardMaterial({ color: o.color ?? MONSTER_COLOR[key], roughness: 0.7, flatShading: true });
	// Centred on the origin: the renderer floats and spins it.
	return { object: wrap(new THREE.Mesh(geo[key](), m)), glow: [m], owned: [m] };
};

export const FALLBACKS: Record<AssetKey, (o: InstanceOptions) => FallbackBuild> = {
	fighter: (o) => {
		const m = new THREE.MeshStandardMaterial({ color: o.color ?? 0xcccccc, roughness: 0.6 });
		const body = new THREE.Mesh(geo.capsule(), m);
		body.position.y = 0.95;
		const nose = new THREE.Mesh(geo.nose(), mat.nose());
		nose.position.set(0, 1.2, -0.6);
		return { object: wrap(body, nose), glow: [m], owned: [m] };
	},
	monster1: monster('monster1'),
	monster2: monster('monster2'),
	monster3: monster('monster3'),
	arrow: () => shared(new THREE.Mesh(geo.arrow(), mat.arrow())),
	fireball: () => shared(new THREE.Mesh(geo.fireball(), mat.fireball())),
	pickup: (o) => {
		const color = o.color ?? 0xcfd8dc;
		const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 });
		const box = new THREE.Mesh(geo.pickup(), m);
		box.position.y = 0.8;
		return { object: wrap(box), glow: [], owned: [m] };
	},
	rock: () => shared(new THREE.Mesh(geo.rock(), mat.rock())),
	tree: () => shared(new THREE.Mesh(geo.tree(), mat.tree())),
	deadTree: () => shared(new THREE.Mesh(geo.deadTree(), mat.deadTree()))
};
