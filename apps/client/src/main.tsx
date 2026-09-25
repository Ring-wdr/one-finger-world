import './style.css';
import { effect } from '@preact/signals';
import { render } from 'preact';
import { stage } from './app/store';
import { Game } from './game/Game';
import { App } from './ui/screens/App';

const app = document.querySelector<HTMLElement>('#app')!;
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const ui = document.querySelector<HTMLElement>('#ui')!;
const game = new Game(canvas, hud);

// CSS hides the in-game HUD on the menu screens.
const disposeStage = effect(() => {
	app.dataset.stage = stage.value;
});
render(<App game={game} />, ui);

if (import.meta.hot)
	import.meta.hot.dispose(() => {
		render(null, ui);
		disposeStage();
		game.dispose();
	});
