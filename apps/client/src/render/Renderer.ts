import * as THREE from 'three';
import {
	getItem,
	MAP_RADIUS,
	RING,
	Rng,
	TAG_INFO,
	type Fighter,
	type GameEvent,
	type Monster,
	type Vec2,
	type World
} from '@ofa/sim';

/** sim (x, y) lies on the ground plane; screen-up = sim +y = three −z. */
const toThree = (p: Vec2, y = 0) => new THREE.Vector3(p.x, y, -p.y);

/** Fixed camera angle. It only ever translates (damped) — never rotates, shakes or bobs. */
const CAMERA_OFFSET = new THREE.Vector3(0, 26, 17);
const FOLLOW_RATE = 5;

const RARITY_COLOR = { common: 0xcfd8dc, rare: 0x42a5f5, legendary: 0xffca28 } as const;
const MONSTER_LOOK = {
	1: { color: 0x7bc96f, geo: () => new THREE.IcosahedronGeometry(0.6, 0) },
	2: { color: 0x9b6bd6, geo: () => new THREE.DodecahedronGeometry(0.85, 0) },
	3: { color: 0xd9534f, geo: () => new THREE.OctahedronGeometry(1.2, 0) }
} as const;

interface Bar {
	group: THREE.Group;
	fill: THREE.Mesh;
	shield: THREE.Mesh;
}

interface FighterView {
	root: THREE.Group;
	/** Rotates with facing; the root only translates so bars stay camera-aligned. */
	spin: THREE.Group;
	body: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
	nose: THREE.Mesh;
	bubble: THREE.Mesh;
	bar: Bar;
}

interface MonsterView {
	root: THREE.Group;
	body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
	bar: Bar;
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

	private readonly fighters = new Map<number, FighterView>();
	private readonly monsters = new Map<number, MonsterView>();
	private readonly projectiles = new Map<number, THREE.Mesh>();
	private readonly pickups = new Map<number, THREE.Group>();
	private readonly hitAt = new Map<number, number>();
	private fx: Fx[] = [];
	private clock = 0;

	private readonly zoneWall: THREE.Mesh;
	private readonly nextRing: THREE.Mesh;
	private readonly playerMarker: THREE.Mesh;
	/** Tutorial goal: pulsing ground ring + light beam. */
	private readonly goal = new THREE.Group();
	private goalRadius = 1;

	private readonly geo = {
		capsule: new THREE.CapsuleGeometry(0.55, 0.8, 4, 12),
		nose: new THREE.ConeGeometry(0.22, 0.5, 10).rotateX(-Math.PI / 2),
		bubble: new THREE.SphereGeometry(1.2, 20, 14),
		barBg: new THREE.PlaneGeometry(1, 0.16),
		barFill: new THREE.PlaneGeometry(1, 0.16).translate(0.5, 0, 0),
		arrow: new THREE.BoxGeometry(0.12, 0.12, 0.9),
		fireball: new THREE.SphereGeometry(0.45, 12, 10),
		pickup: new THREE.BoxGeometry(0.6, 0.6, 0.6),
		beam: new THREE.CylinderGeometry(0.08, 0.08, 6, 6, 1, true)
	};
	private readonly mat = {
		barBg: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false }),
		barHp: new THREE.MeshBasicMaterial({ color: 0x5ee06a, depthTest: false }),
		barEnemy: new THREE.MeshBasicMaterial({ color: 0xff5a5a, depthTest: false }),
		barShield: new THREE.MeshBasicMaterial({ color: 0x9fd4ff, depthTest: false }),
		nose: new THREE.MeshStandardMaterial({ color: 0x222831 }),
		bubble: new THREE.MeshBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.18, depthWrite: false }),
		arrow: new THREE.MeshBasicMaterial({ color: 0xe8f1ff }),
		fireball: new THREE.MeshBasicMaterial({ color: 0xff8a3d })
	};

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.scene.background = new THREE.Color(0x11151c);
		this.scene.fog = new THREE.Fog(0x11151c, 60, 130);

		this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f24, 1.6));
		const sun = new THREE.DirectionalLight(0xffffff, 1.4);
		sun.position.set(30, 60, 20);
		this.scene.add(sun);

		this.buildGround();

		this.zoneWall = new THREE.Mesh(
			new THREE.CylinderGeometry(1, 1, 14, 128, 1, true),
			new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
		);
		this.zoneWall.position.y = 7;
		this.scene.add(this.zoneWall);

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
		for (const v of this.fighters.values()) {
			this.scene.remove(v.root);
			v.body.material.dispose();
		}
		for (const v of this.monsters.values()) {
			this.scene.remove(v.root);
			v.body.geometry.dispose();
			v.body.material.dispose();
		}
		for (const m of this.projectiles.values()) this.scene.remove(m);
		for (const g of this.pickups.values()) this.scene.remove(g);
		for (const e of this.fx) this.scene.remove(e.obj);
		this.fighters.clear();
		this.monsters.clear();
		this.projectiles.clear();
		this.pickups.clear();
		this.hitAt.clear();
		this.fx = [];
		this.focusReady = false;
		this.setMarker(null);
	}

	private buildGround() {
		const flat = (g: THREE.BufferGeometry) => g.rotateX(-Math.PI / 2);
		const zones: [number, number, number][] = [
			[0, RING.center, 0x4a2e2e],
			[RING.center, RING.mid, 0x46432f],
			[RING.mid, MAP_RADIUS, 0x2f4634]
		];
		for (const [r0, r1, color] of zones) {
			const g = r0 === 0 ? new THREE.CircleGeometry(r1, 96) : new THREE.RingGeometry(r0, r1, 96);
			this.scene.add(new THREE.Mesh(flat(g), new THREE.MeshStandardMaterial({ color, roughness: 1 })));
		}
		for (const r of [RING.center, RING.mid, MAP_RADIUS]) {
			const line = new THREE.Mesh(
				flat(new THREE.RingGeometry(r - 0.25, r + 0.25, 128)),
				new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 })
			);
			line.position.y = 0.02;
			this.scene.add(line);
		}
		const outside = new THREE.Mesh(
			flat(new THREE.RingGeometry(MAP_RADIUS, MAP_RADIUS + 200, 64)),
			new THREE.MeshStandardMaterial({ color: 0x1a2027, roughness: 1 })
		);
		this.scene.add(outside);

		// Static props give the eye fixed landmarks, which reduces perceived motion.
		const rng = new Rng(1234);
		const rock = new THREE.InstancedMesh(
			new THREE.DodecahedronGeometry(0.8, 0),
			new THREE.MeshStandardMaterial({ color: 0x6d7580, roughness: 1, flatShading: true }),
			220
		);
		const tree = new THREE.InstancedMesh(
			new THREE.ConeGeometry(0.9, 2.6, 7).translate(0, 1.3, 0),
			new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 1, flatShading: true }),
			160
		);
		const m = new THREE.Matrix4();
		for (let i = 0; i < rock.count; i++) {
			const r = Math.sqrt(rng.next()) * MAP_RADIUS;
			const a = rng.range(0, Math.PI * 2);
			const s = rng.range(0.4, 1.4);
			m.compose(
				new THREE.Vector3(Math.cos(a) * r, 0.2 * s, Math.sin(a) * r),
				new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, 6), 0)),
				new THREE.Vector3(s, s * 0.7, s)
			);
			rock.setMatrixAt(i, m);
		}
		for (let i = 0; i < tree.count; i++) {
			const r = RING.mid + rng.next() * (MAP_RADIUS - RING.mid);
			const a = rng.range(0, Math.PI * 2);
			const s = rng.range(0.7, 1.3);
			m.compose(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
			tree.setMatrixAt(i, m);
		}
		this.scene.add(rock, tree);
	}

	resize(width: number, height: number) {
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		// Portrait phones: pull back so roughly the same ground width stays visible.
		this.cameraScale = Math.max(1, 0.95 / this.camera.aspect);
		this.camera.updateProjectionMatrix();
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

	private fighterView(f: Fighter, isPlayer: boolean): FighterView {
		let v = this.fighters.get(f.id);
		if (v) return v;
		const root = new THREE.Group();
		const body = new THREE.Mesh(
			this.geo.capsule,
			new THREE.MeshStandardMaterial({ color: f.color, roughness: 0.6 })
		);
		body.position.y = 0.95;
		const nose = new THREE.Mesh(this.geo.nose, this.mat.nose);
		nose.position.set(0, 1.2, -0.6);
		const bubble = new THREE.Mesh(this.geo.bubble, this.mat.bubble);
		bubble.position.y = 0.95;
		const bar = this.makeBar(1.6, 2.5);
		if (isPlayer) bar.fill.material = this.mat.barHp;
		const spin = new THREE.Group();
		spin.add(body, nose);
		root.add(spin, bubble, bar.group);
		this.scene.add(root);
		v = { root, spin, body, nose, bubble, bar };
		this.fighters.set(f.id, v);
		return v;
	}

	private monsterView(m: Monster): MonsterView {
		let v = this.monsters.get(m.id);
		if (v) return v;
		const look = MONSTER_LOOK[m.tier];
		const root = new THREE.Group();
		const body = new THREE.Mesh(
			look.geo(),
			// Training dummies read as straw-coloured and inert.
			new THREE.MeshStandardMaterial({ color: m.passive ? 0xc9b37e : look.color, roughness: 0.7, flatShading: true })
		);
		body.position.y = m.radius + 0.1;
		const bar = this.makeBar(m.radius * 1.8, m.radius * 2 + 0.6);
		root.add(body, bar.group);
		this.scene.add(root);
		v = { root, body, bar };
		this.monsters.set(m.id, v);
		return v;
	}

	private statusGlow(mat: THREE.MeshStandardMaterial, u: Fighter | Monster, hitK: number) {
		const s = u.status;
		if (hitK > 0) mat.emissive.setRGB(hitK, hitK, hitK);
		else if (s.burnTime > 0) mat.emissive.setHex(0x803000);
		else if (s.bleedStacks > 0) mat.emissive.setHex(0x600010);
		else mat.emissive.setHex(0x000000);
	}

	/** `alpha` interpolates between the previous and current sim tick. */
	render(world: World, prev: Map<number, Vec2>, alpha: number, focusId: number | null, dt: number) {
		this.clock += dt;
		const lerpPos = (id: number, p: Vec2) => {
			const a = prev.get(id);
			return a ? { x: a.x + (p.x - a.x) * alpha, y: a.y + (p.y - a.y) * alpha } : p;
		};
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
			v.root.position.copy(toThree(p));
			v.spin.rotation.y = Math.atan2(-f.facing.x, f.facing.y);
			const k = hitK(f.id);
			this.statusGlow(v.body.material, f, k * 0.6);
			v.body.scale.set(1, f.dashTime > 0 ? 0.75 : 1, 1);
			v.bubble.visible = f.shield > 0.5;
			this.setBar(v.bar, f.hp / f.maxHp, f.shield / f.maxHp);
			if (f.id === focusId) focusPos = p;
		}
		for (const [id, v] of this.fighters) {
			if (seen.has(id)) continue;
			this.scene.remove(v.root);
			v.body.material.dispose();
			this.fighters.delete(id);
		}

		// Monsters
		seen.clear();
		for (const m of world.monsters) {
			seen.add(m.id);
			const v = this.monsterView(m);
			const p = lerpPos(m.id, m.pos);
			v.root.position.copy(toThree(p));
			const k = hitK(m.id);
			v.body.rotation.y = this.clock * 0.8 + m.id;
			v.body.position.y = m.radius + 0.1 + Math.sin(this.clock * 3 + m.id) * 0.08;
			v.body.scale.setScalar(1 + k * 0.25);
			this.statusGlow(v.body.material, m, k * 0.5);
			v.bar.group.visible = m.hp < m.maxHp - 0.01;
			this.setBar(v.bar, m.hp / m.maxHp, 0);
		}
		for (const [id, v] of this.monsters) {
			if (seen.has(id)) continue;
			this.scene.remove(v.root);
			v.body.geometry.dispose();
			v.body.material.dispose();
			this.monsters.delete(id);
		}

		// Projectiles
		seen.clear();
		for (const pr of world.projectiles) {
			seen.add(pr.id);
			let mesh = this.projectiles.get(pr.id);
			if (!mesh) {
				mesh =
					pr.kind === 'fireball'
						? new THREE.Mesh(this.geo.fireball, this.mat.fireball)
						: new THREE.Mesh(this.geo.arrow, this.mat.arrow);
				this.scene.add(mesh);
				this.projectiles.set(pr.id, mesh);
			}
			mesh.position.copy(toThree(lerpPos(pr.id, pr.pos), 1.1));
			mesh.rotation.y = Math.atan2(-pr.vel.x, pr.vel.y);
		}
		for (const [id, mesh] of this.projectiles) {
			if (seen.has(id)) continue;
			this.scene.remove(mesh);
			this.projectiles.delete(id);
		}

		// Pickups
		seen.clear();
		for (const pk of world.pickups) {
			seen.add(pk.id);
			let g = this.pickups.get(pk.id);
			if (!g) {
				const item = getItem(pk.itemId);
				const color = RARITY_COLOR[item.rarity];
				g = new THREE.Group();
				const box = new THREE.Mesh(
					this.geo.pickup,
					new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 })
				);
				box.position.y = 0.8;
				const beam = new THREE.Mesh(
					this.geo.beam,
					new THREE.MeshBasicMaterial({ color: TAG_INFO[item.tags[0]].color, transparent: true, opacity: 0.35, depthWrite: false })
				);
				beam.position.y = 3;
				g.add(box, beam);
				g.position.copy(toThree(pk.pos));
				this.scene.add(g);
				this.pickups.set(pk.id, g);
			}
			g.children[0].rotation.y = this.clock * 1.5;
		}
		for (const [id, g] of this.pickups) {
			if (seen.has(id)) continue;
			this.scene.remove(g);
			this.pickups.delete(id);
		}

		if (this.goal.visible) {
			const pulse = 1 + Math.sin(this.clock * 4) * 0.06;
			this.goal.children[0].scale.setScalar(this.goalRadius * pulse);
		}

		// Zone
		const z = world.zone;
		this.zoneWall.scale.set(Math.max(0.01, z.current.radius), 1, Math.max(0.01, z.current.radius));
		this.zoneWall.position.x = z.current.center.x;
		this.zoneWall.position.z = -z.current.center.y;
		const showNext = z.to.radius < z.current.radius - 0.5;
		this.nextRing.visible = showNext;
		if (showNext) {
			this.nextRing.scale.setScalar(Math.max(0.01, z.to.radius));
			this.nextRing.position.x = z.to.center.x;
			this.nextRing.position.z = -z.to.center.y;
		}

		this.playerMarker.visible = focusPos !== null && focusId !== null && world.fighters.some((f) => f.id === focusId && !f.bot);
		if (focusPos) this.playerMarker.position.set(focusPos.x, 0.05, -focusPos.y);

		// FX
		this.fx = this.fx.filter((e) => {
			e.life -= dt;
			if (e.life <= 0) {
				this.scene.remove(e.obj);
				e.obj.traverse((o) => {
					if (o instanceof THREE.Mesh) {
						o.geometry.dispose();
						(o.material as THREE.Material).dispose();
					}
				});
				return false;
			}
			e.tick(1 - e.life / e.max);
			return true;
		});

		// Camera: damped translation only.
		if (focusPos) {
			const target = toThree(focusPos);
			if (!this.focusReady) {
				this.focus.copy(target);
				this.focusReady = true;
			} else {
				this.focus.lerp(target, 1 - Math.exp(-FOLLOW_RATE * dt));
			}
		}
		this.camera.position.copy(this.focus).addScaledVector(CAMERA_OFFSET, this.cameraScale);
		this.camera.lookAt(this.focus);

		this.renderer.render(this.scene, this.camera);
	}

	worldToScreen(p: Vec2, height = 2): { x: number; y: number } | null {
		const v = toThree(p, height).project(this.camera);
		if (v.z > 1) return null;
		const el = this.renderer.domElement;
		return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
	}

	private addFx(obj: THREE.Object3D, duration: number, tick: (k: number) => void) {
		this.scene.add(obj);
		this.fx.push({ obj, life: duration, max: duration, tick });
		tick(0);
	}

	private groundRing(at: Vec2, inner: number, outer: number, color: number, start = 0, length = Math.PI * 2) {
		const mesh = new THREE.Mesh(
			new THREE.RingGeometry(inner, outer, 40, 1, start, length).rotateX(-Math.PI / 2),
			new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide })
		);
		mesh.position.copy(toThree(at, 0.08));
		return mesh;
	}

	handleEvents(events: readonly GameEvent[], playerId: number | null) {
		for (const e of events) {
			switch (e.type) {
				case 'hit':
					this.hitAt.set(e.target, this.clock);
					break;
				case 'attack': {
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
					const dx = e.to.x - e.from.x;
					const dy = e.to.y - e.from.y;
					const len = Math.hypot(dx, dy);
					const mesh = new THREE.Mesh(
						new THREE.PlaneGeometry(0.9, len).rotateX(-Math.PI / 2),
						new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.5, depthWrite: false })
					);
					mesh.position.copy(toThree({ x: e.from.x + dx / 2, y: e.from.y + dy / 2 }, 0.1));
					mesh.rotation.y = Math.atan2(-dx, dy);
					const mat = mesh.material;
					this.addFx(mesh, 0.3, (k) => {
						mat.opacity = 0.5 * (1 - k);
					});
					break;
				}
				case 'death': {
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
						new THREE.CylinderGeometry(1.2, 1.2, 4, 24, 1, true),
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
		this.renderer.dispose();
	}
}
