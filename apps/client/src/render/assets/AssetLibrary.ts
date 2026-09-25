import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { FALLBACKS } from './fallbacks';
import { MODEL_MANIFEST } from './manifest';
import { ModelInstance } from './ModelInstance';
import type { AnimName, AssetKey, AssetManifest, InstancedPart, InstanceOptions, ModelSpec } from './types';

export interface GltfLike {
	scene: THREE.Object3D;
	animations: THREE.AnimationClip[];
}
export type LoadFn = (url: string) => Promise<GltfLike>;

interface Loaded {
	spec: ModelSpec;
	/** Normalised: grounded, centred, facing −Z, at game scale. */
	template: THREE.Object3D;
	clips: Map<AnimName, THREE.AnimationClip>;
}

const CLIP_GUESS: Record<AnimName, RegExp> = {
	idle: /idle/i,
	move: /run|walk|move/i,
	attack: /attack|slash|chop|stab|punch|bite|shoot/i,
	hit: /hit|hurt|damage/i,
	dash: /dash|dodge|roll/i,
	death: /death|die/i
};

/** GLTFLoader is imported lazily so builds without models never ship it. */
const loadGltf: LoadFn = async (url) => {
	const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
		import('three/addons/loaders/GLTFLoader.js'),
		import('three/addons/libs/meshopt_decoder.module.js')
	]);
	const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
	return loader.loadAsync(new URL(url, document.baseURI).href);
};

export function normalize(scene: THREE.Object3D, spec: ModelSpec): THREE.Object3D {
	scene.rotation.set(0, spec.rotationY ?? 0, 0);
	scene.position.set(0, 0, 0);
	scene.scale.setScalar(spec.scale ?? 1);
	scene.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(scene);
	if (spec.height !== undefined && !box.isEmpty()) {
		const k = spec.height / Math.max(1e-6, box.max.y - box.min.y);
		scene.scale.multiplyScalar(k);
		box.min.multiplyScalar(k);
		box.max.multiplyScalar(k);
	}
	const yOffset = spec.yOffset ?? 0;
	if (spec.anchor === 'origin' || box.isEmpty()) {
		scene.position.set(0, yOffset, 0);
	} else {
		const c = box.getCenter(new THREE.Vector3());
		scene.position.set(-c.x, -box.min.y + yOffset, -c.z);
	}
	return new THREE.Group().add(scene);
}

function pickClips(clips: THREE.AnimationClip[], wanted: ModelSpec['clips'] = {}) {
	const out = new Map<AnimName, THREE.AnimationClip>();
	for (const name of Object.keys(CLIP_GUESS) as AnimName[]) {
		const want = wanted[name];
		const clip = want ? clips.find((c) => c.name === want) : clips.find((c) => CLIP_GUESS[name].test(c.name));
		if (want && !clip) console.warn(`[assets] clip "${want}" not found`);
		if (clip) out.set(name, clip);
	}
	return out;
}

const materialsOf = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

/**
 * Resolves asset keys to renderable instances: the manifest's glTF once loaded, the prototype
 * primitive until then (or forever, if it has no model or fails to load).
 */
export class AssetLibrary {
	/** Keyed by model id: the asset key, or `key:variant`. */
	private readonly loaded = new Map<string, Loaded>();
	private readonly parts = new Map<AssetKey, { tag: string; parts: InstancedPart[] }>();
	private disposed = false;

	constructor(
		private readonly manifest: AssetManifest = MODEL_MANIFEST,
		private readonly load: LoadFn = loadGltf
	) {}

	/** Loads every manifest model. Never rejects: failures are logged and keep the fallback. */
	async preload(): Promise<void> {
		const models: [string, ModelSpec][] = [];
		for (const [key, entry] of Object.entries(this.manifest)) {
			if (!entry) continue;
			if ('variants' in entry) for (const [v, spec] of Object.entries(entry.variants)) models.push([`${key}:${v}`, spec]);
			else models.push([key, entry]);
		}
		await Promise.all(
			models.map(async ([id, spec]) => {
				try {
					const gltf = await this.load(spec.url);
					if (this.disposed) return;
					this.loaded.set(id, { spec, template: normalize(gltf.scene, spec), clips: pickClips(gltf.animations, spec.clips) });
				} catch (err) {
					console.warn(`[assets] ${id}: failed to load ${spec.url}, keeping primitive`, err);
				}
			})
		);
	}

	private modelId(key: AssetKey, variant?: string): string {
		const entry = this.manifest[key];
		if (!entry || !('variants' in entry)) return key;
		return `${key}:${variant !== undefined && variant in entry.variants ? variant : entry.default}`;
	}

	/**
	 * Identifies what `instantiate(key, { variant })` would build right now. Views keep it and
	 * rebuild when it changes: a model finished loading, or the variant (weapon) changed.
	 */
	tag(key: AssetKey, variant?: string): string {
		const id = this.modelId(key, variant);
		return this.loaded.has(id) ? id : `${key}:primitive`;
	}

	instantiate(key: AssetKey, opts: InstanceOptions = {}): ModelInstance {
		const loaded = this.loaded.get(this.modelId(key, opts.variant));
		if (!loaded) {
			const fb = FALLBACKS[key](opts);
			return new ModelInstance(fb.object, true, fb.glow, fb.owned);
		}
		const object = cloneSkinned(loaded.template);
		const glow: THREE.MeshStandardMaterial[] = [];
		const owned: THREE.Material[] = [];
		// Shared materials are fine unless this instance recolours or glows on its own.
		if (opts.color !== undefined || opts.glow) {
			const tint = new Set(loaded.spec.tintMaterials ?? []);
			object.traverse((o) => {
				if (!(o instanceof THREE.Mesh)) return;
				const mats = materialsOf(o).map((m) => {
					const own = m.clone();
					owned.push(own);
					if (own instanceof THREE.MeshStandardMaterial) {
						if (opts.color !== undefined && tint.has(m.name)) own.color.set(opts.color);
						if (opts.glow) glow.push(own);
					}
					return own;
				});
				o.material = Array.isArray(o.material) ? mats : mats[0];
			});
		}
		return new ModelInstance(object, false, glow, owned, loaded.clips);
	}

	/** Geometry with node transforms baked in, one entry per mesh — for InstancedMesh props. */
	instancedParts(key: AssetKey): InstancedPart[] {
		const tag = this.tag(key);
		const cached = this.parts.get(key);
		if (cached?.tag === tag) return cached.parts;
		const template = this.loaded.get(this.modelId(key))?.template ?? FALLBACKS[key]({}).object;
		template.updateMatrixWorld(true);
		const parts: InstancedPart[] = [];
		template.traverse((o) => {
			if (o instanceof THREE.Mesh) parts.push({ geometry: o.geometry.clone().applyMatrix4(o.matrixWorld), material: o.material });
		});
		cached?.parts.forEach((p) => p.geometry.dispose());
		this.parts.set(key, { tag, parts });
		return parts;
	}

	dispose() {
		this.disposed = true;
		for (const { parts } of this.parts.values()) parts.forEach((p) => p.geometry.dispose());
		for (const { template } of this.loaded.values()) {
			template.traverse((o) => {
				if (!(o instanceof THREE.Mesh)) return;
				o.geometry.dispose();
				for (const m of materialsOf(o)) {
					for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
					m.dispose();
				}
			});
		}
		this.parts.clear();
		this.loaded.clear();
	}
}
