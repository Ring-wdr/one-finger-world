/**
 * Screen/stage state machine. Kept free of DOM and three.js so it runs under plain vitest:
 * the Game implements StageHost and does the actual work; stages only decide *when*.
 */

export type StageId = 'menu' | 'match' | 'result' | 'spectate' | 'tutorial';

/** Allowed transitions. Anything else is a bug (warned in dev, ignored otherwise). */
export const TRANSITIONS: Readonly<Record<StageId, readonly StageId[]>> = {
	menu: ['match', 'tutorial'],
	match: ['result'],
	result: ['menu', 'match', 'spectate'],
	spectate: ['result', 'match'],
	// Self-transition = restart; the tutorial-done panel can also jump straight into a match.
	tutorial: ['menu', 'tutorial', 'match']
};

export interface Stage {
	enter?(from: StageId | null): void;
	exit?(to: StageId): void;
	/** Per-frame work: whether the sim ticks, what the HUD refreshes, which transition fires. */
	frame(dt: number): void;
	/** UI shortcut keys (E/B/1/2/3/R/Esc). True when consumed. */
	uiKey(key: string): boolean;
	/** Whether movement/attack/dash commands (keyboard, gestures, draft picks) reach the sim. */
	readonly acceptsInput: boolean;
}

export class StageManager {
	private currentId: StageId;
	private current: Stage;

	constructor(
		private readonly stages: Readonly<Record<StageId, Stage>>,
		initial: StageId,
		private readonly table: Readonly<Record<StageId, readonly StageId[]>> = TRANSITIONS
	) {
		this.currentId = initial;
		this.current = stages[initial];
		this.current.enter?.(null);
	}

	get id(): StageId {
		return this.currentId;
	}

	get acceptsInput(): boolean {
		return this.current.acceptsInput;
	}

	can(next: StageId): boolean {
		return this.table[this.currentId].includes(next);
	}

	/** Exit the current stage and enter `next`. Returns false (no-op) for a transition not in the table. */
	go(next: StageId): boolean {
		if (!this.can(next)) {
			if (import.meta.env.DEV) console.warn(`[stages] rejected transition ${this.currentId} → ${next}`);
			return false;
		}
		const prev = this.currentId;
		this.current.exit?.(next);
		this.currentId = next;
		this.current = this.stages[next];
		this.current.enter?.(prev);
		return true;
	}

	frame(dt: number) {
		this.current.frame(dt);
	}

	uiKey(key: string): boolean {
		return this.current.uiKey(key);
	}
}

/** What the stages need from the game. */
export interface StageHost {
	/** The local player is gone (dead or missing). */
	playerDown(): boolean;
	/** The match has been decided. */
	worldOver(): boolean;
	/** Advance the sim by `dt` of real time in fixed ticks. */
	simulate(dt: number): void;
	/** Camera + render; with `hud`, also the per-frame HUD refresh for the local player. */
	present(dt: number, hud: boolean): void;
	/** Tutorial step text/marker that depend on live state. */
	syncTutorial(): void;
	/** Draft/build keyboard shortcuts for the local player. */
	hudKey(key: string): boolean;
	showMenu(): void;
	startMatch(): void;
	startTutorial(): void;
	endTutorial(): void;
	showResult(): void;
	showSpectate(): void;
}

const ignoreKey = () => false;

/** The game's stages. `go` is the manager's transition function (bound lazily by the caller). */
export function createStages(host: StageHost, go: (next: StageId) => void): Record<StageId, Stage> {
	return {
		// The previous (or idle) world keeps rendering as a backdrop; nothing else runs.
		menu: {
			acceptsInput: false,
			enter: () => host.showMenu(),
			frame: (dt) => host.present(dt, false),
			uiKey: ignoreKey
		},
		match: {
			acceptsInput: true,
			enter: () => host.startMatch(),
			frame: (dt) => {
				host.simulate(dt);
				host.present(dt, true);
				if (host.playerDown() || host.worldOver()) go('result');
			},
			uiKey: (k) => host.hudKey(k)
		},
		// Bots keep fighting behind the result panel (that is what spectating watches).
		result: {
			acceptsInput: false,
			enter: () => host.showResult(),
			frame: (dt) => {
				host.simulate(dt);
				host.present(dt, true);
			},
			uiKey: ignoreKey
		},
		spectate: {
			acceptsInput: false,
			enter: () => host.showSpectate(),
			frame: (dt) => {
				host.simulate(dt);
				host.present(dt, true);
				if (host.worldOver()) go('result');
			},
			uiKey: ignoreKey
		},
		tutorial: {
			acceptsInput: true,
			enter: () => host.startTutorial(),
			exit: () => host.endTutorial(),
			frame: (dt) => {
				host.simulate(dt);
				host.syncTutorial();
				host.present(dt, true);
			},
			uiKey: (k) => host.hudKey(k)
		}
	};
}
