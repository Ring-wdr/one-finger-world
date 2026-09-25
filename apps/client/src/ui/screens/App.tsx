import { menuView, result, stage, tutorialDone, type GameActions } from '../../app/store';
import { MainMenu } from './MainMenu';
import { ResultPanel } from './ResultPanel';
import { SettingsScreen } from './SettingsScreen';
import { ShopScreen } from './ShopScreen';
import { SpectateBar } from './SpectateBar';
import { TutorialDone } from './TutorialDone';

/**
 * Screen layer above the canvas. The stage (game/stages.ts) picks the screen; inside the
 * menu stage `menuView` switches home/settings/shop without touching the game.
 * The in-match HUD stays imperative (ui/Hud.ts) — it refreshes every frame.
 */
export function App({ game }: { game: GameActions }) {
	switch (stage.value) {
		case 'menu':
			if (menuView.value === 'settings') return <SettingsScreen game={game} />;
			if (menuView.value === 'shop') return <ShopScreen game={game} />;
			return <MainMenu game={game} />;
		case 'result':
			return result.value ? <ResultPanel game={game} info={result.value} /> : null;
		case 'spectate':
			return <SpectateBar game={game} />;
		case 'tutorial':
			return tutorialDone.value ? <TutorialDone game={game} /> : null;
		default:
			return null;
	}
}
