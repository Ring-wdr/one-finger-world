import * as THREE from 'three';
import {
	getItem,
	MAP_PROPS,
	MAP_RADIUS,
	PROP_VARIANTS,
	RING,
	TAG_INFO,
	type Fighter,
	type GameEvent,
	type Monster,
	type Vec2,
	type World
} from '@ofa/sim';
import { AOI_NORTH_OFFSET, AOI_RADIUS } from '@ofa/net';
import { AssetLibrary } from './assets/AssetLibrary';
import type { ModelInstance } from './assets/ModelInstance';
import type { AssetKey, InstanceOptions } from './assets/types';
import { DECOR } from './decor';
import { castShadows, Lighting } from './lighting';
import { createTerrain } from './terrain';
import { glowTexture, Particles } from './vfx';
import { ZoneWall } from './zoneWall';

/** sim (x, y) lies on the ground plane; screen-up = sim +y = three −z. */
const toThree = (p: Vec2, y = 0) => new THREE.Vector3(p.x, y, -p.y);
/** toThree into an existing vector, for per-frame paths. */
const setGround = (v: THREE.Vector3, p: Vec2, y = 0) => v.set(p.x, y, -p.y);
/** Yaw that points a −Z-forward object along sim direction (dx, dy). */
const facingAngle = (dx: number, dy: number) => Math.atan2(-dx, dy);
/** Per-tick step below which a monster keeps its heading, so jitter can't flip it around. */
const HEADING_MIN_STEP = 0.02;
/** How fast a monster turns toward its heading (1/s, exponential). */
const TURN_RATE = 14;
/**
 * Fighters turn faster, but still eased: facing arrives 20 times a second (and online, rounded to
 * 256 steps), so setting it directly makes a turning fighter twitch between headings.
 */
const FIGHTER_TURN_RATE = 28;
/** Signed shortest turn from angle `a` to angle `b`, in (−π, π]. */
const angleDelta = (a: number, b: number) => {
	const d = (b - a) % (Math.PI * 2);
	return d > Math.PI ? d - Math.PI * 2 : d <= -Math.PI ? d + Math.PI * 2 : d;
};

/** Fixed camera angle. It only ever translates (damped) — never rotates, shakes or bobs. */
const CAMERA_OFFSET = new THREE.Vector3(0, 26, 17);
const FOLLOW_RATE = 5;

const RARITY_COLOR = { common: 0xcfd8dc, rare: 0x42a5f5, legendary: 0xffca28 } as const;
/** How strongly a textured loot model glows in its rarity colour. */
const RARITY_GLOW = 0.3;
/** Training dummies read as straw-coloured and inert. */
const DUMMY_COLOR = 0xc9b37e;
const monsterKey = (m: Monster): AssetKey => `monster${m.tier}`;

/**
 * Side of the square map cells props are instanced by. A view (or the shadow box) covers a few
 * cells, so most of the 240-unit map stays culled; smaller cells would cull more but cost draws.
 */
const PROP_CELL = 40;

/**
 * Monster views exist only around what the camera shows: the same circle the server sends online
 * (@ofa/net AOI), so offline the 100-odd monsters across the map don't each run an animation
 * mixer every frame. A view is made inside VIEW_IN and dropped past VIEW_OUT, so units at the
 * edge don't churn.
 */
const VIEW_IN = AOI_RADIUS;
const VIEW_OUT = AOI_RADIUS + 6;
/** Monsters this far from the focus animate on every LOD_EVERY-th frame (with the summed time). */
const LOD_NEAR = 20;
const LOD_EVERY = 3;

/** Phones: cap the resolution lower and keep cheaper shadows. */
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const MAX_PIXEL_RATIO = COARSE ? 1.5 : 2;
const MIN_PIXEL_RATIO = 1;
/** Dynamic resolution: every window, step the pixel ratio by STEP when frames run slow or fast. */
const DPR_WINDOW = 2;
const DPR_STEP = 0.25;
const DPR_SLOW_MS = 22;
const DPR_FAST_MS = 14;

/** A corpse lies still this long after its death clip ends, then sinks out of sight. */
const CORPSE_HOLD = 1.2;
const CORPSE_SINK = 0.8;
const CORPSE_DEPTH = 1.5;
const NO_GLOW = new THREE.Color(0, 0, 0);
/** Fire, hottest first: trail embers and explosion sparks cycle through these. */
const FIRE = [0xfff1c1, 0xffc35a, 0xff8a2a, 0xff5a10].map((c) => new THREE.Color(c));

interface Bar {
	group: THREE.Group;
	fill: THREE.Mesh;
	shield: THREE.Mesh;
}

/** A model inside a parent group, swapped in place when its asset tag changes. */
interface ModelSlot {
	model: ModelInstance;
	/** `AssetLibrary.tag` the model was built for. */
	tag: string;
}

interface FighterView extends ModelSlot {
	root: THREE.Group;
	/** Rotates with facing; the root only translates so bars stay camera-aligned. */
	spin: THREE.Group;
	bubble: THREE.Mesh;
	/** Textured models don't take the fighter's colour, so it goes on the ground instead. */
	teamRing: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
	bar: Bar;
	/** Drawn yaw, easing toward the fighter's facing. */
	yaw: number;
}

interface MonsterView extends ModelSlot {
	root: THREE.Group;
	bar: Bar;
	/** Time not yet given to the model's mixer (animation LOD). */
	pendingDt: number;
	/** Where it wants to face. */
	heading: number;
	/** Where it faces now, easing toward `heading`. */
	yaw: number;
}

interface PickupView extends ModelSlot {
	root: THREE.Group;
	beam: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

/** A dead unit's model left in place to play out its death clip. */
interface Corpse {
	root: THREE.Object3D;
	model: ModelInstance;
	age: number;
	/** When sinking starts. */
	hold: number;
	remove: () => void;
}

interface Fx {
	obj: THREE.Object3D;
	life: number;
	max: number;
	tick: (k: number) => void;
}

export class Renderer {
	readonly renderer: THREE.WebGLRenderer;
	readonly scene = new THREE.Scene();
	readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 600);
	private readonly focus = new THREE.Vector3();
	private focusReady = false;
	private cameraScale = 1;
	private width = 1;
	private height = 1;
	private pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
	/** Frame time summed over the current dynamic-resolution window. */
	private perfTime = 0;
	private perfFrames = 0;
	private frameIndex = 0;
	/** Scratch for per-frame positions; nothing hot allocates. */
	private readonly drawPos: Vec2 = { x: 0, y: 0 };
	private readonly focusPos: Vec2 = { x: 0, y: 0 };
	private readonly fxBack = new THREE.Vector3();
	private readonly fxPos = new THREE.Vector3();
	private readonly fxVel = new THREE.Vector3();
	private readonly fxStep = new THREE.Vector3();
	private readonly fxTarget = new THREE.Vector3();
	/** Effect geometries by shape: every attack arc of the same width shares one buffer. */
	private readonly fxGeo = new Map<string, THREE.BufferGeometry>();

	private readonly fighters = new Map<number, FighterView>();
	private readonly monsters = new Map<number, MonsterView>();
	private readonly projectiles = new Map<number, ModelInstance>();
	/** Projectile ids that are fireballs, so their disappearance gets an impact puff. */
	private readonly fireballs = new Set<number>();
	private readonly pickups = new Map<number, PickupView>();
	private readonly hitAt = new Map<number, number>();
	/** Units whose `death` event arrived since the last render. */
	private readonly dying = new Set<number>();
	private corpses: Corpse[] = [];
	private fx: Fx[] = [];
	private clock = 0;
	private props: THREE.InstancedMesh[] = [];
	private propsTag = '';

	private readonly zoneWall = new ZoneWall();
	private readonly lighting: Lighting;
	private readonly nextRing: THREE.Mesh;
	private readonly playerMarker: THREE.Mesh;
	/** Tutorial goal: pulsing ground ring + light beam. */
	private readonly goal = new THREE.Group();
	private goalRadius = 1;

	private readonly geo = {
		bubble: new THREE.SphereGeometry(1.2, 20, 14),
		teamRing: new THREE.RingGeometry(0.62, 0.8, 32).rotateX(-Math.PI / 2),
		barBg: new THREE.PlaneGeometry(1, 0.16),
		barFill: new THREE.PlaneGeometry(1, 0.16).translate(0.5, 0, 0),
		beam: new THREE.CylinderGeometry(0.08, 0.08, 6, 6, 1, true)
	};
	private readonly mat = {
		barBg: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false }),
		barHp: new THREE.MeshBasicMaterial({ color: 0x5ee06a, depthTest: false }),
		barEnemy: new THREE.MeshBasicMaterial({ color: 0xff5a5a, depthTest: false }),
		barShield: new THREE.MeshBasicMaterial({ color: 0x9fd4ff, depthTest: false }),
		bubble: new THREE.MeshBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.18, depthWrite: false })
	};
	private readonly glow = new THREE.Color();
	private readonly particles = new Particles(1024);
	private readonly glowTex = glowTexture();

	/** Resolves once every model has loaded or fallen back to its primitive. */
	readonly ready: Promise<void>;

	constructor(
		canvas: HTMLCanvasElement,
		onAssetProgress?: (done: number, total: number) => void,
		private readonly assets = new AssetLibrary()
	) {
		// Primitives render immediately; models swap in as they arrive.
		this.ready = this.assets.preload(onAssetProgress);

		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(this.pixelRatio);
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = COARSE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
		this.scene.background = new THREE.Color(0x11151c);
		this.scene.fog = new THREE.Fog(0x11151c, 60, 130);

		this.lighting = new Lighting(this.scene);

		this.buildGround();
		this.scene.add(this.particles.points);

		this.scene.add(this.zoneWall.mesh);

		this.nextRing = new THREE.Mesh(
			new THREE.RingGeometry(0.99, 1, 128).rotateX(-Math.PI / 2),
			new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false })
		);
		this.nextRing.position.y = 0.06;
		this.scene.add(this.nextRing);

		this.playerMarker = new THREE.Mesh(
			new THREE.RingGeometry(0.9, 1.1, 32).rotateX(-Math.PI / 2),
			new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.9, depthWrite: false })
		);
		this.playerMarker.position.y = 0.05;
		this.scene.add(this.playerMarker);

		const goalRing = new THREE.Mesh(
			new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
			new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.85, depthWrite: false })
		);
		goalRing.position.y = 0.07;
		const goalBeam = new THREE.Mesh(
			new THREE.CylinderGeometry(0.25, 0.25, 8, 12, 1, true),
			new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
		);
		goalBeam.position.y = 4;
		this.goal.add(goalRing, goalBeam);
		this.goal.visible = false;
		this.scene.add(this.goal);
	}

	setMarker(marker: { pos: Vec2; radius: number } | null) {
		this.goal.visible = marker !== null;
		if (!marker) return;
		this.goal.position.set(marker.pos.x, 0, -marker.pos.y);
		this.goalRadius = marker.radius;
	}

	/** Drop every entity view — call when switching to a different World. */
	reset() {
		for (const v of this.fighters.values()) this.removeFighter(v);
		for (const v of this.monsters.values()) {
			this.scene.remove(v.root);
			v.model.dispose();
		}
		for (const v of this.pickups.values()) this.removePickup(v);
		for (const m of this.projectiles.values()) m.dispose();
		for (const e of this.fx) this.scene.remove(e.obj);
		for (const c of this.corpses) c.remove();
		this.corpses = [];
		this.particles.clear();
		this.dying.clear();
		this.fighters.clear();
		this.monsters.clear();
		this.projectiles.clear();
		this.fireballs.clear();
		this.pickups.clear();
		this.hitAt.clear();
		this.fx = [];
		this.focusReady = false;
		this.setMarker(null);
	}

	private buildGround() {
		const flat = (g: THREE.BufferGeometry) => g.rotateX(-Math.PI / 2);
		const terrain = createTerrain(this.renderer);
		terrain.receiveShadow = true;
		this.scene.add(terrain);
		// Exact ring boundaries: the terrain blends zones, these say where they really change.
		for (const r of [RING.center, RING.mid, MAP_RADIUS]) {
			const line = new THREE.Mesh(
				flat(new THREE.RingGeometry(r - 0.25, r + 0.25, 128)),
				new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 })
			);
			line.position.y = 0.02;
			this.scene.add(line);
		}
		this.buildProps();
	}

	/**
	 * Static props give the eye fixed landmarks, which reduces perceived motion.
	 * Rebuilt (same seeded layout) when a prop model arrives.
	 *
	 * Instanced per model and map cell, not per model: an InstancedMesh is culled as a whole, so a
	 * map-wide one would draw every prop every frame (twice, with the shadow pass). Per cell, the
	 * camera and shadow frustums drop the cells out of view.
	 *
	 * Ground decoration (render/decor.ts) goes through the same path, but casts no shadow: it is
	 * small and plentiful, and lies in the props' shadows instead.
	 */
	private buildProps() {
		const keys = ['rock', 'tree', 'deadTree', 'decor'] as const;
		const variantsOf = (key: AssetKey): (string | undefined)[] => {
			const vs = this.assets.variants(key);
			return vs.length ? vs : [undefined];
		};
		const tag = keys.map((k) => variantsOf(k).map((v) => this.assets.tag(k, v)).join(',')).join('|');
		if (tag === this.propsTag) return;
		this.propsTag = tag;
		for (const p of this.props) {
			this.scene.remove(p);
			p.dispose();
		}
		this.props = [];

		// Layout (position, scale, yaw, variant) comes from the sim, which also collides with the
		// same props, so what blocks a unit is exactly what is drawn.
		const placed = new Map<string, { key: AssetKey; variant: string | undefined; matrices: THREE.Matrix4[] }>();
		const up = new THREE.Vector3(0, 1, 0);
		const place = (key: AssetKey, variant: string | undefined, p: { x: number; y: number; yaw: number; scale: number }) => {
			const id = `${key}:${variant}:${Math.floor(p.x / PROP_CELL)},${Math.floor(p.y / PROP_CELL)}`;
			const group = placed.get(id) ?? { key, variant, matrices: [] };
			placed.set(id, group);
			group.matrices.push(
				new THREE.Matrix4().compose(
					toThree(p),
					new THREE.Quaternion().setFromAxisAngle(up, p.yaw),
					new THREE.Vector3(p.scale, p.scale, p.scale)
				)
			);
		};
		for (const p of MAP_PROPS) {
			const vs = variantsOf(p.kind);
			const name = PROP_VARIANTS[p.kind][p.variant]?.name;
			place(p.kind, name !== undefined && vs.includes(name) ? name : vs[p.variant % vs.length], p);
		}
		for (const d of DECOR) place('decor', d.variant, d);

		for (const { key, variant, matrices } of placed.values()) {
			// Parts are cached per model, so every cell shares one geometry and material.
			for (const part of this.assets.instancedParts(key, variant)) {
				const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
				mesh.castShadow = key !== 'decor';
				mesh.receiveShadow = key === 'decor';
				matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
				// Bounds over this cell's instances only, for culling.
				mesh.computeBoundingSphere();
				this.props.push(mesh);
				this.scene.add(mesh);
			}
		}
	}

	resize(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.renderer.setPixelRatio(this.pixelRatio);
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		// Portrait phones: pull back so roughly the same ground width stays visible.
		this.cameraScale = Math.max(1, 0.95 / this.camera.aspect);
		this.camera.updateProjectionMatrix();
		this.particles.setViewport(height * this.renderer.getPixelRatio(), this.camera.fov);
	}

	/** Dynamic resolution: lower the pixel ratio while frames run slow, raise it back when they're quick. */
	private adaptResolution(dt: number) {
		this.perfTime += dt;
		this.perfFrames++;
		if (this.perfTime < DPR_WINDOW) return;
		const ms = (this.perfTime / this.perfFrames) * 1000;
		this.perfTime = 0;
		this.perfFrames = 0;
		const best = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
		let next = this.pixelRatio;
		if (ms > DPR_SLOW_MS) next = Math.max(Math.min(MIN_PIXEL_RATIO, best), this.pixelRatio - DPR_STEP);
		else if (ms < DPR_FAST_MS) next = Math.min(best, this.pixelRatio + DPR_STEP);
		if (next === this.pixelRatio) return;
		this.pixelRatio = next;
		this.resize(this.width, this.height);
	}

	private makeBar(width: number, y: number): Bar {
		const group = new THREE.Group();
		group.position.y = y;
		group.renderOrder = 10;
		const bg = new THREE.Mesh(this.geo.barBg, this.mat.barBg);
		bg.scale.x = width + 0.08;
		bg.scale.y = 1.5;
		const fill = new THREE.Mesh(this.geo.barFill, this.mat.barEnemy);
		fill.position.x = -width / 2;
		fill.userData.width = width;
		const shield = new THREE.Mesh(this.geo.barFill, this.mat.barShield);
		shield.position.set(-width / 2, 0.14, 0);
		shield.scale.y = 0.5;
		for (const m of [bg, fill, shield]) m.renderOrder = 10;
		group.add(bg, fill, shield);
		return { group, fill, shield };
	}

	private setBar(bar: Bar, frac: number, shieldFrac: number) {
		const w = bar.fill.userData.width as number;
		bar.fill.scale.x = Math.max(0.0001, Math.min(1, frac)) * w;
		bar.shield.visible = shieldFrac > 0.001;
		bar.shield.scale.x = Math.max(0.0001, Math.min(1, shieldFrac)) * w;
		bar.group.quaternion.copy(this.camera.quaternion);
	}

	/**
	 * A unit or loot model: these cast shadows (projectiles and effects don't). Tier-1 monsters are
	 * the crowd (up to 55) and small, so they skip the shadow pass.
	 */
	private spawn(key: AssetKey, opts: InstanceOptions): ModelInstance {
		const model = this.assets.instantiate(key, opts);
		if (key !== 'monster1') castShadows(model.object);
		return model;
	}

	/** Swap in the current model for `key` if it changed since the slot was filled. */
	private refresh(slot: ModelSlot, parent: THREE.Object3D, key: AssetKey, opts: InstanceOptions) {
		const tag = this.assets.tag(key, opts.variant);
		if (slot.tag === tag) return;
		slot.model.dispose();
		slot.model = this.spawn(key, opts);
		slot.tag = tag;
		parent.add(slot.model.object);
	}

	private fighterView(f: Fighter, isPlayer: boolean): FighterView {
		// The model follows the weapon, so a swap is visible on the character.
		const opts: InstanceOptions = { variant: f.build.weapon ?? 'unarmed', color: f.color, glow: true };
		let v = this.fighters.get(f.id);
		if (v) {
			this.refresh(v, v.spin, 'fighter', opts);
			v.teamRing.visible = !isPlayer && !v.model.isFallback;
			return v;
		}
		const root = new THREE.Group();
		const model = this.spawn('fighter', opts);
		const bubble = new THREE.Mesh(this.geo.bubble, this.mat.bubble);
		bubble.position.y = 0.95;
		const teamRing = new THREE.Mesh(
			this.geo.teamRing,
			new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.75, depthWrite: false })
		);
		teamRing.position.y = 0.04;
		teamRing.visible = !isPlayer && !model.isFallback;
		const bar = this.makeBar(1.6, 2.5);
		if (isPlayer) bar.fill.material = this.mat.barHp;
		const spin = new THREE.Group();
		spin.add(model.object);
		root.add(spin, bubble, teamRing, bar.group);
		this.scene.add(root);
		const yaw = facingAngle(f.facing.x, f.facing.y);
		v = { root, spin, model, tag: this.assets.tag('fighter', opts.variant), bubble, teamRing, bar, yaw };
		this.fighters.set(f.id, v);
		return v;
	}

	private removeFighter(v: FighterView) {
		this.scene.remove(v.root);
		v.model.dispose();
		v.teamRing.material.dispose();
	}

	private monsterView(m: Monster): MonsterView {
		const key = monsterKey(m);
		const opts: InstanceOptions = { color: m.passive ? DUMMY_COLOR : undefined, glow: true };
		let v = this.monsters.get(m.id);
		if (v) {
			this.refresh(v, v.root, key, opts);
			return v;
		}
		const root = new THREE.Group();
		const model = this.spawn(key, opts);
		const bar = this.makeBar(m.radius * 1.8, m.radius * 2 + 0.6);
		root.add(model.object, bar.group);
		this.scene.add(root);
		// Face the camera until it first moves or picks a target.
		v = { root, model, tag: this.assets.tag(key), bar, heading: Math.PI, yaw: Math.PI, pendingDt: 0 };
		this.monsters.set(m.id, v);
		return v;
	}

	private pickupView(id: number, pos: Vec2, itemId: string): PickupView {
		const item = getItem(itemId);
		// Primitives take the rarity as their colour; textured models glow with it instead.
		const opts: InstanceOptions = {
			variant: item.kind,
			color: RARITY_COLOR[item.rarity],
			glow: true
		};
		let v = this.pickups.get(id);
		if (v) {
			this.refresh(v, v.root, 'pickup', opts);
			v.model.setGlow(this.glow.setHex(RARITY_COLOR[item.rarity]).multiplyScalar(RARITY_GLOW));
			return v;
		}
		const root = new THREE.Group();
		const model = this.spawn('pickup', opts);
		const beam = new THREE.Mesh(
			this.geo.beam,
			new THREE.MeshBasicMaterial({ color: TAG_INFO[item.tags[0]].color, transparent: true, opacity: 0.35, depthWrite: false })
		);
		beam.position.y = 3;
		root.add(model.object, beam);
		setGround(root.position, pos);
		this.scene.add(root);
		v = { root, model, tag: this.assets.tag('pickup', opts.variant), beam };
		this.pickups.set(id, v);
		return v;
	}

	private removePickup(v: PickupView) {
		this.scene.remove(v.root);
		v.model.dispose();
		v.beam.material.dispose();
	}

	private statusGlow(model: ModelInstance, u: Fighter | Monster, hitK: number) {
		const s = u.status;
		if (hitK > 0) this.glow.setRGB(hitK, hitK, hitK);
		else if (s.burnTime > 0) this.glow.setHex(0x803000);
		else if (s.bleedStacks > 0) this.glow.setHex(0x600010);
		else this.glow.setHex(0x000000);
		model.setGlow(this.glow);
	}

	/**
	 * Keep a unit that just died on screen to play its death clip. Returns false when it didn't
	 * die (despawned, world switched) or its model has no such clip — the caller removes it then.
	 */
	private bury(id: number, root: THREE.Object3D, model: ModelInstance, hide: THREE.Object3D[], remove: () => void): boolean {
		if (!this.dying.has(id)) return false;
		const length = model.die();
		if (length === null) return false;
		for (const o of hide) o.visible = false;
		model.setGlow(NO_GLOW);
		model.object.scale.setScalar(1);
		this.corpses.push({ root, model, age: 0, hold: length + CORPSE_HOLD, remove });
		return true;
	}

	/** An event's unit model, fighter or monster. */
	private unitModel(id: number): ModelInstance | undefined {
		return (this.fighters.get(id) ?? this.monsters.get(id))?.model;
	}

	/** `alpha` interpolates between the previous and current sim tick. */
	render(world: World, prev: Map<number, Vec2>, alpha: number, focusId: number | null, dt: number) {
		this.clock += dt;
		this.frameIndex++;
		this.adaptResolution(dt);
		/** Interpolated position, in a scratch object that the next call overwrites. */
		const lerpPos = (id: number, p: Vec2): Vec2 => {
			const a = prev.get(id);
			const out = this.drawPos;
			if (!a) {
				out.x = p.x;
				out.y = p.y;
			} else {
				out.x = a.x + (p.x - a.x) * alpha;
				out.y = a.y + (p.y - a.y) * alpha;
			}
			return out;
		};
		const turn = (yaw: number, to: number, rate: number) => to - angleDelta(yaw, to) * Math.exp(-rate * dt);
		const hitK = (id: number) => {
			const t = this.hitAt.get(id);
			return t === undefined ? 0 : Math.max(0, 1 - (this.clock - t) / 0.15);
		};

		// Fighters
		const seen = new Set<number>();
		let focusPos: Vec2 | null = null;
		for (const f of world.fighters) {
			if (!f.alive) continue;
			seen.add(f.id);
			const v = this.fighterView(f, f.id === focusId);
			const p = lerpPos(f.id, f.pos);
			setGround(v.root.position, p);
			v.yaw = turn(v.yaw, facingAngle(f.facing.x, f.facing.y), FIGHTER_TURN_RATE);
			v.spin.rotation.y = v.yaw;
			const k = hitK(f.id);
			this.statusGlow(v.model, f, k * 0.6);
			// Primitives squash to read as a dash; models have a clip for it.
			if (v.model.isFallback) v.model.object.scale.set(1, f.dashTime > 0 ? 0.75 : 1, 1);
			v.model.setLoop(f.moveDir || f.dashTime > 0 ? 'move' : 'idle');
			v.model.update(dt);
			v.bubble.visible = f.shield > 0.5;
			this.setBar(v.bar, f.hp / f.maxHp, f.shield / f.maxHp);
			if (f.id === focusId) {
				this.focusPos.x = p.x;
				this.focusPos.y = p.y;
				focusPos = this.focusPos;
			}
		}
		for (const [id, v] of this.fighters) {
			if (seen.has(id)) continue;
			if (!this.bury(id, v.root, v.model, [v.bubble, v.teamRing, v.bar.group], () => this.removeFighter(v))) this.removeFighter(v);
			this.fighters.delete(id);
		}

		// Camera: damped translation only. Placed before the monsters, which are culled around it.
		if (focusPos) {
			const target = setGround(this.fxTarget, focusPos);
			if (!this.focusReady) {
				this.focus.copy(target);
				this.focusReady = true;
			} else {
				this.focus.lerp(target, 1 - Math.exp(-FOLLOW_RATE * dt));
			}
		}
		this.camera.position.copy(this.focus).addScaledVector(CAMERA_OFFSET, this.cameraScale);
		this.camera.lookAt(this.focus);
		this.lighting.follow(this.focus);

		// Monsters: views only around the view centre (see VIEW_IN), far ones animate at a lower rate.
		const viewX = this.focus.x;
		const viewY = -this.focus.z + AOI_NORTH_OFFSET;
		seen.clear();
		for (const m of world.monsters) {
			const far = Math.hypot(m.pos.x - viewX, m.pos.y - viewY);
			if (far > (this.monsters.has(m.id) ? VIEW_OUT : VIEW_IN)) continue;
			seen.add(m.id);
			const v = this.monsterView(m);
			const p = lerpPos(m.id, m.pos);
			setGround(v.root.position, p);
			const was = prev.get(m.id);
			const step = was === undefined ? 0 : Math.hypot(m.pos.x - was.x, m.pos.y - was.y);
			const moving = step > 1e-4;
			const walking = was !== undefined && step > HEADING_MIN_STEP;
			const target = !walking && m.targetId !== null ? world.fighters.find((f) => f.id === m.targetId) : undefined;
			// Face where it walks, or whoever it's standing still to hit.
			if (walking) v.heading = facingAngle(m.pos.x - was.x, m.pos.y - was.y);
			else if (target) v.heading = facingAngle(target.pos.x - m.pos.x, target.pos.y - m.pos.y);
			// Stepping from the heading keeps yaw within one turn of it instead of accumulating.
			v.yaw = turn(v.yaw, v.heading, TURN_RATE);
			const obj = v.model.object;
			if (v.model.isFallback) {
				// Floating, spinning gem.
				obj.rotation.y = this.clock * 0.8 + m.id;
				obj.position.y = m.radius + 0.1 + Math.sin(this.clock * 3 + m.id) * 0.08;
			} else {
				obj.rotation.y = v.yaw;
			}
			const k = hitK(m.id);
			obj.scale.setScalar(1 + k * 0.25);
			this.statusGlow(v.model, m, k * 0.5);
			v.model.setLoop(moving ? 'move' : 'idle');
			v.pendingDt += dt;
			const near = Math.hypot(m.pos.x - this.focus.x, m.pos.y + this.focus.z) < LOD_NEAR;
			if (near || (this.frameIndex + m.id) % LOD_EVERY === 0) {
				v.model.update(v.pendingDt);
				v.pendingDt = 0;
			}
			v.bar.group.visible = m.hp < m.maxHp - 0.01;
			this.setBar(v.bar, m.hp / m.maxHp, 0);
		}
		for (const [id, v] of this.monsters) {
			if (seen.has(id)) continue;
			const remove = () => {
				this.scene.remove(v.root);
				v.model.dispose();
			};
			if (!this.bury(id, v.root, v.model, [v.bar.group], remove)) remove();
			this.monsters.delete(id);
		}
		this.dying.clear();

		this.corpses = this.corpses.filter((c) => {
			c.age += dt;
			c.model.update(dt);
			const sink = (c.age - c.hold) / CORPSE_SINK;
			if (sink >= 1) {
				c.remove();
				return false;
			}
			if (sink > 0) c.root.position.y = -sink * CORPSE_DEPTH;
			return true;
		});

		// Projectiles
		seen.clear();
		for (const pr of world.projectiles) {
			seen.add(pr.id);
			let model = this.projectiles.get(pr.id);
			if (!model) {
				model = this.assets.instantiate(pr.kind);
				this.scene.add(model.object);
				this.projectiles.set(pr.id, model);
				if (pr.kind === 'fireball') this.fireballs.add(pr.id);
			}
			setGround(model.object.position, lerpPos(pr.id, pr.pos), 1.1);
			model.object.rotation.y = facingAngle(pr.vel.x, pr.vel.y);
			if (pr.kind === 'fireball') this.fireballFx(model.object, pr.id, pr.vel, dt);
		}
		for (const [id, model] of this.projectiles) {
			if (seen.has(id)) continue;
			// Basic fireballs don't explode (no AoE), but shouldn't just blink out either.
			if (this.fireballs.delete(id)) this.particles.burst(model.object.position, 14, 2.5, FIRE);
			model.dispose();
			this.projectiles.delete(id);
		}

		// Pickups
		seen.clear();
		for (const pk of world.pickups) {
			seen.add(pk.id);
			this.pickupView(pk.id, pk.pos, pk.itemId).model.object.rotation.y = this.clock * 1.5;
		}
		for (const [id, v] of this.pickups) {
			if (seen.has(id)) continue;
			this.removePickup(v);
			this.pickups.delete(id);
		}

		this.buildProps();
		this.particles.update(dt);

		if (this.goal.visible) {
			const pulse = 1 + Math.sin(this.clock * 4) * 0.06;
			this.goal.children[0].scale.setScalar(this.goalRadius * pulse);
		}

		// Zone
		const z = world.zone;
		this.zoneWall.update({ x: z.current.center.x, z: -z.current.center.y }, z.current.radius, this.clock);
		const showNext = z.to.radius < z.current.radius - 0.5;
		this.nextRing.visible = showNext;
		if (showNext) {
			this.nextRing.scale.setScalar(Math.max(0.01, z.to.radius));
			this.nextRing.position.x = z.to.center.x;
			this.nextRing.position.z = -z.to.center.y;
		}

		this.playerMarker.visible = focusPos !== null && focusId !== null && world.fighters.some((f) => f.id === focusId && !f.bot);
		if (focusPos) setGround(this.playerMarker.position, focusPos, 0.05);

		// FX
		this.fx = this.fx.filter((e) => {
			e.life -= dt;
			if (e.life <= 0) {
				this.scene.remove(e.obj);
				e.obj.traverse((o) => {
					if (o instanceof THREE.Mesh) {
						if (!o.geometry.userData.shared) o.geometry.dispose();
						(o.material as THREE.Material).dispose();
					} else if (o instanceof THREE.Sprite) {
						o.material.dispose();
					}
				});
				return false;
			}
			e.tick(1 - e.life / e.max);
			return true;
		});


		this.renderer.render(this.scene, this.camera);
	}

	worldToScreen(p: Vec2, height = 2): { x: number; y: number } | null {
		const v = toThree(p, height).project(this.camera);
		if (v.z > 1) return null;
		const el = this.renderer.domElement;
		return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
	}

	/** Flicker, and shed embers behind it along its flight. */
	private fireballFx(obj: THREE.Object3D, id: number, vel: Vec2, dt: number) {
		obj.scale.setScalar(1 + Math.sin(this.clock * 38 + id) * 0.1);
		const back = this.fxBack.set(-vel.x, 0, vel.y).normalize();
		const p = this.fxPos;
		const v = this.fxVel;
		// ~150 embers a second, spread along the frame's travel so the trail stays continuous.
		const count = Math.max(2, Math.round(dt * 150));
		const step = this.fxStep.set(vel.x, 0, -vel.y).multiplyScalar(dt / count);
		for (let i = 0; i < count; i++) {
			p.copy(obj.position)
				.addScaledVector(step, -i)
				.add(v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.3));
			v.copy(back).multiplyScalar(0.8 + Math.random() * 1.2);
			v.x += (Math.random() - 0.5) * 0.6;
			v.y += 0.4;
			v.z += (Math.random() - 0.5) * 0.6;
			this.particles.emit(p, v, 0.35 + Math.random() * 0.25, 0.6 + Math.random() * 0.45, FIRE[1 + (i % 3)]);
		}
	}

	/** Bright flash that swells and fades, plus sparks — fireball impacts and death blasts. */
	private explosionFx(at: Vec2, radius: number) {
		const flash = new THREE.Sprite(
			new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffb347, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
		);
		flash.position.copy(toThree(at, 0.9));
		const mat = flash.material;
		this.addFx(flash, 0.28, (k) => {
			// The glow texture falls off steeply, so the sprite spans well past the blast radius.
			flash.scale.setScalar(radius * (2 + 1.8 * k));
			mat.opacity = 1 - k * k;
		});
		this.particles.burst(toThree(at, 0.6), Math.round(24 + radius * 10), 3 + radius * 2.2, FIRE);
	}

	private addFx(obj: THREE.Object3D, duration: number, tick: (k: number) => void) {
		this.scene.add(obj);
		this.fx.push({ obj, life: duration, max: duration, tick });
		tick(0);
	}

	/** A geometry kept for the renderer's lifetime and shared by every effect of that shape. */
	private sharedGeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
		let g = this.fxGeo.get(key);
		if (!g) {
			g = make();
			g.userData.shared = true;
			this.fxGeo.set(key, g);
		}
		return g;
	}

	/**
	 * A flat ring or arc around `at`. The geometry is a unit ring shared per (inner/outer, arc) and
	 * scaled to `outer`; the arc is turned to `start` (sim angle) by the mesh's yaw.
	 */
	private groundRing(at: Vec2, inner: number, outer: number, color: number, start = 0, length = Math.PI * 2) {
		const ratio = Math.round((inner / outer) * 100) / 100;
		const arc = Math.round(length * 100) / 100;
		const geo = this.sharedGeo(`ring:${ratio}:${arc}`, () => new THREE.RingGeometry(ratio, 1, 40, 1, 0, arc).rotateX(-Math.PI / 2));
		const mesh = new THREE.Mesh(
			geo,
			new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide })
		);
		mesh.scale.setScalar(outer);
		mesh.rotation.y = start;
		setGround(mesh.position, at, 0.08);
		return mesh;
	}

	handleEvents(events: readonly GameEvent[], playerId: number | null) {
		for (const e of events) {
			switch (e.type) {
				case 'hit':
					this.hitAt.set(e.target, this.clock);
					this.unitModel(e.target)?.trigger('hit');
					break;
				case 'attack': {
					this.unitModel(e.unit)?.trigger('attack');
					if (e.radius <= 0) break;
					const start = Math.atan2(e.facing.y, e.facing.x) - e.arc / 2;
					const color = e.combo === 3 ? 0xffe082 : e.unit === playerId ? 0xffffff : 0xff9e80;
					const mesh = this.groundRing(e.pos, e.radius * 0.35, e.radius, color, start, e.arc);
					const mat = mesh.material as THREE.MeshBasicMaterial;
					this.addFx(mesh, 0.16, (k) => {
						mat.opacity = 0.65 * (1 - k);
					});
					break;
				}
				case 'skill':
				case 'explode': {
					if (e.radius <= 0) break;
					if (e.type === 'explode') this.explosionFx(e.pos, e.radius);
					const color = e.type === 'explode' ? 0xff7a33 : 0xb39ddb;
					const mesh = this.groundRing(e.pos, 0.85, 1, color);
					const mat = mesh.material as THREE.MeshBasicMaterial;
					const r = e.radius;
					this.addFx(mesh, 0.3, (k) => {
						mesh.scale.setScalar(Math.max(0.01, r * (0.3 + 0.7 * k)));
						mat.opacity = 0.8 * (1 - k);
					});
					break;
				}
				case 'dash': {
					this.unitModel(e.unit)?.trigger('dash');
					const dx = e.to.x - e.from.x;
					const dy = e.to.y - e.from.y;
					const len = Math.hypot(dx, dy);
					const mesh = new THREE.Mesh(
						this.sharedGeo('dash', () => new THREE.PlaneGeometry(0.9, 1).rotateX(-Math.PI / 2)),
						new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.5, depthWrite: false })
					);
					mesh.scale.z = Math.max(0.01, len);
					mesh.position.set(e.from.x + dx / 2, 0.1, -(e.from.y + dy / 2));
					mesh.rotation.y = facingAngle(dx, dy);
					const mat = mesh.material;
					this.addFx(mesh, 0.3, (k) => {
						mat.opacity = 0.5 * (1 - k);
					});
					break;
				}
				case 'death': {
					this.dying.add(e.unit);
					const big = e.kind === 'fighter';
					const mesh = this.groundRing(e.pos, 0.7, 1, big ? 0xffffff : 0xffcc80);
					const mat = mesh.material as THREE.MeshBasicMaterial;
					this.addFx(mesh, big ? 0.7 : 0.35, (k) => {
						mesh.scale.setScalar((big ? 5 : 1.8) * (0.2 + k));
						mat.opacity = 0.9 * (1 - k);
					});
					break;
				}
				case 'levelUp':
				case 'synergy': {
					if (e.unit !== playerId) break;
					const color = e.type === 'synergy' ? new THREE.Color(TAG_INFO[e.tag].color).getHex() : 0xffd54f;
					const mesh = new THREE.Mesh(
						this.sharedGeo('levelUp', () => new THREE.CylinderGeometry(1.2, 1.2, 4, 24, 1, true)),
						new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
					);
					const fighter = this.fighters.get(e.unit);
					if (fighter) mesh.position.copy(fighter.root.position).setY(2);
					const mat = mesh.material;
					this.addFx(mesh, 0.8, (k) => {
						mesh.scale.set(1 + k, 1 + k * 0.5, 1 + k);
						mat.opacity = 0.5 * (1 - k);
					});
					break;
				}
			}
		}
	}

	dispose() {
		this.reset();
		for (const g of this.fxGeo.values()) g.dispose();
		this.fxGeo.clear();
		this.particles.dispose();
		this.glowTex.dispose();
		this.zoneWall.dispose();
		this.assets.dispose();
		this.renderer.dispose();
	}
}
