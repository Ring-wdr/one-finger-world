/**
 * Builds the static prop models (rocks, pines, dead trees, loot, arrow) procedurally in Blender
 * from the scripts in `apps/client/blender`, then compresses them into one .glb per bundle:
 *
 *   bun run assets:props [--only nature|items] [--preview <dir>] [--blend <file.blend>]
 *
 * Blender 4.2+ is found on the usual install paths, or set BLENDER to its executable.
 *   --only     rebuilds one bundle, leaving the other as it is
 *   --preview  renders contact sheets of every prop at the game's camera angle
 *   --blend    saves the generated scene, to open and tweak in Blender
 *
 * Each bundle holds one named node per prop (the manifest picks by node name), shares one
 * vertex-coloured material per kind of surface, and needs no textures.
 */
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, weld } from '@gltf-transform/functions';
import { PROP_VARIANTS } from '@ofa/sim';
import { MeshoptEncoder } from 'meshoptimizer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUNDLES = ['nature.glb', 'items.glb'];
/** A rock's collision circle is sized from its footprint; the model must agree with the sim. */
const FOOTPRINT_TOLERANCE = 0.01;

function findBlender(): string {
	if (process.env.BLENDER) return process.env.BLENDER;
	const candidates: string[] = [];
	if (process.platform === 'win32') {
		const root = 'C:\\Program Files\\Blender Foundation';
		if (existsSync(root)) {
			// Newest first: "Blender 5.2" sorts after "Blender 4.2" numerically.
			const dirs = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
			candidates.push(...dirs.map((d) => join(root, d, 'blender.exe')));
		}
	} else if (process.platform === 'darwin') {
		candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
	}
	const found = candidates.find((c) => existsSync(c));
	return found ?? 'blender';
}

/** Farthest vertex from the node's pivot on the ground plane (glTF x/z), in node space. */
function footprint(doc: Document, name: string): number {
	const node = doc.getRoot().listNodes().find((n) => n.getName() === name);
	if (!node) throw new Error(`no node ${name}`);
	const [sx, , sz] = node.getScale();
	let reach = 0;
	for (const prim of node.getMesh()?.listPrimitives() ?? []) {
		const pos = prim.getAttribute('POSITION')!;
		const v: number[] = [];
		for (let i = 0; i < pos.getCount(); i++) {
			pos.getElement(i, v);
			reach = Math.max(reach, Math.hypot(v[0] * sx, v[2] * sz));
		}
	}
	return reach;
}

/**
 * Blender's exporter sometimes emits the same triangles in a different order run to run. Sorting
 * them (each rotated to start at its lowest index, so winding is kept) makes rebuilds
 * byte-identical; meshopt reorders them for the vertex cache afterwards.
 */
function sortTriangles(doc: Document) {
	for (const prim of doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
		const indices = prim.getIndices();
		const a = indices?.getArray();
		if (!indices || !a) continue;
		const tris: [number, number, number][] = [];
		for (let i = 0; i < a.length; i += 3) {
			const t = [a[i], a[i + 1], a[i + 2]];
			const r = t.indexOf(Math.min(...t));
			tris.push([t[r], t[(r + 1) % 3], t[(r + 2) % 3]]);
		}
		tris.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
		const out = a.slice();
		tris.forEach((t, i) => out.set(t, i * 3));
		indices.setArray(out);
	}
}

const passThrough = process.argv.slice(2);
const blender = findBlender();
const script = join(import.meta.dirname, '..', 'blender', 'build.py');
const raw = mkdtempSync(join(tmpdir(), 'ofa-props-'));
const outDir = join(import.meta.dirname, '..', 'public', 'models', 'props');
mkdirSync(outDir, { recursive: true });

try {
	console.log(`blender: ${blender}`);
	const run = spawnSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', script, '--', '--out', raw, ...passThrough], {
		stdio: ['ignore', 'pipe', 'inherit'],
		encoding: 'utf8'
	});
	if (run.error) throw new Error(`could not run Blender (${run.error.message}); set BLENDER to its executable`);
	// Blender's own chatter is noise; the builder prints one line per prop.
	for (const line of run.stdout.split('\n')) if (line.startsWith('  ')) console.log(line);
	if (run.status !== 0) throw new Error(`Blender exited with ${run.status}`);

	await MeshoptEncoder.ready;
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
	for (const bundle of BUNDLES) {
		// `--only <bundle>` builds a subset.
		if (!existsSync(join(raw, bundle))) continue;
		const doc = await io.read(join(raw, bundle));
		if (bundle === 'nature.glb') {
			for (const { name, footprint: want } of PROP_VARIANTS.rock) {
				const got = footprint(doc, `rock_${name}`);
				if (Math.abs(got - want) > want * FOOTPRINT_TOLERANCE) {
					throw new Error(`rock_${name}: footprint ${got.toFixed(3)} ≠ PROP_VARIANTS ${want.toFixed(3)} (packages/sim/src/obstacles.ts)`);
				}
			}
		}
		sortTriangles(doc);
		await doc.transform(dedup(), weld(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
		const out = join(outDir, bundle);
		await io.write(out, doc);
		const root = doc.getRoot();
		const tris = root
			.listMeshes()
			.flatMap((m) => m.listPrimitives())
			.reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
		console.log(
			`${bundle.padEnd(11)} ${(statSync(out).size / 1024).toFixed(0).padStart(4)} KB  (${root.listNodes().length} props, ${tris} tris, ${root.listMaterials().length} materials)`
		);
	}
} finally {
	rmSync(raw, { recursive: true, force: true });
}
