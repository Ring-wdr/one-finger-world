import './style.css';
import { effect } from '@preact/signals';
import { render } from 'preact';
import { disposeGame, gameActions } from './app/gameHost';
import { stage } from './app/store';
import { App } from './ui/screens/App';

// Only the menu ships in this entry; the game and its models load on first play (app/gameHost.ts).
const app = document.querySelector<HTMLElement>('#app')!;
const ui = document.querySelector<HTMLElement>('#ui')!;

// CSS hides the in-game HUD on the menu screens.
const disposeStage = effect(() => {
	app.dataset.stage = stage.value;
});
render(<App game={gameActions} />, ui);

if (import.meta.hot)
	import.meta.hot.dispose(() => {
		render(null, ui);
		disposeStage();
		disposeGame();
	});
