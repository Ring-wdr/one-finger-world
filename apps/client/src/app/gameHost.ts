import { signal } from '@preact/signals';
import type { Game } from '../game/Game';
import type { StageId } from '../game/stages';
import type { GameActions } from './store';

/**
 * The game (three.js, sim, renderer, HUD) and its models are loaded on demand: the menu
 * ships without them and they are fetched the first time a match or the tutorial starts.
 * After that the game stays loaded and renders the menu backdrop.
 */

export interface LoadingState {
	/** 0–1 over the model files; code download counts as the first step. */
	progress: number;
	label: string;
	error: string | null;
	/** What to start once loaded (and what "retry" starts). */
	next: StageId;
}

export const loading = signal<LoadingState | null>(null);

let game: Game | null = null;
let pending: Promise<Game> | null = null;

async function create(onProgress: (done: number, total: number) => void): Promise<Game> {
	const { Game } = await import('../game/Game');
	const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
	const hud = document.querySelector<HTMLElement>('#hud')!;
	const g = new Game(canvas, hud, onProgress);
	await g.ready;
	return g;
}

async function start(next: StageId) {
	loading.value = { progress: 0, label: '게임 불러오는 중', error: null, next };
	pending ??= create((done, total) => {
		const cur = loading.value;
		if (cur) loading.value = { ...cur, progress: total ? done / total : 1, label: `모델 불러오는 중 ${done}/${total}` };
	});
	try {
		game = await pending;
	} catch (err) {
		// A failed chunk download can be retried; don't cache the rejection.
		pending = null;
		console.error('[game] failed to load', err);
		loading.value = { progress: 0, label: '', error: '게임을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.', next };
		return;
	}
	document.querySelector<HTMLElement>('#app')!.dataset.game = 'on';
	loading.value = null;
	game.go(next);
}

export function retryLoading() {
	const s = loading.value;
	if (s?.error) void start(s.next);
}

export function cancelLoading() {
	if (loading.value?.error) loading.value = null;
}

/** Screens call this; before the game exists, only starting a mode does anything. */
export const gameActions: GameActions = {
	go(next) {
		if (game) game.go(next);
		else if ((next === 'match' || next === 'tutorial') && !loading.value) void start(next);
	},
	restart: () => game?.restart(),
	spectateNext: () => game?.spectateNext()
};

export function disposeGame() {
	game?.dispose();
	game = null;
	pending = null;
}
