import type { Command } from '@ofa/sim';

/** Every key the game reads; during play their browser defaults (Ctrl+R reload, Space/Enter on a focused button, …) are suppressed. */
const GAME_KEYS = new Set([
	'w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
	' ', 'j', 'k', 'shift', 'control', 'e', 'b', 'r', '1', '2', '3', 'escape', 'enter'
]);

/** Desktop fallback so the prototype is testable without a touch screen. */
export class Keyboard {
	private readonly held = new Set<string>();
	private lastDir = '';

	constructor(
		private readonly emit: (cmd: Command) => void,
		private readonly onUiKey: (key: string) => boolean,
		/** Whether a match/tutorial is taking gameplay input (menus keep normal browser keys). */
		private readonly playing: () => boolean
	) {
		window.addEventListener('keydown', this.onDown);
		window.addEventListener('keyup', this.onUp);
		window.addEventListener('blur', this.onBlur);
	}

	dispose() {
		window.removeEventListener('keydown', this.onDown);
		window.removeEventListener('keyup', this.onUp);
		window.removeEventListener('blur', this.onBlur);
	}

	private readonly onDown = (e: KeyboardEvent) => {
		const k = e.key.toLowerCase();
		if (this.playing()) {
			// A HUD button clicked earlier keeps focus; Space/Enter would then "click" it
			// (e.g. the tutorial's 나가기 → main menu), so gameplay keys never go to it.
			const focused = document.activeElement;
			if (focused instanceof HTMLElement && focused !== document.body) focused.blur();
			// Walking holds Ctrl, so Ctrl+R/E/B/1… must not reach the browser (Ctrl+R reloads to the menu).
			if (GAME_KEYS.has(k)) e.preventDefault();
		}
		if (e.repeat) return;
		if (this.onUiKey(k)) {
			e.preventDefault();
			return;
		}
		if (k === ' ' || k === 'j') {
			e.preventDefault();
			this.emit({ type: 'attack' });
			return;
		}
		if (k === 'shift' || k === 'k') {
			const d = this.direction();
			if (d) this.emit({ type: 'dash', dir: d });
			return;
		}
		this.held.add(k);
		this.sync();
	};

	private readonly onUp = (e: KeyboardEvent) => {
		this.held.delete(e.key.toLowerCase());
		this.sync();
	};

	private readonly onBlur = () => {
		this.held.clear();
		this.sync();
	};

	private direction() {
		const h = this.held;
		const x = (h.has('d') || h.has('arrowright') ? 1 : 0) - (h.has('a') || h.has('arrowleft') ? 1 : 0);
		const y = (h.has('w') || h.has('arrowup') ? 1 : 0) - (h.has('s') || h.has('arrowdown') ? 1 : 0);
		return x || y ? { x, y } : null;
	}

	private sync() {
		const d = this.direction();
		const walk = this.held.has('control');
		const key = d ? `${d.x},${d.y},${walk}` : '';
		if (key === this.lastDir) return;
		this.lastDir = key;
		this.emit({ type: 'move', dir: d, run: !walk });
	}
}
