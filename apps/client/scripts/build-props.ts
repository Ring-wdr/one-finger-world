/**
 * Bundles static props into .glb files, one named node per prop, from KayKit packs
 * (CC0, Kay Lousberg):
 *
 *   bun run assets:props <dir> [<dir> …]
 *
 * Each dir is a folder holding source .gltf / .gltf.glb files (with their .bin and texture).
 * A bundle whose sources aren't all found is skipped.
 *   nature.glb
 *     Medieval Hexagon: https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0
 *                       (addons/kaykit_medieval_hexagon_pack/Assets/gltf/decoration/nature)
 *     Halloween Bits:   https://github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0
 *                       (addons/kaykit_halloween_bits/Assets/gltf)
 *   items.glb
 *     Adventurers:      https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
 *                       (addons/kaykit_character_pack_adventures/Assets/gltf)
 *     Dungeon:          https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0
 *                       (addons/kaykit_dungeon_remastered/Assets/gltf)
 *
 * One file keeps each pack's texture atlas once and costs one request; the manifest picks a
 * prop by node name.
 */
import { Document, NodeIO, type Node, type Scene, type vec4 } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Prop {
	file: string;
	/** Baked onto the node, e.g. to lay an upright model along the game's −Z forward. */
	rotation?: vec4;
}

/** +90° about X: a model pointing down −Y (the arrow's tip) ends up pointing along −Z. */
const LAY_FORWARD: vec4 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** Bundle file → output node name → source. */
const BUNDLES: Record<string, Record<string, Prop>> = {
	'nature.glb': {
		rock_a: { file: 'rock_single_A.gltf' },
		rock_b: { file: 'rock_single_B.gltf' },
		rock_c: { file: 'rock_single_C.gltf' },
		rock_d: { file: 'rock_single_D.gltf' },
		rock_e: { file: 'rock_single_E.gltf' },
		tree_a: { file: 'tree_single_A.gltf' },
		tree_b: { file: 'tree_single_B.gltf' },
		dead_tree_small: { file: 'tree_dead_small.gltf' },
		dead_tree_medium: { file: 'tree_dead_medium.gltf' },
		dead_tree_large: { file: 'tree_dead_large.gltf' }
	},
	'items.glb': {
		arrow: { file: 'arrow.gltf', rotation: LAY_FORWARD },
		book_closed: { file: 'spellbook_closed.gltf' },
		book_open: { file: 'spellbook_open.gltf' },
		potion: { file: 'bottle_A_labeled_green.gltf.glb' }
	}
};

const srcDirs = process.argv.slice(2);
if (!srcDirs.length) {
	console.error('usage: bun run assets:props <dir with the source .gltf files> [<dir> …]');
	process.exit(1);
}
const find = (file: string) => srcDirs.map((d) => join(d, file)).find((f) => existsSync(f));
const outDir = join(import.meta.dirname, '..', 'public', 'models', 'props');
mkdirSync(outDir, { recursive: true });

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

for (const [bundle, props] of Object.entries(BUNDLES)) {
	const missing = Object.values(props).filter((p) => !find(p.file));
	if (missing.length) {
		console.log(`${bundle.padEnd(11)} skipped (not found: ${missing.map((p) => p.file).join(', ')})`);
		continue;
	}
	const doc = new Document();
	const scene = doc.createScene('props');
	doc.getRoot().setDefaultScene(scene);
	for (const [name, prop] of Object.entries(props)) {
		const src = await io.read(find(prop.file)!);
		const merged = mergeDocuments(doc, src);
		for (const s of src.getRoot().listScenes()) {
			const copy = merged.get(s) as Scene;
			const roots = copy.listChildren() as Node[];
			if (roots.length !== 1) throw new Error(`${prop.file}: expected one root node, got ${roots.length}`);
			copy.removeChild(roots[0]);
			if (prop.rotation) roots[0].setRotation(prop.rotation);
			scene.addChild(roots[0].setName(name));
			copy.dispose();
		}
	}

	// Identical texture atlases from the same pack collapse into one.
	await doc.transform(unpartition(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
	const out = join(outDir, bundle);
	await io.write(out, doc);
	const root = doc.getRoot();
	console.log(`${bundle.padEnd(11)} ${(statSync(out).size / 1024).toFixed(0)} KB  (${root.listNodes().length} props, ${root.listTextures().length} textures)`);
}
