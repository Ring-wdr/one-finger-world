import {
	DT,
	MONSTER_TIERS,
	Rng,
	newBotBrain,
	summarizeBuild,
	type BotBrain,
	type BuildSummary,
	type Circle,
	type Fighter,
	type Monster,
	type NavState,
	type Pickup,
	type Projectile,
	type Status,
	type Vec2,
	type World
} from '@ofa/sim';
import type { MotionState, RosterEntry, Sample, SelfMessage, SelfState, FighterRecord, MonsterRecord } from '@ofa/net';

/** Snapshots as a `World` for the renderer and HUD (docs/multiplayer-server-design.md §11.4). */

export interface ViewWorld extends World {
	/** Fighters alive in the whole match, not just the ones in view. */
	aliveTotal: number;
	roster: ReadonlyMap<number, RosterEntry>;
}

/** The local fighter's exact state, merged over its snapshot record. */
export interface OwnState {
	self: SelfState;
	/** The latest `self` message; null before the first one. */
	build: SelfMessage | null;
	motion: MotionState;
	displayPos: Vec2;
}

const FIGHTER_RADIUS = 0.7;
/** Long enough for the renderer's dash squash to show while the flag is set. */
const DASHING_TIME = 0.1;

/** Bots are only ever tested for truthiness on the client; one shared brain stands in. */
const BOT_PLACEHOLDER: BotBrain = newBotBrain(new Rng(0));

const vec = (): Vec2 => ({ x: 0, y: 0 });
const circle = (): Circle => ({ center: vec(), radius: 0 });
const status = (): Status => ({ burnTime: 0, burnDps: 0, burnSrc: -1, bleedStacks: 0, bleedTime: 0, bleedPerStack: 0, bleedSrc: -1 });
const nav = (): NavState => ({
	anchor: vec(),
	window: 0,
	expect: 0,
	lastTick: -2,
	side: 1,
	steerObs: -1,
	steerSide: 1,
	detour: null,
	detourTime: 0,
	stuckCount: 0
});

function setVec(dst: Vec2, x: number, y: number): void {
	dst.x = x;
	dst.y = y;
}

function setCircle(dst: Circle, src: Circle): void {
	setVec(dst.center, src.center.x, src.center.y);
	dst.radius = src.radius;
}

/** Sets or clears an optional direction, keeping the object between frames while it stays set. */
function setDir(f: { moveDir: Vec2 | null }, x: number, y: number, on: boolean): void {
	if (!on) f.moveDir = null;
	else if (f.moveDir) setVec(f.moveDir, x, y);
	else f.moveDir = { x, y };
}

export class ViewWorldBuilder {
	private roster = new Map<number, RosterEntry>();
	private readonly fighters = new Map<number, Fighter>();
	private readonly monsters = new Map<number, Monster>();
	private readonly projectiles = new Map<number, Projectile>();
	private readonly pickups = new Map<number, Pickup>();
	private readonly weaponBuilds = new Map<string, BuildSummary>();
	private readonly ids = new Set<number>();
	private ownBuildKey: string | null = null;
	private ownBuild: BuildSummary | null = null;
	private readonly prev = new Map<number, Vec2>();
	private readonly world: ViewWorld = {
		seed: 0,
		rules: { spawnMonsters: false, zone: false, phases: false, endWhenOneLeft: false },
		time: 0,
		tick: 0,
		rng: new Rng(0),
		nextId: 1,
		phase: 1,
		fighters: [],
		monsters: [],
		projectiles: [],
		pickups: [],
		zone: { stage: 0, stageStart: 0, from: circle(), to: circle(), current: circle(), dps: 0, shrinking: false, timer: 0 },
		events: [],
		spawnTimer: 0,
		over: false,
		winner: null,
		aliveTotal: 0,
		roster: this.roster
	};

	setRoster(fighters: readonly RosterEntry[]): void {
		this.roster = new Map(fighters.map((r) => [r.id, r]));
		this.world.roster = this.roster;
	}

	/** World for the renderer: entities of `b`, positions of `a` in `prev`, own fighter at `own.displayPos`. */
	build(sample: Sample, selfId: number | null, own: OwnState | null): { world: ViewWorld; prev: Map<number, Vec2>; alpha: number } {
		const { a, b } = sample;
		const w = this.world;
		const prev = this.prev;
		prev.clear();
		for (const r of a.fighters) prev.set(r.id, r.pos);
		for (const r of a.monsters) prev.set(r.id, r.pos);
		for (const r of a.projectiles) prev.set(r.id, r.pos);
		for (const r of a.pickups) prev.set(r.id, r.pos);
		// Keep only ids that exist in both snapshots.
		const inB = this.ids;
		inB.clear();
		for (const r of b.fighters) inB.add(r.id);
		for (const r of b.monsters) inB.add(r.id);
		for (const r of b.projectiles) inB.add(r.id);
		for (const r of b.pickups) inB.add(r.id);
		for (const id of [...prev.keys()]) if (!inB.has(id)) prev.delete(id);

		w.fighters.length = 0;
		const ownWanted = own !== null && selfId !== null;
		let ownDrawn = false;
		inB.clear();
		for (const r of b.fighters) {
			const f = this.fighter(r.id);
			this.applyRecord(f, r);
			if (ownWanted && r.id === selfId) {
				this.applyOwn(f, own);
				prev.set(f.id, f.pos);
				ownDrawn = true;
			}
			inB.add(f.id);
			w.fighters.push(f);
		}
		if (ownWanted && !ownDrawn) {
			const f = this.fighter(selfId);
			this.applyOwn(f, own);
			prev.set(f.id, f.pos);
			inB.add(f.id);
			w.fighters.push(f);
		}
		this.prune(this.fighters, inB);

		w.monsters.length = 0;
		inB.clear();
		for (const r of b.monsters) {
			const m = this.monster(r);
			inB.add(m.id);
			w.monsters.push(m);
		}
		this.prune(this.monsters, inB);

		w.projectiles.length = 0;
		inB.clear();
		for (const r of b.projectiles) {
			let p = this.projectiles.get(r.id);
			if (!p) {
				p = {
					id: r.id, owner: 0, kind: r.kind, pos: vec(), sweepFrom: vec(), vel: vec(),
					life: 1, radius: 0.3, damage: 0, pierce: 0, hit: [], aoe: 0, forceBurn: false
				};
				this.projectiles.set(r.id, p);
			}
			p.kind = r.kind;
			setVec(p.pos, r.pos.x, r.pos.y);
			setVec(p.vel, Math.cos(r.angle) * r.speed, Math.sin(r.angle) * r.speed);
			inB.add(p.id);
			w.projectiles.push(p);
		}
		this.prune(this.projectiles, inB);

		w.pickups.length = 0;
		inB.clear();
		for (const r of b.pickups) {
			let p = this.pickups.get(r.id);
			if (!p) {
				p = { id: r.id, pos: vec(), itemId: r.itemId };
				this.pickups.set(r.id, p);
			}
			p.itemId = r.itemId;
			setVec(p.pos, r.pos.x, r.pos.y);
			inB.add(p.id);
			w.pickups.push(p);
		}
		this.prune(this.pickups, inB);

		const z = w.zone;
		z.stage = b.zone.stage;
		z.dps = b.zone.dps;
		z.timer = b.zone.timer;
		z.shrinking = b.zone.shrinking;
		setCircle(z.current, b.zone.current);
		setCircle(z.from, b.zone.current);
		setCircle(z.to, b.zone.next);

		w.phase = b.phase;
		w.tick = b.tick;
		w.time = b.tick * DT;
		w.over = b.over;
		w.winner = b.winner;
		w.aliveTotal = b.alive;
		return { world: w, prev, alpha: sample.alpha };
	}

	private prune<T>(map: Map<number, T>, keep: ReadonlySet<number>): void {
		for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
	}

	private fighter(id: number): Fighter {
		let f = this.fighters.get(id);
		if (!f) {
			const info = this.roster.get(id);
			f = {
				kind: 'fighter', id, name: info?.name ?? '', color: info?.color ?? '#ffffff', bot: null, nav: nav(),
				pos: vec(), radius: FIGHTER_RADIUS, hp: 1, maxHp: 1, alive: true, status: status(),
				facing: { x: 0, y: 1 }, moveDir: null, running: false, level: 1, xp: 0, items: [], runes: [],
				build: this.weaponBuild(null), shield: 0, sinceHurt: 0, attackCd: 0, attackQueued: 0, rootTime: 0,
				combo: 1, comboTimer: 0, dashCd: 0, dashCdMax: 1, dashTime: 0, dashDir: { x: 0, y: 1 }, dashHit: [],
				hasteBuff: 0, skillCds: {}, pendingDrafts: 0, offer: null, rerolls: 0, exchangeTokens: 0, kills: 0,
				placement: null, lastAttacker: null, lastAttackedAt: -999
			};
			this.fighters.set(id, f);
		}
		return f;
	}

	private weaponBuild(weapon: string | null): BuildSummary {
		const key = weapon ?? '';
		let b = this.weaponBuilds.get(key);
		if (!b) {
			b = summarizeBuild(weapon ? [weapon] : []);
			this.weaponBuilds.set(key, b);
		}
		return b;
	}

	private applyRecord(f: Fighter, r: FighterRecord): void {
		const info = this.roster.get(r.id);
		if (info) {
			f.name = info.name;
			f.color = info.color;
		}
		const fx = Math.cos(r.facing);
		const fy = Math.sin(r.facing);
		setVec(f.pos, r.pos.x, r.pos.y);
		setVec(f.facing, fx, fy);
		setDir(f, fx, fy, r.moving);
		f.running = r.running;
		f.hp = r.hp;
		f.maxHp = 1;
		f.shield = r.shield;
		f.dashTime = r.dashing ? DASHING_TIME : 0;
		f.status.burnTime = r.burning ? 1 : 0;
		f.status.bleedStacks = r.bleeding ? 1 : 0;
		f.bot = r.human ? null : BOT_PLACEHOLDER;
		f.build = this.weaponBuild(r.weapon);
		f.level = r.level;
	}

	private applyOwn(f: Fighter, own: OwnState): void {
		const { self, motion, build } = own;
		setVec(f.pos, own.displayPos.x, own.displayPos.y);
		setVec(f.facing, motion.facing.x, motion.facing.y);
		setDir(f, motion.moveDir?.x ?? 0, motion.moveDir?.y ?? 0, motion.moveDir !== null);
		f.running = motion.running;
		f.dashTime = motion.dashTime;
		f.dashCd = motion.dashCd;
		f.dashCdMax = motion.dashCdMax;
		f.hp = self.hp;
		f.maxHp = self.maxHp;
		f.shield = self.shield;
		f.xp = self.xp;
		f.level = self.level;
		f.kills = self.kills;
		f.bot = null;
		if (!build) return;
		f.items = build.items;
		f.runes = build.runes;
		f.offer = build.offer;
		f.pendingDrafts = build.pendingDrafts;
		f.rerolls = build.rerolls;
		f.exchangeTokens = build.exchangeTokens;
		const key = `${build.items.join(',')}|${build.runes.join(',')}`;
		if (key !== this.ownBuildKey) {
			this.ownBuildKey = key;
			this.ownBuild = summarizeBuild(build.items, build.runes);
		}
		f.build = this.ownBuild!;
	}

	private monster(r: MonsterRecord): Monster {
		let m = this.monsters.get(r.id);
		if (!m) {
			m = {
				kind: 'monster', id: r.id, pos: vec(), radius: 0, hp: 1, maxHp: 1, alive: true, status: status(),
				tier: r.tier, home: vec(), targetId: null, attackCd: 0, damage: 0, speed: 0, xp: 0, wander: vec(),
				wanderTimer: 0, returning: false, nav: nav(), passive: false
			};
			this.monsters.set(r.id, m);
		}
		m.tier = r.tier;
		m.passive = r.passive;
		m.radius = MONSTER_TIERS[r.tier].radius;
		setVec(m.pos, r.pos.x, r.pos.y);
		m.hp = r.hp;
		m.targetId = r.targetId;
		m.returning = r.returning;
		m.status.burnTime = r.burning ? 1 : 0;
		m.status.bleedStacks = r.bleeding ? 1 : 0;
		return m;
	}
}
