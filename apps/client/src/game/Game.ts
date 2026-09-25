import { createWorld, DT, step, type Command, type Fighter, type Vec2, type World } from '@ofa/sim';
import { InputController } from '../input/InputController';
import { Keyboard } from '../input/Keyboard';
import type { InputGesture } from '../input/types';
import { Renderer } from '../render/Renderer';
import { Tutorial } from '../tutorial/Tutorial';
import { Hud } from '../ui/Hud';

const FIGHTERS = 12;

type Mode = 'menu' | 'match' | 'tutorial';

const randomSeed = () => (Math.random() * 2 ** 31) | 0;

export class Game {
	private world: World;
	private playerId: number | null;
	private focusId: number | null;
	private mode: Mode = 'menu';
	private tutorial: Tutorial | null = null;
	private readonly renderer: Renderer;
	private readonly hud: Hud;
	private readonly input: InputController;
	private readonly keyboard: Keyboard;
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
		this.hud = new Hud(hudRoot, this.renderer, {
			command: (c) => this.pending.push(c),
			start: () => this.startMatch(),
			startTutorial: () => this.startTutorial(),
			toMenu: () => this.toMenu(),
			restart: () => (this.mode === 'tutorial' ? this.startTutorial() : this.startMatch()),
			spectateNext: () => this.spectateNext(),
			skipTutorialStep: () => {
				this.tutorial?.skip();
				this.onTutorialStep();
			},
			buildOpened: () => this.tutorial?.signal('buildOpened')
		});
		// A match world idles behind the menu as a backdrop.
		({ world: this.world, playerId: this.playerId } = createWorld({ seed: randomSeed(), fighters: FIGHTERS, playerName: '나' }));
		this.focusId = this.playerId;

		this.input = new InputController(canvas, this.onGesture, undefined, (e) => this.hud.inputFeedback(e));
		this.keyboard = new Keyboard(
			(c) => this.pending.push(c),
			(k) => this.hud.handleKey(k, this.player())
		);

		window.addEventListener('resize', this.onResize);
		this.onResize();
		this.last = performance.now();
		this.raf = requestAnimationFrame(this.frame);
	}

	private player(): Fighter | undefined {
		return this.world.fighters.find((f) => f.id === this.playerId);
	}

	private load(world: World, playerId: number | null, mode: Mode) {
		this.world = world;
		this.playerId = playerId;
		this.focusId = playerId;
		this.mode = mode;
		this.pending = [];
		this.prev.clear();
		this.acc = 0;
		this.renderer.reset();
		this.hud.reset();
		this.hud.setMode(mode === 'tutorial' ? 'tutorial' : 'match');
	}

	private startMatch() {
		this.tutorial = null;
		const { world, playerId } = createWorld({ seed: randomSeed(), fighters: FIGHTERS, playerName: '나' });
		this.load(world, playerId, 'match');
		this.hud.onMatchStart();
	}

	private startTutorial() {
		this.tutorial = new Tutorial(randomSeed());
		this.load(this.tutorial.world, this.tutorial.playerId, 'tutorial');
		this.onTutorialStep();
	}

	private toMenu() {
		this.tutorial = null;
		this.mode = 'menu';
		this.renderer.setMarker(null);
		this.hud.reset();
		this.hud.setMode('match');
		this.hud.showStart();
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
		this.input.update(now);

		const running = this.mode !== 'menu';
		if (running && !this.world.over) {
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
		if (this.tutorial) {
			// Some step text depends on live state (e.g. current weapon).
			this.hud.updateTutorial(this.tutorial);
			this.renderer.setMarker(this.tutorial.marker);
		}

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

		this.renderer.render(this.world, this.prev, running ? this.acc / DT : 1, this.focusId, dt);
		this.hud.update(this.world, me, focus, dt);
	};

	dispose() {
		cancelAnimationFrame(this.raf);
		this.input.dispose();
		this.keyboard.dispose();
		window.removeEventListener('resize', this.onResize);
		this.renderer.dispose();
	}
}
