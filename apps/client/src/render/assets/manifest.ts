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
 * Instanced props (rock, tree, deadTree) should be static meshes; animations are ignored there,
 * and each variant becomes its own InstancedMesh.
 */
/** A node of the bundled props file. Pivots sit at the base; roots dipping below stay buried. */
const prop = (node: string, extra: Partial<ModelSpec> = {}): ModelSpec => ({
	url: 'models/props/nature.glb',
	node,
	anchor: 'origin',
	...extra
});

/** A node of the bundled items file, grounded and lifted to hover like a loot drop. */
const item = (node: string, extra: Partial<ModelSpec> = {}): ModelSpec => ({
	url: 'models/props/items.glb',
	node,
	yOffset: 0.35,
	...extra
});

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
	monster3: character('skeleton_warrior', { scale: 1.35, tintMaterials: ['skeleton'] }),

	// Map props from KayKit Medieval Hexagon and Halloween Bits (CC0), bundled into one file
	// by `bun run assets:props`. Each placement picks one variant.
	rock: {
		default: 'a',
		variants: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((v) => [v, prop(`rock_${v}`, { scale: 5 })]))
	},
	tree: {
		default: 'a',
		variants: { a: prop('tree_a', { scale: 2.2 }), b: prop('tree_b', { scale: 2.2 }) }
	},
	deadTree: {
		default: 'medium',
		variants: Object.fromEntries(['small', 'medium', 'large'].map((v) => [v, prop(`dead_tree_${v}`, { scale: 0.7 })]))
	},

	// Loot and projectiles from KayKit Adventurers and Dungeon Remastered (CC0), bundled by
	// `bun run assets:props`. A pickup shows its item kind (weapons never drop).
	pickup: {
		default: 'stat',
		variants: {
			stat: item('potion', { height: 0.8 }),
			skill: item('book_closed', { height: 0.7 }),
			bridge: item('book_open', { height: 0.7 })
		}
	},
	// Laid along −Z by the build; centred on the flight point.
	arrow: { url: 'models/props/items.glb', node: 'arrow', anchor: 'origin', scale: 1.3 }
};
