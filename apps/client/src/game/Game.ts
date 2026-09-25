import { effect } from '@preact/signals';
import { createWorld, DT, step, TAGS, type Command, type Fighter, type GameEvent, type Vec2, type World } from '@ofa/sim';
import { profile, result, settings, stage, tutorialDone, type GameActions } from '../app/store';
import { sfx } from '../app/sound';
import type { SfxId } from '../audio/Sfx';
import { InputController } from '../input/InputController';
import { inputThresholdOptionsToThresholds, type InputThresholdOptions } from '../input/inputThresholdOptions';
import { Keyboard } from '../input/Keyboard';
import type { InputGesture } from '../input/types';
import { equippedRunes, grantReward } from '../meta/profile';
import { scoreMatch, type MatchReward } from '../meta/rewards';
import { Renderer } from '../render/Renderer';
import { Tutorial } from '../tutorial/Tutorial';
import { Hud } from '../ui/Hud';
import { createStages, StageManager, type StageHost, type StageId } from './stages';

const FIGHTERS = 12;

const randomSeed = () => (Math.random() * 2 ** 31) | 0;

const sameInput = (a: InputThresholdOptions, b: InputThresholdOptions) =>
	a.tapMs === b.tapMs && a.dragStartPx === b.dragStartPx && a.fastDragPxPerMs === b.fastDragPxPerMs;

export class Game implements StageHost, GameActions {
	private world: World;
	private playerId: number | null;
	private focusId: number | null;
	private tutorial: Tutorial | null = null;
	private readonly renderer: Renderer;
	private readonly hud: Hud;
	private input: InputController;
	private inputOptions: InputThresholdOptions;
	private readonly keyboard: Keyboard;
	private readonly stages: StageManager;
	private readonly disposeSettings: () => void;
	/** The current match already paid out (the result panel is shown again after spectating). */
	private rewarded = false;
	private pending: Command[] = [];
	private readonly prev = new Map<number, Vec2>();
	private acc = 0;
	private last = 0;
	private raf = 0;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		hudRoot: HTMLElement,
		onAssetProgress?: (done: number, total: number) => void
	) {
		this.renderer = new Renderer(canvas, onAssetProgress);
		this.inputOptions = settings.value.input;
		this.hud = new Hud(hudRoot, this.renderer, {
			command: (c) => this.queue(c),
			toMenu: () => this.go('menu'),
			skipTutorialStep: () => {
				this.tutorial?.skip();
				this.onTutorialStep();
			},
			buildOpened: () => this.tutorial?.signal('buildOpened')
		});
		// A match world idles behind the menu as a backdrop.
		({ world: this.world, playerId: this.playerId } = createWorld({ seed: randomSeed(), fighters: FIGHTERS, playerName: '나' }));
		this.focusId = this.playerId;

		this.input = this.createInput();
		this.keyboard = new Keyboard(
			(c) => this.queue(c),
			(k) => this.stages.uiKey(k),
			() => this.stages.acceptsInput
		);
		this.stages = new StageManager(createStages(this, (next) => this.go(next)), 'menu');
		stage.value = this.stages.id;

		// Settings screen → live touch thresholds.
		this.disposeSettings = effect(() => {
			const s = settings.value;
			if (!sameInput(s.input, this.inputOptions)) {
				this.inputOptions = s.input;
				this.input.dispose();
				this.input = this.createInput();
			}
		});

		window.addEventListener('resize', this.onResize);
		this.onResize();
		this.last = performance.now();
		this.raf = requestAnimationFrame(this.frame);
	}

	private createInput() {
		return new InputController(
			this.canvas,
			this.onGesture,
			inputThresholdOptionsToThresholds(this.inputOptions),
			(e) => this.hud.inputFeedback(e),
			// Skills auto-cast in the royale, so the diagonal skill buttons stay off.
			{ skillButtons: false }
		);
	}

	// ── GameActions: what the preact screens (../ui/screens) can ask for, via ../app/gameHost.

	go(next: StageId) {
		if (this.stages.go(next)) stage.value = next;
	}

	restart() {
		this.go(this.stages.id === 'tutorial' ? 'tutorial' : 'match');
	}

	spectateNext() {
		const alive = this.world.fighters.filter((f) => f.alive);
		if (alive.length === 0) return;
		const i = alive.findIndex((f) => f.id === this.focusId);
		this.focusId = alive[(i + 1) % alive.length].id;
	}

	/** Resolves once the 3D models are in (or fell back to primitives). */
	get ready(): Promise<void> {
		return this.renderer.ready;
	}

	private player(): Fighter | undefined {
		return this.world.fighters.find((f) => f.id === this.playerId);
	}

	/** Player commands only reach the sim in stages that take gameplay input. */
	private queue(c: Command) {
		if (this.stages.acceptsInput) this.pending.push(c);
	}

	private load(world: World, playerId: number | null, tutorial: boolean) {
		this.world = world;
		this.playerId = playerId;
		this.focusId = playerId;
		this.pending = [];
		this.prev.clear();
		this.acc = 0;
		this.renderer.reset();
		this.hud.reset();
		this.hud.setMode(tutorial ? 'tutorial' : 'match');
	}

	// ── StageHost: the stages (./stages.ts) decide when; these do the work.

	playerDown() {
		return !this.player()?.alive;
	}

	worldOver() {
		return this.world.over;
	}

	hudKey(key: string) {
		return this.hud.handleKey(key, this.player());
	}

	showMenu() {
		this.hud.reset();
		this.hud.setMode('match');
		result.value = null;
		tutorialDone.value = false;
	}

	startMatch() {
		const { world, playerId } = createWorld({
			seed: randomSeed(),
			fighters: FIGHTERS,
			playerName: '나',
			playerRunes: equippedRunes(profile.value)
		});
		this.load(world, playerId, false);
		this.rewarded = false;
		result.value = null;
		this.hud.onMatchStart();
	}

	startTutorial() {
		tutorialDone.value = false;
		this.tutorial = new Tutorial(randomSeed());
		this.load(this.tutorial.world, this.tutorial.playerId, true);
		this.onTutorialStep();
	}

	endTutorial() {
		this.tutorial = null;
		tutorialDone.value = false;
		this.renderer.setMarker(null);
	}

	showResult() {
		const me = this.player();
		if (!me) return;
		this.hud.closeSheets();
		const w = this.world;
		const won = w.winner === me.id;
		const placement = won ? 1 : (me.placement ?? w.fighters.filter((f) => f.alive).length);
		let reward: MatchReward | null = null;
		let newBest = false;
		if (!this.rewarded) {
			this.rewarded = true;
			reward = scoreMatch({ placement, fighters: w.fighters.length, kills: me.kills, level: me.level, time: w.time });
			newBest = reward.score > profile.value.best;
			profile.value = grantReward(profile.value, reward.coins, reward.score);
			sfx.play(won ? 'win' : 'lose');
		}
		const prev = result.value;
		result.value = {
			won,
			placement,
			level: me.level,
			kills: me.kills,
			time: w.time,
			tags: TAGS.filter((t) => me.build.tagCounts[t] > 0).map((t) => ({
				tag: t,
				count: me.build.tagCounts[t],
				on: me.build.tiers[t] > 0
			})),
			items: [...me.items],
			// Coming back from spectating keeps showing the payout from the first time.
			reward: reward ?? prev?.reward ?? null,
			newBest: newBest || (prev?.newBest ?? false),
			canSpectate: !w.over
		};
	}

	showSpectate() {
		this.hud.closeSheets();
	}

	/** React to the tutorial entering a new step. */
	private onTutorialStep() {
		const t = this.tutorial;
		if (!t) return;
		this.renderer.setMarker(t.marker);
		this.hud.updateTutorial(t);
		if (t.finished) {
			this.hud.closeSheets();
			tutorialDone.value = true;
			return;
		}
		if (t.wantsDraft) this.hud.toggleDraft(true);
	}

	private readonly onGesture = (g: InputGesture) => {
		switch (g.type) {
			case 'move':
				this.pending.push({ type: 'move', dir: g.direction, run: g.mode === 'run' });
				break;
			case 'idle':
				this.pending.push({ type: 'move', dir: null, run: false });
				break;
			case 'attack':
				this.pending.push({ type: 'attack' });
				break;
			case 'dash':
				this.pending.push({ type: 'dash', dir: g.direction });
				break;
			case 'skill':
				// Disabled via options; skills auto-cast in the sim.
				break;
		}
	};

	private readonly onResize = () => {
		const w = this.canvas.clientWidth || window.innerWidth;
		const h = this.canvas.clientHeight || window.innerHeight;
		this.renderer.resize(w, h);
	};

	private readonly frame = (now: number) => {
		this.raf = requestAnimationFrame(this.frame);
		const dt = Math.min(0.1, (now - this.last) / 1000);
		this.last = now;
		this.input.update();
		this.stages.frame(dt);
	};

	simulate(dt: number) {
		if (!this.world.over) {
			this.acc += dt;
			while (this.acc >= DT) {
				this.acc -= DT;
				this.prev.clear();
				for (const f of this.world.fighters) this.prev.set(f.id, { ...f.pos });
				for (const m of this.world.monsters) this.prev.set(m.id, { ...m.pos });
				for (const p of this.world.projectiles) this.prev.set(p.id, { ...p.pos });

				const cmds = new Map<number, Command[]>();
				if (this.playerId !== null) cmds.set(this.playerId, this.pending);
				this.pending = [];
				step(this.world, cmds);
				this.playSounds(this.world.events);
				this.renderer.handleEvents(this.world.events, this.playerId);
				this.hud.handleEvents(this.world, this.world.events, this.playerId);
				if (this.tutorial?.afterStep(this.world.events)) this.onTutorialStep();
			}
		}
	}

	/** Sound (and a short buzz when hurt) only for what happens to or by the local player. */
	private playSounds(events: readonly GameEvent[]) {
		const me = this.playerId;
		if (me === null) return;
		let hurt = false;
		for (const e of events) {
			let id: SfxId | null = null;
			switch (e.type) {
				case 'attack':
					if (e.unit === me) id = 'swing';
					break;
				case 'hit':
					if (e.src === me && e.target !== me) id = e.crit ? 'crit' : 'hit';
					else if (e.target === me && e.amount >= 1) {
						id = 'hurt';
						hurt = true;
					}
					break;
				case 'dash':
					if (e.unit === me) id = 'dash';
					break;
				case 'levelUp':
					if (e.unit === me) id = 'levelUp';
					break;
				case 'synergy':
					if (e.unit === me) id = 'synergy';
					break;
				case 'pickup':
					if (e.unit === me) id = 'pickup';
					break;
				case 'death':
					if (e.kind === 'fighter' && e.killer === me) id = 'kill';
					break;
			}
			if (id) sfx.play(id);
		}
		if (hurt && settings.value.vibrate) navigator.vibrate?.(30);
	}

	syncTutorial() {
		if (!this.tutorial) return;
		// Some step text depends on live state (e.g. current weapon).
		this.hud.updateTutorial(this.tutorial);
		this.renderer.setMarker(this.tutorial.marker);
	}

	/** Render the world; with `hud`, also refresh the HUD (the menu backdrop skips it). */
	present(dt: number, hud: boolean) {
		// After death, follow whoever is still standing.
		const me = this.player();
		let focus = this.world.fighters.find((f) => f.id === this.focusId);
		if (!focus?.alive) {
			const next =
				this.world.fighters.find((f) => f.alive && f.id === me?.lastAttacker) ??
				this.world.fighters.find((f) => f.alive);
			if (next && !this.world.over) {
				this.focusId = next.id;
				focus = next;
			}
		}

		this.renderer.render(this.world, this.prev, hud ? this.acc / DT : 1, this.focusId, dt);
		if (hud) this.hud.update(this.world, me, focus, dt);
	}

	dispose() {
		cancelAnimationFrame(this.raf);
		this.disposeSettings();
		this.input.dispose();
		this.keyboard.dispose();
		window.removeEventListener('resize', this.onResize);
		this.renderer.dispose();
	}
}
