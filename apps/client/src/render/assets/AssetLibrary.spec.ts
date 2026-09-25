import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AssetLibrary, type GltfLike, type LoadFn } from './AssetLibrary';
import type { AssetManifest } from './types';

/** A 1×4×1 box whose base sits at y = 2 and is offset in x — so grounding/centring is visible. */
function fakeGltf(clipNames: string[] = []): GltfLike {
	const scene = new THREE.Group();
	const cloth = new THREE.MeshStandardMaterial({ name: 'Cloth', color: 0xffffff });
	const skin = new THREE.MeshStandardMaterial({ name: 'Skin', color: 0x886655, emissive: 0x110000 });
	const body = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1).translate(3, 4, 0), cloth);
	const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(3, 5.5, 0), skin);
	scene.add(body, head);
	const animations = clipNames.map((n) => new THREE.AnimationClip(n, 1, []));
	return { scene, animations };
}

const loader = (gltf: () => GltfLike): LoadFn => vi.fn(async () => gltf());

describe('AssetLibrary', () => {
	it('uses primitives when the manifest has no model', async () => {
		const lib = new AssetLibrary({}, loader(fakeGltf));
		await lib.preload();
		expect(lib.tag('fighter')).toBe('fighter:primitive');
		expect(lib.instantiate('fighter', { color: 0xff0000 }).isFallback).toBe(true);
	});

	it('keeps the primitive when a model fails to load', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const lib = new AssetLibrary({ fighter: { url: 'missing.glb' } }, async () => {
			throw new Error('404');
		});
		await expect(lib.preload()).resolves.toBeUndefined();
		expect(lib.tag('fighter')).toBe('fighter:primitive');
		expect(lib.instantiate('fighter').isFallback).toBe(true);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('reports progress per file (shared files once, failures included)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const seen: [number, number][] = [];
		const lib = new AssetLibrary(
			{ fighter: { url: 'a.glb' }, monster1: { url: 'a.glb' }, rock: { url: 'bad.glb' } },
			async (url) => {
				if (url === 'bad.glb') throw new Error('404');
				return fakeGltf();
			}
		);
		await lib.preload((done, total) => seen.push([done, total]));
		expect(seen[0]).toEqual([0, 2]);
		expect(seen.at(-1)).toEqual([2, 2]);
		expect(seen).toHaveLength(3);
		warn.mockRestore();
	});

	it('grounds, centres and scales a loaded model to the requested height', async () => {
		const lib = new AssetLibrary({ fighter: { url: 'f.glb', height: 2 } }, loader(fakeGltf));
		await lib.preload();
		expect(lib.tag('fighter')).toBe('fighter');
		const inst = lib.instantiate('fighter');
		expect(inst.isFallback).toBe(false);
		inst.object.updateMatrixWorld(true);
		const box = new THREE.Box3().setFromObject(inst.object);
		expect(box.min.y).toBeCloseTo(0);
		expect(box.max.y).toBeCloseTo(2);
		expect((box.min.x + box.max.x) / 2).toBeCloseTo(0);
	});

	it('tints only the named materials, per instance, leaving the template untouched', async () => {
		const gltf = fakeGltf();
		const lib = new AssetLibrary({ fighter: { url: 'f.glb', tintMaterials: ['Cloth'] } }, loader(() => gltf));
		await lib.preload();
		const mats = (o: THREE.Object3D) => {
			const out: THREE.MeshStandardMaterial[] = [];
			o.traverse((c) => c instanceof THREE.Mesh && out.push(c.material));
			return out;
		};
		const [redCloth, redSkin] = mats(lib.instantiate('fighter', { color: 0xff0000 }).object);
		const [blueCloth] = mats(lib.instantiate('fighter', { color: 0x0000ff }).object);
		expect(redCloth.color.getHex()).toBe(0xff0000);
		expect(blueCloth.color.getHex()).toBe(0x0000ff);
		expect(redSkin.color.getHex()).toBe(0x886655);
		expect(mats(gltf.scene)[0].color.getHex()).toBe(0xffffff);
	});

	it('adds glow on top of authored emissive', async () => {
		const lib = new AssetLibrary({ fighter: { url: 'f.glb' } }, loader(fakeGltf));
		await lib.preload();
		const inst = lib.instantiate('fighter', { glow: true });
		inst.setGlow(new THREE.Color(0, 0, 0.5));
		const skin: THREE.MeshStandardMaterial[] = [];
		inst.object.traverse((c) => c instanceof THREE.Mesh && c.material.name === 'Skin' && skin.push(c.material));
		const base = new THREE.Color(0x110000);
		expect(skin[0].emissive.r).toBeCloseTo(base.r);
		expect(skin[0].emissive.b).toBeCloseTo(0.5);
	});

	it('maps clips by explicit name first, then by guessing', async () => {
		const manifest: AssetManifest = { monster1: { url: 'm.glb', clips: { attack: 'Bite' } } };
		const lib = new AssetLibrary(manifest, loader(() => fakeGltf(['Idle', 'Walking_A', 'Bite', 'Hit_A', 'Death'])));
		await lib.preload();
		expect(lib.instantiate('monster1').animations.sort()).toEqual(['attack', 'death', 'hit', 'idle', 'move']);
	});

	it('plays death once, then ignores later animation calls', async () => {
		const clip = (name: string, duration: number) =>
			new THREE.AnimationClip(name, duration, [new THREE.NumberKeyframeTrack('.position[x]', [0, duration], [0, 1])]);
		const lib = new AssetLibrary({ monster1: { url: 'm.glb' } }, async () => ({
			...fakeGltf(),
			animations: [clip('Idle', 1), clip('Attack', 0.5), clip('Death', 1.5)]
		}));
		await lib.preload();
		const inst = lib.instantiate('monster1');
		inst.setLoop('idle');
		expect(inst.die()).toBeCloseTo(1.5);
		inst.trigger('attack');
		inst.setLoop('move');
		inst.update(5);
		// Clamped on the death clip's last frame: the track ends at x = 1.
		expect(inst.object.position.x).toBeCloseTo(1);
	});

	it('reports no death clip for primitives', () => {
		expect(new AssetLibrary({}).instantiate('monster1').die()).toBeNull();
	});

	it('picks a variant per instance and falls back to the default for unknown ones', async () => {
		const load = vi.fn(async (url: string) => {
			const g = fakeGltf();
			g.scene.name = url;
			return g;
		});
		const manifest: AssetManifest = {
			fighter: { default: 'unarmed', variants: { unarmed: { url: 'a.glb' }, greatsword: { url: 'b.glb' } } }
		};
		const lib = new AssetLibrary(manifest, load);
		expect(lib.tag('fighter', 'greatsword')).toBe('fighter:primitive');
		await lib.preload();
		expect(load).toHaveBeenCalledTimes(2);
		expect(lib.tag('fighter', 'greatsword')).toBe('fighter:greatsword');
		expect(lib.tag('fighter', 'fire_staff')).toBe('fighter:unarmed');
		expect(lib.tag('fighter')).toBe('fighter:unarmed');
		const from = (o: THREE.Object3D) => ['a.glb', 'b.glb'].find((n) => o.getObjectByName(n));
		expect(from(lib.instantiate('fighter', { variant: 'greatsword' }).object)).toBe('b.glb');
		expect(from(lib.instantiate('fighter', { variant: 'fire_staff' }).object)).toBe('a.glb');
	});

	it('keeps the authored pivot with anchor: origin', async () => {
		const lib = new AssetLibrary({ fighter: { url: 'f.glb', scale: 0.5, anchor: 'origin' } }, loader(fakeGltf));
		await lib.preload();
		const inst = lib.instantiate('fighter');
		inst.object.updateMatrixWorld(true);
		const box = new THREE.Box3().setFromObject(inst.object);
		expect(box.min.y).toBeCloseTo(1); // base at y = 2, halved
		expect(box.min.x).toBeCloseTo(1.25);
	});

	it('loads a shared file once and picks named nodes as per-variant instanced props', async () => {
		const bundle = (): GltfLike => {
			const scene = new THREE.Group();
			const mat = new THREE.MeshStandardMaterial();
			const small = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
			small.name = 'rock_a';
			// Scaled on the node, as meshopt quantization does: normalising must keep it.
			const tall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
			tall.scale.set(1, 3, 1);
			tall.name = 'rock_b';
			scene.add(small, tall);
			return { scene, animations: [] };
		};
		const load = vi.fn(async () => bundle());
		const spec = (node: string) => ({ url: 'props.glb', node });
		const lib = new AssetLibrary({ rock: { default: 'a', variants: { a: spec('rock_a'), b: { ...spec('rock_b'), scale: 2 } } } }, load);
		expect(lib.variants('rock')).toEqual(['a', 'b']);
		expect(lib.variants('tree')).toEqual([]);
		await lib.preload();
		expect(load).toHaveBeenCalledTimes(1);
		const height = (variant: string) => {
			const box = new THREE.Box3();
			for (const p of lib.instancedParts('rock', variant)) {
				p.geometry.computeBoundingBox();
				box.union(p.geometry.boundingBox!);
			}
			return box.max.y - box.min.y;
		};
		expect(height('a')).toBeCloseTo(1);
		expect(height('b')).toBeCloseTo(6);
	});

	it('bakes quantized prop geometry without clamping it', async () => {
		// Like meshopt output: int16 normalized positions in [-1, 1], dequantized by the node's scale.
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(new Int16Array([0, -32767, 0, 0, 32767, 0, 32767, 0, 0]), 3, true));
		const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
		mesh.name = 'tree_a';
		mesh.scale.setScalar(2);
		mesh.position.y = 2; // spans y 0..4
		const scene = new THREE.Group().add(mesh);
		const lib = new AssetLibrary({ tree: { url: 't.glb', node: 'tree_a', anchor: 'origin' } }, async () => ({ scene, animations: [] }));
		await lib.preload();
		const [part] = lib.instancedParts('tree');
		part.geometry.computeBoundingBox();
		expect(part.geometry.boundingBox!.min.y).toBeCloseTo(0);
		expect(part.geometry.boundingBox!.max.y).toBeCloseTo(4);
	});

	it('bakes node transforms into instanced prop geometry', async () => {
		const lib = new AssetLibrary({ rock: { url: 'r.glb', height: 1 } }, loader(fakeGltf));
		expect(lib.instancedParts('rock')).toHaveLength(1); // primitive until loaded
		await lib.preload();
		const parts = lib.instancedParts('rock');
		expect(parts).toHaveLength(2);
		const box = new THREE.Box3();
		for (const p of parts) {
			p.geometry.computeBoundingBox();
			box.union(p.geometry.boundingBox!);
		}
		expect(box.min.y).toBeCloseTo(0);
		expect(box.max.y).toBeCloseTo(1);
		expect(lib.instancedParts('rock')).toBe(parts);
	});
});
