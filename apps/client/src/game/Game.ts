import { createWorld, DT, step, type Command, type Fighter, type Vec2, type World } from '@ofa/sim';
import { InputController } from '../input/InputController';
import {
	INPUT_THRESHOLD_PRESETS,
	inputThresholdOptionsToThresholds,
	loadInputThresholdOptions,
	saveInputThresholdOptions,
	type InputThresholdOptions,
	type InputThresholdPresetId
} from '../input/inputThresholdOptions';
import { Keyboard } from '../input/Keyboard';
import type { InputGesture } from '../input/types';
import { Renderer } from '../render/Renderer';
import { Tutorial } from '../tutorial/Tutorial';
import { Hud } from '../ui/Hud';
import { createStages, StageManager, type StageHost } from './stages';

const FIGHTERS = 12;

const randomSeed = () => (Math.random() * 2 ** 31) | 0;

function safeStorage(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

export class Game implements StageHost {
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
	private pending: Command[] = [];
	private readonly prev = new Map<number, Vec2>();
	private acc = 0;
	private last = 0;
	private raf = 0;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		hudRoot: HTMLElement
	) {
		this.renderer = new Renderer(canvas);
		// Loaded before the HUD: the start menu shows the saved preset.
		this.inputOptions = loadInputThresholdOptions(safeStorage());
		this.hud = new Hud(hudRoot, this.renderer, {
			command: (c) => this.queue(c),
			start: () => this.stages.go('match'),
			startTutorial: () => this.stages.go('tutorial'),
			toMenu: () => this.stages.go('menu'),
			restart: () => this.stages.go(this.stages.id === 'tutorial' ? 'tutorial' : 'match'),
			spectate: () => this.stages.go('spectate'),
			spectateNext: () => this.spectateNext(),
			skipTutorialStep: () => {
				this.tutorial?.skip();
				this.onTutorialStep();
			},
			buildOpened: () => this.tutorial?.signal('buildOpened'),
			setInputPreset: (id) => this.applyInputOptions({ ...INPUT_THRESHOLD_PRESETS[id].values }),
			inputPreset: () => this.currentPreset()
		});
		// A match world idles behind the menu as a backdrop.
		({ world: this.world, playerId: this.playerId } = createWorld({ seed: randomSeed(), fighters: FIGHTERS, playerName: '나' }));
		this.focusId = this.playerId;

		this.input = this.createInput();
		this.keyboard = new Keyboard(
			(c) => this.queue(c),
			(k) => this.stages.uiKey(k)
		);
		this.stages = new StageManager(
			createStages(this, (next) => this.stages.go(next)),
			'menu'
		);

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

	private applyInputOptions(options: InputThresholdOptions) {
		this.inputOptions = options;
		saveInputThresholdOptions(safeStorage(), options);
		this.input.dispose();
		this.input = this.createInput();
	}

	private currentPreset(): InputThresholdPresetId | null {
		const o = this.inputOptions;
		const ids = Object.keys(INPUT_THRESHOLD_PRESETS) as InputThresholdPresetId[];
		return (
			ids.find((id) => {
				const v = INPUT_THRESHOLD_PRESETS[id].values;
				return v.tapMs === o.tapMs && v.dragStartPx === o.dragStartPx && v.fastDragPxPerMs === o.fastDragPxPerMs;
			}) ?? null
		);
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
		this.hud.showStart();
	}

	startMatch() {
		const { world, playerId } = createWorld({ seed: randomSeed(), fighters: FIGHTERS, playerName: '나' });
		this.load(world, playerId, false);
		this.hud.onMatchStart();
	}

	startTutorial() {
		this.tutorial = new Tutorial(randomSeed());
		this.load(this.tutorial.world, this.tutorial.playerId, true);
		this.onTutorialStep();
	}

	endTutorial() {
		this.tutorial = null;
		this.renderer.setMarker(null);
	}

	showResult() {
		const me = this.player();
		if (me) this.hud.showGameOver(this.world, me);
	}

	showSpectate() {
		this.hud.showSpectate();
	}

	/** React to the tutorial entering a new step. */
	private onTutorialStep() {
		const t = this.tutorial;
		if (!t) return;
		this.renderer.setMarker(t.marker);
		this.hud.updateTutorial(t);
		if (t.finished) {
			this.hud.showTutorialDone();
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

	private spectateNext() {
		const alive = this.world.fighters.filter((f) => f.alive);
		if (alive.length === 0) return;
		const i = alive.findIndex((f) => f.id === this.focusId);
		this.focusId = alive[(i + 1) % alive.length].id;
	}

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
				this.renderer.handleEvents(this.world.events, this.playerId);
				this.hud.handleEvents(this.world, this.world.events, this.playerId);
				if (this.tutorial?.afterStep(this.world.events)) this.onTutorialStep();
			}
		}
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
		this.input.dispose();
		this.keyboard.dispose();
		window.removeEventListener('resize', this.onResize);
		this.renderer.dispose();
	}
}
