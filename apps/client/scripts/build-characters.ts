/**
 * Builds the in-game character models from KayKit character packs (CC0, Kay Lousberg).
 *
 *   bun run assets:characters <dir> [<dir> …]
 *
 * Each dir is a pack's `Characters/gltf` folder; characters whose source isn't found are skipped.
 *   Fighters: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
 *   Monsters: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0
 *
 * Each source file carries every weapon of its class and 76–95 clips (~3.5–4.8 MB). We keep the
 * one loadout the game shows, the clips the renderer plays (renamed to Idle/Run/Attack/Hit/Dash/Death
 * so they auto-map), then quantise + meshopt-compress.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Character {
	src: string;
	out: string;
	/** Weapon/prop meshes to keep; the class's other hand-slot meshes are dropped. */
	keep: string[];
	clips: Record<'Idle' | 'Run' | 'Attack' | 'Hit' | 'Dash' | 'Death', string>;
}

/** Meshes parented to these bones are loadout props. Hats and capes (head/chest) always stay. */
const PROP_SLOTS = new Set(['handslot.l', 'handslot.r']);

const shared = { Run: 'Running_A', Hit: 'Hit_A', Dash: 'Dodge_Forward', Death: 'Death_A' };
/** Skeletons collapse into a pile of bones instead. */
const skeleton = { ...shared, Death: 'Death_C_Skeletons' };

const CHARACTERS: Character[] = [
	{
		src: 'Knight.glb',
		out: 'knight.glb',
		keep: ['2H_Sword'],
		clips: { ...shared, Idle: '2H_Melee_Idle', Attack: '2H_Melee_Attack_Slice' }
	},
	{
		src: 'Rogue.glb',
		out: 'rogue.glb',
		keep: ['Knife', 'Knife_Offhand'],
		clips: { ...shared, Idle: 'Idle', Attack: 'Dualwield_Melee_Attack_Slice' }
	},
	{
		src: 'Rogue_Hooded.glb',
		out: 'rogue_hooded.glb',
		keep: ['2H_Crossbow'],
		clips: { ...shared, Idle: 'Idle', Attack: '2H_Ranged_Shoot' }
	},
	{
		src: 'Mage.glb',
		out: 'mage.glb',
		keep: ['2H_Staff'],
		clips: { ...shared, Idle: 'Idle', Attack: 'Spellcast_Shoot' }
	},
	{
		src: 'Barbarian.glb',
		out: 'barbarian.glb',
		keep: [],
		clips: { ...shared, Idle: 'Unarmed_Idle', Attack: 'Unarmed_Melee_Attack_Punch_A' }
	},
	// Monsters. The Skeletons pack ships its weapons separately, so these fight bare-handed.
	{
		// Tier 1 (and the training dummy): slow shamble.
		src: 'Skeleton_Minion.glb',
		out: 'skeleton_minion.glb',
		keep: [],
		clips: { ...skeleton, Idle: 'Idle', Run: 'Walking_D_Skeletons', Attack: 'Unarmed_Melee_Attack_Punch_A' }
	},
	{
		src: 'Skeleton_Mage.glb',
		out: 'skeleton_mage.glb',
		keep: [],
		clips: { ...skeleton, Idle: 'Idle_Combat', Run: 'Running_B', Attack: 'Spellcast_Shoot' }
	},
	{
		src: 'Skeleton_Warrior.glb',
		out: 'skeleton_warrior.glb',
		keep: [],
		clips: { ...skeleton, Idle: 'Idle_Combat', Run: 'Running_C', Attack: 'Unarmed_Melee_Attack_Kick' }
	}
];

const srcDirs = process.argv.slice(2);
if (!srcDirs.length) {
	console.error('usage: bun run assets:characters <kaykit Characters/gltf dir> [<dir> …]');
	process.exit(1);
}
const outDir = join(import.meta.dirname, '..', 'public', 'models', 'characters');
mkdirSync(outDir, { recursive: true });

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

for (const c of CHARACTERS) {
	const src = srcDirs.map((d) => join(d, c.src)).find((f) => existsSync(f));
	if (!src) {
		console.log(`${c.out.padEnd(22)} skipped (${c.src} not found)`);
		continue;
	}
	const doc = await io.read(src);
	const root = doc.getRoot();

	for (const node of root.listNodes()) {
		const slot = node.getParentNode()?.getName() ?? '';
		if (node.getMesh() && PROP_SLOTS.has(slot) && !c.keep.includes(node.getName())) node.dispose();
	}

	const rename = new Map(Object.entries(c.clips).map(([to, from]) => [from, to]));
	for (const anim of root.listAnimations()) {
		const to = rename.get(anim.getName());
		if (to) {
			anim.setName(to);
			continue;
		}
		// Disposing an animation leaves its samplers behind; keyframe accessors may be shared.
		anim.listSamplers().forEach((s) => s.dispose());
		anim.listChannels().forEach((ch) => ch.dispose());
		anim.dispose();
	}
	const dropOrphans = () => {
		for (const a of root.listAccessors()) if (a.listParents().every((p) => p === root)) a.dispose();
	};
	dropOrphans();
	const missing = Object.keys(c.clips).filter((n) => !root.listAnimations().some((a) => a.getName() === n));
	if (missing.length) throw new Error(`${c.src}: missing clips ${missing.join(', ')}`);

	// prune() keeps accessors that only the root lists, so orphans are dropped by hand around it.
	await doc.transform(prune(), dedup(), resample(), prune());
	dropOrphans();
	await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
	const out = join(outDir, c.out);
	await io.write(out, doc);
	console.log(`${c.out.padEnd(22)} ${(statSync(out).size / 1024).toFixed(0).padStart(5)} KB  (from ${(statSync(src).size / 1024).toFixed(0)} KB)`);
}
