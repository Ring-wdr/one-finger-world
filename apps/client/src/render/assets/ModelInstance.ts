import * as THREE from 'three';
import type { AnimName, LoopAnim, ShotAnim } from './types';

const FADE = 0.15;
/** Weight of a layered shot over the move loop; the loop stays at 1 so the legs keep running. */
const LAYER = 0.7;
/** Shots that play over the move loop instead of replacing it. A dash is its own locomotion. */
const LAYERED: ReadonlySet<AnimName> = new Set<AnimName>(['attack']);

/**
 * One placed copy of an asset. `object` is a wrapper the renderer may freely move, rotate and
 * scale; the normalisation transform lives on its child.
 *
 * Blend weights are driven here rather than with three's fades: every frame each action eases
 * toward the weight the current state wants, so the loop can change while a shot plays.
 */
export class ModelInstance {
	private readonly mixer: THREE.AnimationMixer | null;
	private readonly actions = new Map<AnimName, THREE.AnimationAction>();
	private readonly weights = new Map<AnimName, number>();
	private readonly baseEmissive: THREE.Color[];
	/** The loop the renderer wants, kept up to date even while a shot hides it. */
	private loop: LoopAnim | null = null;
	private shot: ShotAnim | 'death' | null = null;
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
			if (this.dead || !this.shot || e.action !== this.actions.get(this.shot)) return;
			this.shot = null;
		});
	}

	get animations(): AnimName[] {
		return [...this.actions.keys()];
	}

	/** Blend weight an action is currently played at (0 when absent or stopped). */
	weightOf(name: AnimName): number {
		return this.weights.get(name) ?? 0;
	}

	setLoop(name: LoopAnim) {
		if (this.dead || this.loop === name) return;
		const first = this.loop === null;
		this.loop = name;
		// A flinch yields to walking; the renderer's hit flash still shows the hit.
		if (name === 'move' && this.shot === 'hit') this.shot = null;
		const action = this.actions.get(name);
		if (first && action && !this.shot) {
			action.reset().play().setEffectiveWeight(1);
			this.weights.set(name, 1);
		}
	}

	/** No-op when the model has no such clip, and for a flinch while moving. */
	trigger(name: ShotAnim) {
		const action = this.actions.get(name);
		if (!action || this.dead) return;
		if (name === 'hit' && this.loop === 'move') return;
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		action.reset().play().setEffectiveWeight(this.weightOf(name));
		this.shot = name;
	}

	/**
	 * Plays the death clip and freezes on its last frame; later `setLoop`/`trigger` calls are
	 * ignored. Returns the clip length, or null when the model has none (the caller removes it).
	 */
	die(): number | null {
		const action = this.actions.get('death');
		if (!action) return null;
		this.dead = true;
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		action.reset().play().setEffectiveWeight(this.weightOf('death'));
		this.shot = 'death';
		return action.getClip().duration;
	}

	/** Adds to each material's own emissive, so authored glow (eyes, runes) survives. */
	setGlow(c: THREE.Color) {
		for (let i = 0; i < this.glow.length; i++) this.glow[i].emissive.copy(this.baseEmissive[i]).add(c);
	}

	update(dt: number) {
		if (!this.mixer) return;
		const step = dt / FADE;
		for (const [name, action] of this.actions) {
			const from = this.weightOf(name);
			const to = this.targetWeight(name);
			if (from === to) continue;
			// Shots snap in twice as fast as loops cross-fade.
			const w = from < to ? Math.min(to, from + step * (name === this.shot ? 2 : 1)) : Math.max(to, from - step);
			if (from === 0 && !action.isRunning() && name !== this.shot) action.reset().play();
			action.setEffectiveWeight(w);
			this.weights.set(name, w);
			if (w === 0) action.stop();
		}
		this.mixer.update(dt);
	}

	private targetWeight(name: AnimName): number {
		if (this.dead) return name === 'death' ? 1 : 0;
		const layered = this.shot !== null && this.loop === 'move' && LAYERED.has(this.shot);
		if (name === this.shot) return layered ? LAYER : 1;
		if (name === this.loop) return this.shot === null || layered ? 1 : 0;
		return 0;
	}

	dispose() {
		this.object.removeFromParent();
		this.mixer?.stopAllAction();
		for (const m of this.owned) m.dispose();
	}
}
