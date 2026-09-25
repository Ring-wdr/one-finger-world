import {
	getItem,
	MAP_RADIUS,
	PHASE_INFO,
	RING,
	SKILLS,
	STAT_INFO,
	summarizeBuild,
	SYNERGY_THRESHOLDS,
	TAG_INFO,
	TAGS,
	xpToNext,
	type BuildSummary,
	type Command,
	type Fighter,
	type GameEvent,
	type ItemDef,
	type StatMod,
	type World,
	dist
} from '@ofa/sim';
import type { InputFeedbackEvent } from '../input/types';
import { INPUT_THRESHOLD_PRESETS, type InputThresholdPresetId } from '../input/inputThresholdOptions';
import type { Renderer } from '../render/Renderer';

export interface HudCallbacks {
	command: (cmd: Command) => void;
	start: () => void;
	startTutorial: () => void;
	toMenu: () => void;
	restart: () => void;
	spectateNext: () => void;
	skipTutorialStep: () => void;
	buildOpened: () => void;
	setInputPreset: (id: InputThresholdPresetId) => void;
	inputPreset: () => InputThresholdPresetId | null;
}

/** What the HUD needs from the tutorial director (kept structural to avoid a dependency). */
export interface TutorialView {
	index: number;
	total: number;
	title: string;
	text: string;
	stepId: string;
}

export type HudMode = 'match' | 'tutorial';

const RARITY_LABEL = { common: '일반', rare: '희귀', legendary: '전설' } as const;
const KIND_LABEL = { weapon: '무기', stat: '스탯', skill: '스킬', bridge: '브릿지' } as const;
const ATTACK_LABEL = { melee: '근접 베기', ranged: '원거리 투사체' } as const;

const HINTS_KEY = 'ofa.hints.v1';
const HINT_SECONDS = 9;

function loadSeenHints(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(HINTS_KEY) ?? '[]') as string[]);
	} catch {
		return new Set();
	}
}

function saveSeenHints(seen: Set<string>) {
	try {
		localStorage.setItem(HINTS_KEY, JSON.stringify([...seen]));
	} catch {
		// Hints just repeat next time if storage is unavailable.
	}
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (html) el.innerHTML = html;
	return el;
};

function setText(el: HTMLElement, text: string) {
	if (el.textContent !== text) el.textContent = text;
}

function formatMod(m: StatMod) {
	const info = STAT_INFO[m.stat];
	const sign = m.value >= 0 ? '+' : '−';
	const abs = Math.abs(m.value);
	const v = info.percent ? `${Math.round(abs * 100)}%` : `${+abs.toFixed(1)}`;
	return `<li class="${m.value >= 0 ? 'pos' : 'neg'}">${sign}${v} ${info.label}</li>`;
}

function tagChip(tag: (typeof TAGS)[number], text: string, extra = '') {
	const t = TAG_INFO[tag];
	return `<span class="tag ${extra}" style="--c:${t.color}">${t.icon} ${t.label}${text}</span>`;
}

function itemDetail(item: ItemDef) {
	let desc = '';
	if (item.attack) desc = `<div class="desc weapon">🗡 기본 공격: ${ATTACK_LABEL[item.attack]}</div>`;
	if (item.skill) desc = `<div class="desc">⚡ ${SKILLS[item.skill].name}: ${SKILLS[item.skill].desc}</div>`;
	if (item.bridge) {
		const { from, to, convert } = item.bridge;
		desc = `<div class="desc">🔗 ${TAG_INFO[from].label} 개수의 절반이 ${TAG_INFO[to].label}로도 계산 · ${STAT_INFO[convert.from].label} → ${STAT_INFO[convert.to].label} 전환</div>`;
	}
	return `<ul class="mods">${item.mods.map(formatMod).join('')}</ul>${desc}`;
}

export class Hud {
	private readonly el = {} as Record<string, HTMLElement>;
	private readonly minimap: HTMLCanvasElement;
	private draftOpen = false;
	private buildOpen = false;
	private draftKey = '';
	private buildKey = '';
	private tagKey = '';
	private minimapTimer = 0;
	private gameOverShown = false;
	private spectating = false;
	private seenHints = loadSeenHints();
	private hintQueue: { id: string; text: string }[] = [];
	private hintShowing: string | null = null;
	private mode: HudMode = 'match';
	private tutKey = '';
	private hintTimer = 0;

	constructor(
		root: HTMLElement,
		private readonly renderer: Renderer,
		private readonly cb: HudCallbacks
	) {
		root.innerHTML = `
			<div class="top">
				<div class="me">
					<div class="lv"><span data-k="level">Lv 1</span><span data-k="kills" class="kills"></span></div>
					<div class="bar hp"><i data-k="hp"></i><b data-k="shield"></b><span data-k="hpText"></span></div>
					<div class="bar xp"><i data-k="xp"></i></div>
				</div>
				<div class="match">
					<div data-k="phase" class="phase"></div>
					<div data-k="zone" class="zone"></div>
					<div data-k="alive" class="alive"></div>
				</div>
				<canvas class="minimap" width="240" height="240"></canvas>
			</div>
			<div class="feed" data-k="feed"></div>
			<div class="toasts" data-k="toasts"></div>
			<div class="tut" data-k="tut"></div>
			<div class="tagbar" data-k="tagbar"></div>
			<div class="actions">
				<button class="btn build" data-k="buildBtn">빌드</button>
				<button class="btn levelup" data-k="levelBtn">레벨업</button>
			</div>
			<div class="dash-cd" data-k="dashCd"></div>
			<div class="joystick" data-k="joy"><div class="knob" data-k="knob"></div></div>
			<div class="sheet draft" data-k="draft"></div>
			<div class="sheet buildpanel" data-k="build"></div>
			<div class="overlay" data-k="overlay"></div>
			<div class="floaters" data-k="floaters"></div>
			<div class="hint" data-k="hint"></div>
		`;
		for (const node of root.querySelectorAll<HTMLElement>('[data-k]')) this.el[node.dataset.k!] = node;
		this.minimap = root.querySelector('.minimap')!;

		this.el.levelBtn.addEventListener('click', () => this.toggleDraft());
		this.el.buildBtn.addEventListener('click', () => this.toggleBuild());
		this.el.hint.addEventListener('click', () => this.dismissHint());
		this.showStart();
	}

	// ── Overlays

	showStart() {
		const o = this.el.overlay;
		o.className = 'overlay show';
		o.innerHTML = `
			<div class="panel">
				<h1>One Finger Royale</h1>
				<p class="sub">한 손가락 3D 육성 배틀로얄 · 싱글 프로토타입 (봇 11명)</p>
				<ul class="howto">
					<li><b>시작 무기</b>로 근접/원거리가 정해집니다. 드래프트의 무기 카드로 교체 가능</li>
					<li><b>탭</b> 공격 (자동 조준 · 3연타)</li>
					<li><b>드래그</b> 이동 · 멀리 끌면 달리기</li>
					<li><b>빠르게 두 번 스와이프</b> 대시 (무적)</li>
					<li><b>레벨업</b> 버튼으로 3장 중 1장 선택 — 같은 태그 3·5개에서 시너지 발동</li>
					<li>외곽은 안전·저효율, 중앙은 위험·고효율. 자기장은 따로 줄어듭니다.</li>
				</ul>
				<p class="keys">키보드: WASD 이동 · Space 공격 · Shift 대시 · E 드래프트 · 1/2/3 선택 · R 리롤 · B 빌드</p>
				<div class="row menu">
					<button class="btn big" data-act="tutorial">📘 튜토리얼<small>조작·빌드 단계별 연습 (약 3분)</small></button>
					<button class="btn big primary" data-act="start">⚔ 본 게임<small>봇 11명과 배틀로얄</small></button>
				</div>
				<div class="row presets">
					<span>입력 감도</span>
					${(Object.keys(INPUT_THRESHOLD_PRESETS) as InputThresholdPresetId[])
						.map(
							(id) =>
								`<button class="btn tiny ${this.cb.inputPreset() === id ? 'on' : ''}" data-preset="${id}">${INPUT_THRESHOLD_PRESETS[id].label}</button>`
						)
						.join('')}
				</div>
				<button class="btn tiny ghost" data-act="hints">본 게임 도움말 힌트 다시 보기</button>
			</div>`;
		o.querySelectorAll<HTMLElement>('[data-preset]').forEach((el) =>
			el.addEventListener('click', () => {
				this.cb.setInputPreset(el.dataset.preset as InputThresholdPresetId);
				o.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b === el));
			})
		);
		o.querySelector('[data-act=start]')!.addEventListener('click', () => {
			o.className = 'overlay';
			this.cb.start();
		});
		o.querySelector('[data-act=tutorial]')!.addEventListener('click', () => {
			o.className = 'overlay';
			this.cb.startTutorial();
		});
		o.querySelector<HTMLButtonElement>('[data-act=hints]')!.addEventListener('click', (ev) => {
			this.seenHints.clear();
			saveSeenHints(this.seenHints);
			const btn = ev.currentTarget as HTMLButtonElement;
			btn.textContent = '힌트 초기화됨';
			btn.disabled = true;
		});
	}

	reset() {
		this.gameOverShown = false;
		this.spectating = false;
		this.draftOpen = false;
		this.buildOpen = false;
		this.draftKey = '';
		this.buildKey = '';
		this.tagKey = '';
		this.el.overlay.className = 'overlay';
		this.el.feed.innerHTML = '';
		this.el.toasts.innerHTML = '';
		this.hintQueue = [];
		this.dismissHint();
		this.tutKey = '';
		this.el.tut.innerHTML = '';
	}

	setMode(mode: HudMode) {
		this.mode = mode;
		document.querySelector('#hud')?.classList.toggle('mode-tutorial', mode === 'tutorial');
	}

	// ── Tutorial mode

	updateTutorial(t: TutorialView | null) {
		if (!t || this.mode !== 'tutorial') return;
		const key = `${t.stepId}|${t.text}`;
		if (key === this.tutKey) return;
		this.tutKey = key;
		const done = t.stepId === 'done';
		const pct = Math.round(((done ? t.total : t.index) / t.total) * 100);
		this.el.tut.innerHTML = `
			<div class="tut-head">
				<span>튜토리얼 ${done ? t.total : t.index + 1}/${t.total} · <b>${done ? '완료' : t.title}</b></span>
				<div class="row">
					${done ? '' : '<button class="btn tiny" data-act="skip">건너뛰기</button>'}
					<button class="btn tiny" data-act="exit">나가기</button>
				</div>
			</div>
			<div class="tut-bar"><i style="width:${pct}%"></i></div>
			<p>${done ? '모든 단계를 마쳤어요!' : t.text}</p>`;
		this.el.tut.querySelector('[data-act=skip]')?.addEventListener('click', () => this.cb.skipTutorialStep());
		this.el.tut.querySelector('[data-act=exit]')!.addEventListener('click', () => this.cb.toMenu());
		if (!done) this.el.tut.classList.remove('flash'), void this.el.tut.offsetWidth, this.el.tut.classList.add('flash');
	}

	showTutorialDone() {
		const o = this.el.overlay;
		this.toggleDraft(false);
		this.toggleBuild(false);
		o.className = 'overlay show';
		o.innerHTML = `
			<div class="panel">
				<h1>🎓 튜토리얼 완료!</h1>
				<p class="sub">본 게임에서는 자기장이 점점 줄어들고, 11명의 봇과 최후의 1인을 가립니다.</p>
				<ul class="howto">
					<li>외곽은 안전하지만 저효율, 중앙은 위험하지만 고효율</li>
					<li>페이즈마다 드래프트 자원이 바뀝니다: 스탯 → 스킬 → 전설(브릿지)</li>
					<li>처치하면 상대 아이템 1개가 떨어져요</li>
				</ul>
				<div class="row">
					<button class="btn" data-act="again">튜토리얼 다시</button>
					<button class="btn" data-act="menu">메뉴</button>
					<button class="btn primary" data-act="start">본 게임 시작</button>
				</div>
			</div>`;
		o.querySelector('[data-act=again]')!.addEventListener('click', () => this.cb.startTutorial());
		o.querySelector('[data-act=menu]')!.addEventListener('click', () => this.cb.toMenu());
		o.querySelector('[data-act=start]')!.addEventListener('click', () => this.cb.start());
	}

	/** Called when a match begins: the first decision is the starting weapon. */
	onMatchStart() {
		this.toggleDraft(true);
		this.hint(
			'weapon',
			'먼저 시작 무기를 고르세요. 대검·쌍단검은 근접, 사냥활·화염 지팡이는 원거리 기본 공격입니다. 나중에 드래프트의 무기 카드로 바꿀 수 있어요.'
		);
	}

	// ── Tutorial hints: each shows once (per browser), when it becomes relevant.

	private hint(id: string, text: string) {
		// The tutorial mode has its own step panel; one-off hints are for real matches.
		if (this.mode !== 'match' || this.seenHints.has(id)) return;
		this.seenHints.add(id);
		saveSeenHints(this.seenHints);
		this.hintQueue.push({ id, text });
	}

	private dismissHint() {
		this.hintTimer = 0;
		this.hintShowing = null;
		this.el.hint.classList.remove('show');
	}

	private tickHints(dt: number) {
		if (this.hintTimer > 0) {
			this.hintTimer -= dt;
			if (this.hintTimer <= 0) this.dismissHint();
			return;
		}
		const next = this.hintQueue.shift();
		if (!next) return;
		this.el.hint.innerHTML = `<b>💡 튜토리얼</b><span>${next.text}</span><small>탭해서 닫기</small>`;
		this.el.hint.classList.add('show');
		this.hintShowing = next.id;
		this.hintTimer = HINT_SECONDS;
	}

	private showGameOver(world: World, me: Fighter) {
		this.gameOverShown = true;
		const won = world.winner === me.id;
		const o = this.el.overlay;
		o.className = 'overlay show';
		const items = me.items.map((id) => getItem(id).name).join(', ') || '없음';
		o.innerHTML = `
			<div class="panel">
				<h1>${won ? '🏆 최후의 1인!' : `#${me.placement} 탈락`}</h1>
				<p class="sub">Lv ${me.level} · 처치 ${me.kills} · ${Math.floor(world.time)}초 생존</p>
				<div class="tags">${TAGS.filter((t) => me.build.tagCounts[t] > 0)
					.map((t) => tagChip(t, ` ${me.build.tagCounts[t]}`, me.build.tiers[t] ? 'on' : ''))
					.join('')}</div>
				<p class="items">${items}</p>
				<div class="row">
					<button class="btn" data-act="menu">메뉴</button>
					<button class="btn primary" data-act="restart">다시 하기</button>
					${world.over ? '' : '<button class="btn" data-act="spectate">관전</button>'}
				</div>
			</div>`;
		o.querySelector('[data-act=restart]')!.addEventListener('click', () => this.cb.restart());
		o.querySelector('[data-act=menu]')!.addEventListener('click', () => this.cb.toMenu());
		o.querySelector('[data-act=spectate]')?.addEventListener('click', () => {
			this.spectating = true;
			o.className = 'overlay spectate';
			o.innerHTML = `<div class="spectate-bar"><span>관전 중</span><button class="btn" data-act="next">다음</button><button class="btn primary" data-act="restart">다시 하기</button></div>`;
			o.querySelector('[data-act=next]')!.addEventListener('click', () => this.cb.spectateNext());
			o.querySelector('[data-act=restart]')!.addEventListener('click', () => this.cb.restart());
		});
	}

	// ── Draft & build sheets

	toggleDraft(force?: boolean) {
		this.draftOpen = force ?? !this.draftOpen;
		if (this.draftOpen) this.buildOpen = false;
		this.draftKey = '';
		this.buildKey = '';
	}

	toggleBuild(force?: boolean) {
		this.buildOpen = force ?? !this.buildOpen;
		if (this.buildOpen) this.cb.buildOpened();
		if (this.buildOpen) this.draftOpen = false;
		this.buildKey = '';
		this.draftKey = '';
	}

	/** Keyboard shortcuts for UI. Returns true when consumed. */
	handleKey(key: string, me: Fighter | undefined): boolean {
		if (!me) return false;
		if (key === 'e') return this.toggleDraft(), true;
		if (key === 'b') return this.toggleBuild(), true;
		if (this.draftOpen && me.offer) {
			if (key === 'r') return this.cb.command({ type: 'reroll' }), true;
			const i = ['1', '2', '3'].indexOf(key);
			if (i >= 0) return this.cb.command({ type: 'draft', index: i }), true;
		}
		if (key === 'escape') {
			this.toggleDraft(false);
			this.toggleBuild(false);
			return true;
		}
		return false;
	}

	private renderDraft(me: Fighter) {
		const sheet = this.el.draft;
		const show = this.draftOpen && !!me.offer && me.alive;
		sheet.classList.toggle('show', show);
		if (!show) {
			if (this.draftOpen && !me.offer) this.draftOpen = false;
			return;
		}
		const key = `${me.offer!.join()}|${me.rerolls}|${me.items.length}|${me.pendingDrafts}`;
		if (key === this.draftKey) return;
		this.draftKey = key;

		const now = me.build;
		const starter = !now.weapon;
		const current = now.weapon ? getItem(now.weapon) : null;
		if (current && me.offer!.some((id) => getItem(id).kind === 'weapon')) {
			this.hint(
				'weapon-swap',
				`무기 카드를 고르면 지금 무기(${current.name})와 교체됩니다. 근접↔원거리를 바꾸는 방법이에요. 교체해도 다른 아이템은 그대로 남습니다.`
			);
		}
		const cards = me.offer!.map((id, i) => {
			const item = getItem(id);
			const next = summarizeBuild([...me.items, id]);
			const tags = item.tags
				.map((t) => {
					const up = next.tiers[t] > now.tiers[t];
					return tagChip(t, ` ${now.tagCounts[t]}→${next.tagCounts[t]}`, up ? 'up' : '');
				})
				.join('');
			const bridged = TAGS.filter((t) => !item.tags.includes(t) && next.tagCounts[t] > now.tagCounts[t])
				.map((t) => tagChip(t, ` ${now.tagCounts[t]}→${next.tagCounts[t]}`, next.tiers[t] > now.tiers[t] ? 'up' : ''))
				.join('');
			const swap =
				item.kind === 'weapon' && current
					? `<div class="unlock swap">⇄ ${current.name} → ${item.name} 교체 (${ATTACK_LABEL[current.attack!]} → ${ATTACK_LABEL[item.attack!]})</div>`
					: '';
			const unlocks = TAGS.filter((t) => next.tiers[t] > now.tiers[t])
				.map((t) => `<div class="unlock">✦ ${TAG_INFO[t].label} ${next.tiers[t] === 1 ? 'I' : 'II'}: ${TAG_INFO[t].tiers[next.tiers[t] - 1]}</div>`)
				.join('');
			return `
				<button class="card ${item.rarity}" data-pick="${i}">
					<div class="kind">${KIND_LABEL[item.kind]} · ${RARITY_LABEL[item.rarity]}</div>
					<div class="name">${item.name}</div>
					<div class="tags">${tags}${bridged}</div>
					${itemDetail(item)}
					${swap}
					${unlocks}
				</button>`;
		});

		sheet.innerHTML = `
			<div class="sheet-head">
				<span>${starter ? '시작 무기 선택 — 기본 공격 방식이 정해집니다' : `레벨업 선택 ${me.pendingDrafts > 1 ? `(${me.pendingDrafts})` : ''}`}</span>
				<div class="row">
					${starter ? '' : `<button class="btn" data-act="reroll" ${me.rerolls > 0 ? '' : 'disabled'}>리롤 ${me.rerolls}</button>`}
					<button class="btn" data-act="close">닫기</button>
				</div>
			</div>
			<div class="cards">${cards.join('')}</div>`;
		sheet.querySelectorAll<HTMLElement>('[data-pick]').forEach((el) =>
			el.addEventListener('click', () => this.cb.command({ type: 'draft', index: Number(el.dataset.pick) }))
		);
		sheet.querySelector('[data-act=reroll]')?.addEventListener('click', () => this.cb.command({ type: 'reroll' }));
		sheet.querySelector('[data-act=close]')!.addEventListener('click', () => this.toggleDraft(false));
	}

	private renderBuild(me: Fighter) {
		const sheet = this.el.build;
		sheet.classList.toggle('show', this.buildOpen);
		if (!this.buildOpen) return;
		const key = `${me.items.join()}|${me.exchangeTokens}`;
		if (key === this.buildKey) return;
		this.buildKey = key;

		const b: BuildSummary = me.build;
		const s = b.stats;
		const synergies = TAGS.map((t) => {
			const info = TAG_INFO[t];
			const tiers = info.tiers
				.map((d, i) => `<div class="tier ${b.tiers[t] > i ? 'on' : ''}"><b>${SYNERGY_THRESHOLDS[i]}</b> ${d}</div>`)
				.join('');
			return `<div class="syn" style="--c:${info.color}"><div class="syn-h">${info.icon} ${info.label} <span>${b.tagCounts[t]}</span></div>${tiers}</div>`;
		}).join('');
		const items = me.items
			.map((id, i) => {
				const it = getItem(id);
				return `<li class="${it.rarity}"><span>${it.name}</span><span class="mini">${it.tags.map((t) => TAG_INFO[t].icon).join('')}</span>${
					me.exchangeTokens > 0 && it.kind !== 'weapon' ? `<button class="btn tiny" data-ex="${i}">교환</button>` : ''
				}</li>`;
			})
			.join('');
		const stat = (label: string, v: string) => `<div><span>${label}</span><b>${v}</b></div>`;
		sheet.innerHTML = `
			<div class="sheet-head">
				<span>빌드 · 교환권 ${me.exchangeTokens}</span>
				<button class="btn" data-act="close">닫기</button>
			</div>
			<div class="build-body">
				<div class="stats">
					${stat('무기', b.weapon ? `${getItem(b.weapon).name} (${ATTACK_LABEL[b.attack]})` : '맨손 (근접)')}
					${stat('피해', s.damage.toFixed(1))}
					${stat('공속', `${s.attackRate.toFixed(2)}/s`)}
					${stat('이속', s.moveSpeed.toFixed(1))}
					${stat('사거리', s.range.toFixed(1))}
					${stat('받는 피해', `${Math.round(s.damageTaken * 100)}%`)}
					${stat('치명타', `${Math.round(s.crit * 100)}%`)}
					${stat('흡혈', `${Math.round(s.lifesteal * 100)}%`)}
					${stat('재생', `${s.regen.toFixed(1)}/s`)}
					${stat('스킬', b.skills.map((k) => SKILLS[k].name).join(', ') || '-')}
				</div>
				<div class="syns">${synergies}</div>
				<p class="hint">교환: 아이템 1개를 버리고 즉시 드래프트 1회 (페이즈마다 1장 지급)</p>
				<ul class="items">${items || '<li>아직 없음</li>'}</ul>
			</div>`;
		sheet.querySelector('[data-act=close]')!.addEventListener('click', () => this.toggleBuild(false));
		sheet.querySelectorAll<HTMLElement>('[data-ex]').forEach((el) =>
			el.addEventListener('click', () => {
				this.cb.command({ type: 'exchange', itemIndex: Number(el.dataset.ex) });
				this.toggleDraft(true);
			})
		);
	}

	// ── Per-frame

	update(world: World, me: Fighter | undefined, focus: Fighter | undefined, dt: number) {
		if (!me) return;
		const e = this.el;
		setText(e.level, `Lv ${me.level}`);
		setText(e.kills, me.kills ? `⚔ ${me.kills}` : '');
		e.hp.style.width = `${(me.hp / me.maxHp) * 100}%`;
		e.shield.style.width = `${Math.min(1, me.shield / me.maxHp) * 100}%`;
		setText(e.hpText, `${Math.ceil(me.hp)} / ${Math.round(me.maxHp)}`);
		e.xp.style.width = `${(me.xp / xpToNext(me.level)) * 100}%`;

		const ph = PHASE_INFO[world.phase];
		setText(e.phase, this.mode === 'tutorial' ? '튜토리얼 모드' : `${ph.label} · ${ph.resource}`);
		const z = world.zone;
		setText(
			e.zone,
			z.to.radius >= z.current.radius - 0.5 && !z.shrinking
				? '자기장 최종'
				: z.shrinking
					? `⚠ 축소 중 ${Math.ceil(z.timer)}s`
					: `자기장 ${Math.ceil(z.timer)}s`
		);
		e.zone.classList.toggle('warn', z.shrinking);
		setText(e.alive, `생존 ${world.fighters.filter((f) => f.alive).length}`);

		const pending = me.pendingDrafts;
		e.levelBtn.classList.toggle('pulse', pending > 0 && !this.draftOpen);
		e.levelBtn.toggleAttribute('disabled', pending === 0 || !me.alive);
		setText(e.levelBtn, !me.build.weapon && me.offer ? '무기 선택' : pending > 0 ? `레벨업 ×${pending}` : '레벨업');
		e.dashCd.style.setProperty('--k', `${Math.max(0, Math.min(1, 1 - me.dashCd / 3))}`);
		e.dashCd.classList.toggle('ready', me.dashCd <= 0);

		const tagKey = TAGS.map((t) => me.build.tagCounts[t]).join();
		if (tagKey !== this.tagKey) {
			this.tagKey = tagKey;
			e.tagbar.innerHTML = TAGS.map((t) => {
				const c = me.build.tagCounts[t];
				const tier = me.build.tiers[t];
				const next = SYNERGY_THRESHOLDS.find((n) => n > c);
				const pips = next ? `${c}/${next}` : `${c} MAX`;
				return `<div class="tagpip t${tier} ${c ? '' : 'zero'}" style="--c:${TAG_INFO[t].color}">${TAG_INFO[t].icon}<span>${pips}</span></div>`;
			}).join('');
		}

		if (me.build.weapon) {
			if (this.hintShowing === 'weapon') this.dismissHint();
			this.hint('controls', '드래그로 이동(멀리 끌면 달리기), 탭으로 공격(가까운 적 자동 조준). 빠르게 두 번 스와이프하면 무적 대시.');
		}
		if (z.shrinking) this.hint('zone', '파란 벽 밖에 있으면 계속 피해를 받습니다. 흰 원이 다음 안전지대예요.');
		this.tickHints(dt);

		this.renderDraft(me);
		this.renderBuild(me);

		this.minimapTimer -= dt;
		if (this.minimapTimer <= 0) {
			this.minimapTimer = 0.2;
			this.drawMinimap(world, focus ?? me);
		}

		if (this.mode === 'tutorial') return;
		if (!me.alive && !this.gameOverShown) this.showGameOver(world, me);
		else if (world.over && !this.gameOverShown) this.showGameOver(world, me);
		else if (world.over && this.spectating) {
			this.spectating = false;
			this.showGameOver(world, me);
		}
	}

	private drawMinimap(world: World, focus: Fighter) {
		const c = this.minimap;
		const ctx = c.getContext('2d')!;
		const size = c.width;
		const k = size / 2 / (MAP_RADIUS + 4);
		const tx = (x: number) => size / 2 + x * k;
		const ty = (y: number) => size / 2 - y * k;
		ctx.clearRect(0, 0, size, size);
		const disc = (r: number, fill: string) => {
			ctx.beginPath();
			ctx.arc(size / 2, size / 2, r * k, 0, Math.PI * 2);
			ctx.fillStyle = fill;
			ctx.fill();
		};
		disc(MAP_RADIUS, 'rgba(47,70,52,0.85)');
		disc(RING.mid, 'rgba(70,67,47,0.9)');
		disc(RING.center, 'rgba(74,46,46,0.95)');

		const z = world.zone;
		ctx.lineWidth = 3;
		ctx.strokeStyle = '#58a6ff';
		ctx.beginPath();
		ctx.arc(tx(z.current.center.x), ty(z.current.center.y), Math.max(0, z.current.radius * k), 0, Math.PI * 2);
		ctx.stroke();
		if (z.to.radius < z.current.radius - 0.5) {
			ctx.lineWidth = 2;
			ctx.strokeStyle = 'rgba(255,255,255,0.8)';
			ctx.beginPath();
			ctx.arc(tx(z.to.center.x), ty(z.to.center.y), Math.max(0, z.to.radius * k), 0, Math.PI * 2);
			ctx.stroke();
		}

		for (const p of world.pickups) {
			ctx.fillStyle = '#ffca28';
			ctx.fillRect(tx(p.pos.x) - 2, ty(p.pos.y) - 2, 4, 4);
		}
		// Enemies only show up nearby — the map doesn't give away everyone's position.
		for (const f of world.fighters) {
			if (!f.alive || f === focus) continue;
			if (Math.hypot(f.pos.x - focus.pos.x, f.pos.y - focus.pos.y) > 35) continue;
			ctx.fillStyle = '#ff5a5a';
			ctx.beginPath();
			ctx.arc(tx(f.pos.x), ty(f.pos.y), 4, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = '#ffd54f';
		ctx.beginPath();
		ctx.arc(tx(focus.pos.x), ty(focus.pos.y), 5, 0, Math.PI * 2);
		ctx.fill();
	}

	// ── Events

	handleEvents(world: World, events: readonly GameEvent[], playerId: number | null) {
		const nameOf = (id: number | null) => world.fighters.find((f) => f.id === id)?.name ?? '';
		for (const e of events) {
			switch (e.type) {
				case 'hit':
					if (playerId !== null && (e.src === playerId || e.target === playerId) && e.amount >= 0.5) {
						this.floater(e.pos, Math.round(e.amount).toString(), e.target === playerId ? 'taken' : e.crit ? 'crit' : 'dealt');
					}
					if (e.target === playerId) {
						const me = world.fighters.find((f) => f.id === playerId);
						const src = world.fighters.find((f) => f.id === e.src);
						if (me && src && me.build.attack === 'melee' && dist(me.pos, src.pos) > 4) {
							this.hint(
								'ranged-threat',
								'멀리서 공격받고 있어요. 대시(빠르게 두 번 스와이프, 무적)로 파고들거나, 레벨업 드래프트에 뜨는 무기 카드(사냥활·화염 지팡이)로 원거리로 바꿀 수 있습니다.'
							);
						}
					}
					break;
				case 'death':
					if (e.kind === 'fighter') {
						const who = nameOf(e.unit);
						const line = e.killer !== null ? `${nameOf(e.killer)} ⚔ ${who}` : `${who} 탈락`;
						this.feed(line, e.unit === playerId || e.killer === playerId);
					}
					break;
				case 'levelUp':
					if (e.unit === playerId) {
						this.toast(`레벨 ${e.level}! 드래프트 +1`, 'level');
						this.hint('levelup', '레벨업! 오른쪽 아래 버튼으로 카드 3장 중 1장을 고르세요. 같은 태그가 3개·5개 모이면 시너지가 켜집니다.');
					}
					break;
				case 'synergy':
					if (e.unit === playerId) {
						const t = TAG_INFO[e.tag];
						this.toast(`${t.icon} ${t.label} ${e.tier === 1 ? 'I' : 'II'} 발동 — ${t.tiers[e.tier - 1]}`, 'synergy', t.color);
						this.hint('synergy', '시너지 발동! 빌드 버튼에서 태그별 효과와 다음 단계(5개)를 확인할 수 있어요.');
					}
					break;
				case 'pickup':
					if (e.unit === playerId) this.toast(`획득: ${getItem(e.itemId).name}`, 'pickup');
					break;
				case 'phase': {
					const ph = PHASE_INFO[e.phase];
					this.toast(`${ph.label} — ${ph.resource} 아이템이 주로 등장합니다 · 리롤/교환권 +1`, 'phase');
					this.draftKey = '';
					if (e.phase === 2) {
						this.hint('skills', '2단계: 스킬 카드가 나옵니다. 스킬은 자동 시전돼요(최대 3개). 교환권이 생겼으니 빌드 버튼에서 안 맞는 아이템을 바꿀 수 있어요.');
					}
					if (e.phase === 3) {
						this.hint('bridges', '3단계: 전설(브릿지) 카드가 나옵니다. 한 태그를 다른 태그로도 세어 시너지를 완성해 줘요.');
					}
					break;
				}
				case 'zone':
					this.toast('자기장 단계가 바뀌었습니다', 'phase');
					break;
			}
		}
	}

	private floater(pos: { x: number; y: number }, text: string, cls: string) {
		const p = this.renderer.worldToScreen(pos, 2.2);
		if (!p) return;
		const el = h('div', `floater ${cls}`);
		el.textContent = text;
		el.style.left = `${p.x + (Math.random() - 0.5) * 24}px`;
		el.style.top = `${p.y}px`;
		this.el.floaters.appendChild(el);
		setTimeout(() => el.remove(), 700);
	}

	private feed(text: string, mine: boolean) {
		const el = h('div', mine ? 'mine' : '');
		el.textContent = text;
		this.el.feed.prepend(el);
		while (this.el.feed.children.length > 4) this.el.feed.lastElementChild!.remove();
		setTimeout(() => el.classList.add('fade'), 4000);
		setTimeout(() => el.remove(), 5000);
	}

	private toast(text: string, cls: string, color?: string) {
		const el = h('div', `toast ${cls}`);
		el.textContent = text;
		if (color) el.style.setProperty('--c', color);
		this.el.toasts.appendChild(el);
		while (this.el.toasts.children.length > 3) this.el.toasts.firstElementChild!.remove();
		setTimeout(() => el.remove(), 3200);
	}

	/** Floating joystick under the thumb, from the InputController's feedback stream. */
	inputFeedback(e: InputFeedbackEvent) {
		// Skill buttons are disabled in this mode (skills auto-cast), so there is nothing to draw.
		if (e.type === 'skill-buttons' || e.type === 'skill-buttons-hidden') return;
		const joy = this.el.joy;
		const knob = this.el.knob;
		if (e.type === 'release' || e.type === 'cancel') {
			joy.classList.remove('show', 'run');
			return;
		}
		joy.classList.add('show');
		joy.style.left = `${e.start.x}px`;
		joy.style.top = `${e.start.y}px`;
		const dx = e.thumb.x - e.start.x;
		const dy = e.thumb.y - e.start.y;
		const l = Math.hypot(dx, dy);
		const max = 56;
		const s = l > max ? max / l : 1;
		knob.style.transform = `translate(${dx * s}px, ${dy * s}px)`;
		joy.classList.toggle('run', e.type === 'drag' && e.mode === 'run');
	}
}
