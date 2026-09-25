import {
	createWorld,
	dist,
	equip,
	gainXp,
	getItem,
	isInside,
	ITEMS,
	MAP_RADIUS,
	spawnFighter,
	spawnMonster,
	TAG_INFO,
	WEAPON_IDS,
	xpToNext,
	type Fighter,
	type GameEvent,
	type Tag,
	type Vec2,
	type World
} from '@ofa/sim';

export interface Marker {
	pos: Vec2;
	radius: number;
}

/** UI-side actions the sim can't observe; the HUD reports them. */
export type TutorialSignal = 'buildOpened';

interface StepDef {
	id: string;
	title: string;
	text: (t: Tutorial) => string;
	enter?: (t: Tutorial) => void;
	/** Runs after every sim tick while the step is active. */
	tick?: (t: Tutorial, events: readonly GameEvent[]) => void;
	done: (t: Tutorial, events: readonly GameEvent[]) => boolean;
	exit?: (t: Tutorial) => void;
	/** Open the draft sheet when the step begins. */
	draft?: boolean;
}

const attackLabel = (f: Fighter) => (f.build.attack === 'ranged' ? '원거리' : '근접');

function curatedOffer(t: Tutorial, tag: Tag): string[] {
	const pool = ITEMS.filter((i) => i.kind === 'stat' && i.tags.includes(tag)).map((i) => i.id);
	return t.world.rng.shuffle(pool).slice(0, 3);
}

const STEPS: StepDef[] = [
	{
		id: 'walk',
		title: '이동',
		text: () => '화면 아무 곳이나 누른 채 드래그하면 그 방향으로 걷습니다. 노란 원까지 걸어가세요.',
		enter: (t) => t.setMarker({ x: 0, y: 9 }),
		done: (t) => t.atMarker()
	},
	{
		id: 'run',
		title: '달리기',
		text: () => '손가락을 멀리 끌면 달리기로 바뀝니다 (조이스틱이 노랗게 변해요). 원 쪽으로 달려 보세요.',
		enter: (t) => t.setMarker({ x: 14, y: 0 }),
		tick: (t) => {
			if (t.me.running && t.me.moveDir) t.runTime += 1 / 20;
		},
		done: (t) => t.runTime >= 1.2
	},
	{
		id: 'weapon',
		title: '무기 선택',
		text: () =>
			'무기가 기본 공격 방식을 정합니다. 대검·쌍단검은 근접 베기, 사냥활·화염 지팡이는 원거리 투사체예요. 하나 고르세요 (나중에 바꿀 수 있어요).',
		enter: (t) => t.offer([...WEAPON_IDS]),
		draft: true,
		done: (t) => t.me.build.weapon !== null,
		// If skipped, hand out a sword so later steps still make sense.
		exit: (t) => {
			if (!t.me.build.weapon) equip(t.world, t.me, 'greatsword');
			t.clearOffer();
		}
	},
	{
		id: 'attack',
		title: '공격',
		text: (t) =>
			`탭하면 가장 가까운 적을 자동으로 조준해 공격합니다. 허수아비 3개를 부수세요.${
				t.me.build.attack === 'melee' ? ' 근접 무기는 가까이 붙어야 닿아요.' : ''
			}`,
		enter: (t) => {
			for (const o of [{ x: 4, y: 3 }, { x: -4, y: 3 }, { x: 0, y: 6 }]) t.spawnDummy(o, 40);
		},
		done: (t) => t.targetsDead()
	},
	{
		id: 'combo',
		title: '3연타',
		text: () => '탭을 끊지 말고 빠르게 이어서 누르면 3연타 콤보가 됩니다. 3타째는 더 강하고 범위도 넓어요. 3타까지 이어 보세요.',
		enter: (t) => t.spawnDummy({ x: 0, y: 3 }, 600),
		done: (_t, events) =>
			events.some((e) => e.type === 'attack' && e.unit === _t.playerId && e.combo === 3)
	},
	{
		id: 'dash',
		title: '대시',
		text: () => '빠르게 두 번 스와이프하면 대시! 대시 중에는 잠깐 무적입니다. 대시로 원까지 이동하세요. (키보드: Shift)',
		enter: (t) => t.setMarker({ x: -10, y: 0 }, 2.5),
		tick: (t, events) => {
			if (events.some((e) => e.type === 'dash' && e.unit === t.playerId)) t.dashed = true;
		},
		done: (t) => t.dashed && t.atMarker()
	},
	{
		id: 'hunt',
		title: '사냥',
		text: () => '몬스터를 쓰러뜨리면 경험치를 얻습니다. 몬스터 4마리를 사냥하세요. 이번엔 반격해요!',
		enter: (t) => {
			for (let i = 0; i < 4; i++) {
				const a = (i / 4) * Math.PI * 2;
				t.spawnMonsterAt({ x: Math.cos(a) * 7, y: Math.sin(a) * 7 });
			}
		},
		done: (t) => t.targetsDead(),
		exit: (t) => {
			// Guarantee the level-up the next step needs.
			gainXp(t.world, t.me, Math.max(0, xpToNext(t.me.level) - t.me.xp));
		}
	},
	{
		id: 'synergy',
		title: '레벨업 · 시너지',
		text: (t) => {
			const info = TAG_INFO[t.focusTag];
			return `레벨업하면 오른쪽 아래 버튼으로 카드 3장 중 1장을 고릅니다. 같은 태그가 3개 모이면 시너지가 켜져요. ${info.icon} ${info.label} 카드를 2장 골라 시너지를 켜 보세요.`;
		},
		enter: (t) => {
			t.focusTag = getItem(t.me.build.weapon ?? WEAPON_IDS[0]).tags[0];
			t.me.pendingDrafts = 2;
			t.me.offer = curatedOffer(t, t.focusTag);
		},
		draft: true,
		tick: (t) => {
			// After each pick the sim rolls a random offer; keep it on-topic.
			const offer = t.me.offer;
			if (offer && !offer.every((id) => getItem(id).tags.includes(t.focusTag))) {
				t.me.offer = curatedOffer(t, t.focusTag);
			}
		},
		done: (t) => t.me.build.tiers[t.focusTag] >= 1,
		exit: (t) => t.clearOffer()
	},
	{
		id: 'swap',
		title: '무기 교체',
		text: (t) =>
			`드래프트에 무기 카드가 나오면 지금 무기와 교체할 수 있어요. 근접↔원거리를 바꾸는 방법입니다. ${
				t.me.build.attack === 'melee' ? '원거리' : '근접'
			} 무기로 바꿔 보세요. 다른 아이템은 그대로 남아요.`,
		enter: (t) => {
			t.swapFrom = t.me.build.weapon;
			const mode = t.me.build.attack;
			t.offer(WEAPON_IDS.filter((id) => getItem(id).attack !== mode));
		},
		draft: true,
		done: (t) => t.me.build.weapon !== t.swapFrom,
		exit: (t) => t.clearOffer()
	},
	{
		id: 'zone',
		title: '자기장',
		text: () => '파란 벽 바깥에 있으면 계속 피해를 받습니다. 본 게임에서는 이 안전지대가 점점 줄어들어요. 벽 안쪽으로 들어가세요!',
		enter: (t) => {
			const center = { x: t.me.pos.x + 13, y: t.me.pos.y };
			t.setZone(center, 6, 4);
			t.markAt(center, 6);
		},
		done: (t) => isInside(t.world.zone, t.me.pos),
		exit: (t) => t.setZone({ x: 0, y: 0 }, MAP_RADIUS + 10, 2)
	},
	{
		id: 'duel',
		title: '다른 플레이어',
		text: (t) =>
			`적 플레이어(봇)가 나타났습니다! 활을 쓰는 원거리 적이에요. ${
				t.me.build.attack === 'melee' ? '대시로 파고들어' : '거리를 벌리며'
			} 쓰러뜨리세요. (지금 내 무기: ${attackLabel(t.me)})`,
		enter: (t) => {
			const bot = spawnFighter(t.world, {
				name: '연습 상대',
				color: '#ef5350',
				pos: { x: t.me.pos.x + 11, y: t.me.pos.y + 4 },
				bot: true,
				aggressive: true
			});
			bot.offer = null;
			bot.pendingDrafts = 0;
			equip(t.world, bot, 'hunting_bow');
			equip(t.world, bot, 'stout_heart');
			bot.hp = bot.maxHp * 0.6;
			t.targets = [bot.id];
		},
		done: (t) => t.targetsDead()
	},
	{
		id: 'loot',
		title: '전리품',
		text: () => '적을 쓰러뜨리면 그 빌드에서 아이템 1개가 떨어집니다 (무기는 제외). 빛기둥으로 가서 주우세요.',
		enter: (t) => {
			const drop = t.world.pickups[0];
			if (drop) t.markAt(drop.pos, 1.6);
		},
		done: (t, events) =>
			t.world.pickups.length === 0 || events.some((e) => e.type === 'pickup' && e.unit === t.playerId)
	},
	{
		id: 'build',
		title: '빌드 확인',
		text: () =>
			'빌드 버튼을 누르면 태그별 시너지, 스탯, 아이템을 볼 수 있어요. 본 게임에서는 페이즈마다 교환권이 생겨 안 맞는 아이템을 버리고 새로 뽑을 수 있습니다. 빌드 창을 열어 보세요.',
		enter: (t) => {
			t.me.exchangeTokens = Math.max(1, t.me.exchangeTokens);
		},
		done: (t) => t.signals.has('buildOpened')
	}
];

/**
 * Scripted, sandboxed walkthrough. Pure logic (no DOM/three), so it can be driven headlessly.
 * Call `afterStep(world.events)` after every sim tick.
 */
export class Tutorial {
	readonly world: World;
	readonly playerId: number;
	index = 0;
	finished = false;
	marker: Marker | null = null;
	/** Units the current step asks the player to defeat. */
	targets: number[] = [];
	runTime = 0;
	dashed = false;
	focusTag: Tag = 'melee';
	swapFrom: string | null = null;
	readonly signals = new Set<TutorialSignal>();

	constructor(seed = 1) {
		const { world, playerId } = createWorld({ seed, fighters: 1, playerName: '나', sandbox: true });
		this.world = world;
		this.playerId = playerId!;
		// The tutorial hands out picks itself; nothing pending and no rerolls to derail curated offers.
		this.me.offer = null;
		this.me.pendingDrafts = 0;
		this.me.rerolls = 0;
		STEPS[0].enter?.(this);
	}

	get me(): Fighter {
		return this.world.fighters.find((f) => f.id === this.playerId)!;
	}

	get total() {
		return STEPS.length;
	}

	get step() {
		return STEPS[Math.min(this.index, STEPS.length - 1)];
	}

	get stepId() {
		return this.finished ? 'done' : this.step.id;
	}

	get title() {
		return this.step.title;
	}

	get text() {
		return this.step.text(this);
	}

	/** Whether the draft sheet should pop open for the current step. */
	get wantsDraft() {
		return !this.finished && !!this.step.draft && !!this.me.offer;
	}

	signal(s: TutorialSignal) {
		this.signals.add(s);
	}

	/** Returns true when a new step (or the ending) began. */
	afterStep(events: readonly GameEvent[]): boolean {
		if (this.finished) return false;
		const me = this.me;
		// Nobody fails the tutorial: HP never drops below a third.
		if (me.alive && me.hp < me.maxHp * 0.35) me.hp = me.maxHp * 0.35;
		this.step.tick?.(this, events);
		if (!this.step.done(this, events)) return false;
		this.advance();
		return true;
	}

	skip() {
		if (!this.finished) this.advance();
	}

	private advance() {
		this.step.exit?.(this);
		// Whatever this step spawned (dummies, skipped monsters or a bot) leaves with it.
		this.clearTargets();
		this.marker = null;
		this.targets = [];
		this.index += 1;
		if (this.index >= STEPS.length) {
			this.finished = true;
			return;
		}
		this.step.enter?.(this);
	}

	// ── Helpers for step scripts

	/** Marker relative to the player's current position. */
	setMarker(offset: Vec2, radius = 1.8) {
		this.markAt({ x: this.me.pos.x + offset.x, y: this.me.pos.y + offset.y }, radius);
	}

	markAt(pos: Vec2, radius = 1.8) {
		this.marker = { pos: { ...pos }, radius };
	}

	atMarker() {
		return !!this.marker && dist(this.me.pos, this.marker.pos) <= this.marker.radius;
	}

	offer(ids: string[]) {
		this.me.offer = ids;
		this.me.pendingDrafts = 1;
	}

	clearOffer() {
		this.me.offer = null;
		this.me.pendingDrafts = 0;
	}

	spawnDummy(offset: Vec2, hp: number) {
		const m = spawnMonster(
			this.world,
			2,
			{ x: this.me.pos.x + offset.x, y: this.me.pos.y + offset.y },
			{ passive: true, hp, xp: 0 }
		);
		this.targets.push(m.id);
	}

	spawnMonsterAt(offset: Vec2) {
		const m = spawnMonster(this.world, 1, { x: this.me.pos.x + offset.x, y: this.me.pos.y + offset.y }, { hp: 28 });
		this.targets.push(m.id);
	}

	targetsDead() {
		return this.targets.every((id) => {
			const u = this.world.monsters.find((m) => m.id === id) ?? this.world.fighters.find((f) => f.id === id);
			return !u || !u.alive;
		});
	}

	clearTargets() {
		for (const m of this.world.monsters) if (this.targets.includes(m.id)) m.alive = false;
		for (const f of this.world.fighters) if (this.targets.includes(f.id)) f.alive = false;
		this.world.monsters = this.world.monsters.filter((m) => m.alive);
	}

	setZone(center: Vec2, radius: number, dps: number) {
		const circle = { center: { ...center }, radius };
		const z = this.world.zone;
		z.from = circle;
		z.to = { center: { ...center }, radius };
		z.current = { center: { ...center }, radius };
		z.dps = dps;
		z.shrinking = false;
	}
}
