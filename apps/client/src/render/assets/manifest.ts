import type { AssetManifest, ModelSpec } from './types';

/**
 * KayKit characters: pivot at the feet, facing +Z, ~2.4 units tall with hat and weapon.
 * Scale 0.8 suits a fighter (radius 0.7); monsters scale with their radius.
 */
const character = (name: string, extra: Partial<ModelSpec> = {}): ModelSpec => ({
	url: `models/characters/${name}.glb`,
	scale: 0.8,
	rotationY: Math.PI,
	anchor: 'origin',
	...extra
});

/**
 * Real models replacing the prototype primitives. Any key left out keeps its primitive
 * (see fallbacks.ts), and a file that fails to load falls back the same way.
 *
 * Adding a model:
 *  1. Drop the .glb into `apps/client/public/models/`.
 *  2. Compress it (meshopt is decoded at load time):
 *       bunx @gltf-transform/cli optimize in.glb apps/client/public/models/out.glb --compress meshopt --texture-compress webp
 *  3. Add an entry below, e.g.
 *       fighter: { url: 'models/knight.glb', height: 2, rotationY: Math.PI, tintMaterials: ['Cloth'] },
 *       monster1: { url: 'models/slime.glb', height: 1.2, clips: { attack: 'Bite' } },
 *       rock: { url: 'models/rock.glb', height: 0.9 },
 *
 * Instanced props (rock, tree) should be a single static mesh; animations are ignored there.
 */
export const MODEL_MANIFEST: AssetManifest = {
	// KayKit Adventurers (CC0, Kay Lousberg), built by `bun run assets:characters`, which keeps
	// one loadout and the Idle/Run/Attack/Hit/Dash clips per class. Picked by equipped weapon id.
	fighter: {
		default: 'unarmed',
		variants: {
			unarmed: character('barbarian'),
			greatsword: character('knight'),
			twin_daggers: character('rogue'),
			hunting_bow: character('rogue_hooded'),
			fire_staff: character('mage')
		}
	},
	// KayKit Skeletons (CC0), built by the same script. Training dummies (any tier) are tinted
	// straw through the shared `skeleton` material; real monsters keep their texture.
	monster1: character('skeleton_minion', { scale: 0.7, tintMaterials: ['skeleton'] }),
	monster2: character('skeleton_mage', { scale: 0.95, tintMaterials: ['skeleton'] }),
	monster3: character('skeleton_warrior', { scale: 1.35, tintMaterials: ['skeleton'] })
};
