/**
 * Bundles the map's static props into one .glb, one named node per prop, from KayKit packs
 * (CC0, Kay Lousberg):
 *
 *   bun run assets:props <dir> [<dir> …]
 *
 * Each dir is a folder holding the source .gltf files (with their .bin and texture):
 *   Medieval Hexagon: https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0
 *                     (addons/kaykit_medieval_hexagon_pack/Assets/gltf/decoration/nature)
 *   Halloween Bits:   https://github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0
 *                     (addons/kaykit_halloween_bits/Assets/gltf)
 *
 * One file keeps each pack's texture atlas once and costs one request; the manifest picks a
 * prop by node name.
 */
import { Document, NodeIO, type Node, type Scene } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Output node name → source file. */
const PROPS: Record<string, string> = {
	rock_a: 'rock_single_A.gltf',
	rock_b: 'rock_single_B.gltf',
	rock_c: 'rock_single_C.gltf',
	rock_d: 'rock_single_D.gltf',
	rock_e: 'rock_single_E.gltf',
	tree_a: 'tree_single_A.gltf',
	tree_b: 'tree_single_B.gltf',
	dead_tree_small: 'tree_dead_small.gltf',
	dead_tree_medium: 'tree_dead_medium.gltf',
	dead_tree_large: 'tree_dead_large.gltf'
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

const doc = new Document();
const scene = doc.createScene('props');
doc.getRoot().setDefaultScene(scene);
for (const [name, file] of Object.entries(PROPS)) {
	const src = find(file);
	if (!src) throw new Error(`${file} not found in ${srcDirs.join(', ')}`);
	const prop = await io.read(src);
	const merged = mergeDocuments(doc, prop);
	for (const s of prop.getRoot().listScenes()) {
		const copy = merged.get(s) as Scene;
		const roots = copy.listChildren() as Node[];
		if (roots.length !== 1) throw new Error(`${file}: expected one root node, got ${roots.length}`);
		copy.removeChild(roots[0]);
		scene.addChild(roots[0].setName(name));
		copy.dispose();
	}
}

// Identical texture atlases from the same pack collapse into one.
await doc.transform(unpartition(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
const out = join(outDir, 'nature.glb');
await io.write(out, doc);
const root = doc.getRoot();
console.log(`nature.glb  ${(statSync(out).size / 1024).toFixed(0)} KB  (${root.listNodes().length} props, ${root.listTextures().length} textures)`);
