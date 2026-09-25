import type * as THREE from 'three';

export const ASSET_KEYS = ['fighter', 'monster1', 'monster2', 'monster3', 'arrow', 'fireball', 'pickup', 'rock', 'tree', 'deadTree'] as const;
export type AssetKey = (typeof ASSET_KEYS)[number];

/** Looping states. */
export type LoopAnim = 'idle' | 'move';
/** One-shots that play over the loop, then fade back. */
export type ShotAnim = 'attack' | 'hit' | 'dash';
/** Final: holds its last frame and ignores everything after. */
export type AnimName = LoopAnim | ShotAnim | 'death';

/**
 * How to fit a glTF into the game. Game space: ground at y = 0, forward = −Z, 1 unit ≈ 1 m
 * (a fighter is ~2 units tall).
 */
export interface ModelSpec {
	/** Served from `apps/client/public`, e.g. `models/fighter.glb`. Shared URLs load once. */
	url: string;
	/** Use only this named node of the file — for packs of many props in one .glb. */
	node?: string;
	/** Uniformly scale so the bounding-box height equals this. Applied after `scale`. */
	height?: number;
	scale?: number;
	/** glTF faces +Z; most files need `Math.PI` to face our −Z forward. */
	rotationY?: number;
	/**
	 * `bounds` (default): ground the lowest point at y = 0 and centre x/z — for props of unknown origin.
	 * `origin`: trust the authored pivot — for characters whose weapons make the bounds lopsided.
	 */
	anchor?: 'bounds' | 'origin';
	/** Lift after anchoring. */
	yOffset?: number;
	/** Material names recoloured per instance (team colour, rarity). Others keep their look. */
	tintMaterials?: string[];
	/** Clip name per state. Unlisted states are guessed from clip names (Idle, Run, Attack…). */
	clips?: Partial<Record<AnimName, string>>;
}

/** Several looks for one key, picked per instance (e.g. a fighter's model by weapon). */
export interface VariantSpec {
	variants: Record<string, ModelSpec>;
	/** Used when an instance asks for no variant or one not listed. */
	default: string;
}

export type AssetManifest = Partial<Record<AssetKey, ModelSpec | VariantSpec>>;

export interface InstanceOptions {
	/** Variant name for keys with `variants`; ignored otherwise. */
	variant?: string;
	color?: THREE.ColorRepresentation;
	/** Give the instance its own materials so `setGlow` affects only it. */
	glow?: boolean;
}

export interface FallbackBuild {
	object: THREE.Object3D;
	/** Materials whose emissive `setGlow` drives. */
	glow: THREE.MeshStandardMaterial[];
	/** Materials created for this instance only; disposed with it. */
	owned: THREE.Material[];
}

export interface InstancedPart {
	geometry: THREE.BufferGeometry;
	material: THREE.Material | THREE.Material[];
}
