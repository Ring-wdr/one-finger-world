import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStages, StageManager, TRANSITIONS, type Stage, type StageHost, type StageId } from './stages';

const IDS = Object.keys(TRANSITIONS) as StageId[];

/** Stub stages that only record enter/exit calls. */
function recordingStages(log: string[]): Record<StageId, Stage> {
	const stages = {} as Record<StageId, Stage>;
	for (const id of IDS) {
		stages[id] = {
			acceptsInput: false,
			enter: (from) => log.push(`enter ${id} from ${from}`),
			exit: (to) => log.push(`exit ${id} to ${to}`),
			frame: () => log.push(`frame ${id}`),
			uiKey: () => false
		};
	}
	return stages;
}

/** Fake game: a world the tests can kill the player in or end, plus a log of what the stages asked for. */
class FakeHost implements StageHost {
	dead = false;
	over = false;
	readonly log: string[] = [];
	readonly keys: string[] = [];
	playerDown = () => this.dead;
	worldOver = () => this.over;
	simulate = () => void this.log.push('simulate');
	present = (_dt: number, hud: boolean) => void this.log.push(hud ? 'present+hud' : 'present');
	syncTutorial = () => void this.log.push('syncTutorial');
	hudKey = (key: string) => (this.keys.push(key), true);
	showMenu = () => void this.log.push('showMenu');
	startMatch = () => {
		this.dead = false;
		this.over = false;
		this.log.push('startMatch');
	};
	startTutorial = () => void this.log.push('startTutorial');
	endTutorial = () => void this.log.push('endTutorial');
	showResult = () => void this.log.push('showResult');
	showSpectate = () => void this.log.push('showSpectate');
}

function game() {
	const host = new FakeHost();
	const stages: StageManager = new StageManager(
		createStages(host, (next) => stages.go(next)),
		'menu'
	);
	return { host, stages };
}

afterEach(() => vi.restoreAllMocks());

describe('StageManager', () => {
	it('enters the initial stage on construction', () => {
		const log: string[] = [];
		const m = new StageManager(recordingStages(log), 'menu');
		expect(m.id).toBe('menu');
		expect(log).toEqual(['enter menu from null']);
	});

	it('allows exactly the transitions in the table', () => {
		for (const from of IDS) {
			for (const to of IDS) {
				const m = new StageManager(recordingStages([]), from);
				expect(m.can(to), `${from} → ${to}`).toBe(TRANSITIONS[from].includes(to));
			}
		}
	});

	it('rejects transitions outside the table without touching the stages', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const log: string[] = [];
		const m = new StageManager(recordingStages(log), 'menu');
		log.length = 0;
		expect(m.go('result')).toBe(false);
		expect(m.go('spectate')).toBe(false);
		expect(m.id).toBe('menu');
		expect(log).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('exits the current stage before entering the next', () => {
		const log: string[] = [];
		const m = new StageManager(recordingStages(log), 'menu');
		log.length = 0;
		expect(m.go('match')).toBe(true);
		expect(m.go('result')).toBe(true);
		expect(log).toEqual(['exit menu to match', 'enter match from menu', 'exit match to result', 'enter result from match']);
	});

	it('re-enters on a self-transition (tutorial restart)', () => {
		const log: string[] = [];
		const m = new StageManager(recordingStages(log), 'tutorial');
		log.length = 0;
		expect(m.go('tutorial')).toBe(true);
		expect(log).toEqual(['exit tutorial to tutorial', 'enter tutorial from tutorial']);
	});

	it('delegates frames to the current stage only', () => {
		const log: string[] = [];
		const m = new StageManager(recordingStages(log), 'menu');
		m.go('match');
		log.length = 0;
		m.frame(0.016);
		expect(log).toEqual(['frame match']);
	});
});

describe('game stages', () => {
	it('match → result when the player dies', () => {
		const { host, stages } = game();
		stages.go('match');
		stages.frame(0.016);
		expect(stages.id).toBe('match');
		host.dead = true;
		stages.frame(0.016);
		expect(stages.id).toBe('result');
		expect(host.log.filter((l) => l === 'showResult')).toHaveLength(1);
	});

	it('match → result when the match is decided with the player alive', () => {
		const { host, stages } = game();
		stages.go('match');
		host.over = true;
		stages.frame(0.016);
		expect(stages.id).toBe('result');
	});

	it('shows the result once, not every frame', () => {
		const { host, stages } = game();
		stages.go('match');
		host.dead = true;
		for (let i = 0; i < 10; i++) stages.frame(0.016);
		expect(host.log.filter((l) => l === 'showResult')).toHaveLength(1);
	});

	// Regression: the menu button on the result screen used to be overwritten by the
	// result panel on the very next frame, because the HUD re-detected game over.
	it('result → menu stays in menu even though the player is dead and the world is over', () => {
		const { host, stages } = game();
		stages.go('match');
		host.dead = true;
		host.over = true;
		stages.frame(0.016);
		expect(stages.id).toBe('result');
		host.log.length = 0;

		expect(stages.go('menu')).toBe(true);
		for (let i = 0; i < 30; i++) stages.frame(0.016);
		expect(stages.id).toBe('menu');
		expect(host.log).not.toContain('showResult');
		expect(host.log).not.toContain('simulate');
		expect(host.log).not.toContain('present+hud');
		expect(host.log.filter((l) => l === 'showMenu')).toHaveLength(1);
	});

	it('menu ignores gameplay input and UI keys', () => {
		const { host, stages } = game();
		expect(stages.acceptsInput).toBe(false);
		for (const k of ['e', 'b', '1', '2', '3', 'r', 'escape']) expect(stages.uiKey(k)).toBe(false);
		expect(host.keys).toEqual([]);

		stages.go('match');
		expect(stages.acceptsInput).toBe(true);
		expect(stages.uiKey('e')).toBe(true);
		expect(host.keys).toEqual(['e']);

		host.dead = true;
		stages.frame(0.016);
		stages.go('menu');
		expect(stages.acceptsInput).toBe(false);
		expect(stages.uiKey('e')).toBe(false);
		expect(host.keys).toEqual(['e']);
	});

	it('spectate → result when the match ends; restart starts a fresh match', () => {
		const { host, stages } = game();
		stages.go('match');
		host.dead = true;
		stages.frame(0.016);
		expect(stages.go('spectate')).toBe(true);
		stages.frame(0.016);
		expect(stages.id).toBe('spectate');
		host.over = true;
		stages.frame(0.016);
		expect(stages.id).toBe('result');
		expect(stages.go('match')).toBe(true);
		stages.frame(0.016);
		expect(stages.id).toBe('match');
		expect(host.log.filter((l) => l === 'startMatch')).toHaveLength(2);
	});

	it('tutorial never jumps to the result screen; exit and restart clean up the tutorial', () => {
		const { host, stages } = game();
		stages.go('tutorial');
		host.dead = true;
		host.over = true;
		stages.frame(0.016);
		expect(stages.id).toBe('tutorial');
		expect(host.log).toContain('syncTutorial');

		host.log.length = 0;
		stages.go('tutorial');
		expect(host.log).toEqual(['endTutorial', 'startTutorial']);

		host.log.length = 0;
		stages.go('menu');
		expect(host.log).toEqual(['endTutorial', 'showMenu']);
	});
});
