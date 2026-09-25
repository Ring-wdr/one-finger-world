import * as THREE from 'three';
import type { AnimName, LoopAnim, ShotAnim } from './types';

const FADE = 0.15;

/**
 * One placed copy of an asset. `object` is a wrapper the renderer may freely move, rotate and
 * scale; the normalisation transform lives on its child.
 */
export class ModelInstance {
	private readonly mixer: THREE.AnimationMixer | null;
	private readonly actions = new Map<AnimName, THREE.AnimationAction>();
	private readonly baseEmissive: THREE.Color[];
	private loop: LoopAnim | null = null;
	private shot: THREE.AnimationAction | null = null;
	private dead = false;

	constructor(
		readonly object: THREE.Object3D,
		readonly isFallback: boolean,
		private readonly glow: THREE.MeshStandardMaterial[],
		private readonly owned: THREE.Material[],
		clips: ReadonlyMap<AnimName, THREE.AnimationClip> = new Map()
	) {
		this.baseEmissive = glow.map((m) => m.emissive.clone());
		this.mixer = clips.size > 0 ? new THREE.AnimationMixer(object) : null;
		if (!this.mixer) return;
		for (const [name, clip] of clips) this.actions.set(name, this.mixer.clipAction(clip));
		this.mixer.addEventListener('finished', (e) => {
			if (e.action !== this.shot || this.dead) return;
			this.shot = null;
			const back = this.loop && this.actions.get(this.loop);
			back?.reset().fadeIn(FADE).play();
			e.action.fadeOut(FADE);
		});
	}

	get animations(): AnimName[] {
		return [...this.actions.keys()];
	}

	setLoop(name: LoopAnim) {
		if (this.dead || this.loop === name) return;
		const prev = this.loop && this.actions.get(this.loop);
		this.loop = name;
		const next = this.actions.get(name);
		if (!next || this.shot) return;
		next.reset().fadeIn(prev ? FADE : 0).play();
		prev?.fadeOut(FADE);
	}

	/** No-op when the model has no such clip. */
	trigger(name: ShotAnim) {
		const action = this.actions.get(name);
		if (!action || this.dead) return;
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		const from = this.shot ?? (this.loop && this.actions.get(this.loop));
		if (from && from !== action) from.fadeOut(FADE);
		action.reset().fadeIn(FADE / 2).play();
		this.shot = action;
	}

	/**
	 * Plays the death clip and freezes on its last frame; later `setLoop`/`trigger` calls are
	 * ignored. Returns the clip length, or null when the model has none (the caller removes it).
	 */
	die(): number | null {
		const action = this.actions.get('death');
		if (!action) return null;
		this.dead = true;
		for (const a of this.actions.values()) if (a !== action) a.fadeOut(FADE);
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		action.reset().fadeIn(FADE / 2).play();
		this.shot = action;
		return action.getClip().duration;
	}

	/** Adds to each material's own emissive, so authored glow (eyes, runes) survives. */
	setGlow(c: THREE.Color) {
		for (let i = 0; i < this.glow.length; i++) this.glow[i].emissive.copy(this.baseEmissive[i]).add(c);
	}

	update(dt: number) {
		this.mixer?.update(dt);
	}

	dispose() {
		this.object.removeFromParent();
		this.mixer?.stopAllAction();
		for (const m of this.owned) m.dispose();
	}
}
