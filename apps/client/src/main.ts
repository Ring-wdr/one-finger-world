import './style.css';
import { Game } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const game = new Game(canvas, hud);

if (import.meta.hot) import.meta.hot.dispose(() => game.dispose());
