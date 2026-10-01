import { loading } from '../../app/gameHost';
import { connection, netStats } from '../../app/online';
import { menuView, result, stage, tutorialDone, type GameActions } from '../../app/store';
import type { StageId } from '../../game/stages';
import { LoadingScreen } from './LoadingScreen';
import { MainMenu } from './MainMenu';
import { NetDebug } from './NetDebug';
import { QueueScreen } from './QueueScreen';
import { ResultPanel } from './ResultPanel';
import { SettingsScreen } from './SettingsScreen';
import { ShopScreen } from './ShopScreen';
import { SpectateBar } from './SpectateBar';
import { TutorialDone } from './TutorialDone';

/**
 * Screen layer above the canvas. The stage (game/stages.ts) picks the screen; inside the
 * menu stage `menuView` switches home/settings/shop without touching the game.
 * While the game chunk and models download, a loading screen covers everything.
 * The in-match HUD stays imperative (ui/Hud.ts) — it refreshes every frame.
 */
export function App({ game }: { game: GameActions }) {
	if (loading.value) return <LoadingScreen state={loading.value} />;
	return (
		<>
			<Screen game={game} />
			{connection.value === 'reconnecting' && ONLINE_STAGES.has(stage.value) && <div class="net-badge">재연결 중…</div>}
			{netStats.value && <NetDebug stats={netStats.value} />}
		</>
	);
}

const ONLINE_STAGES: ReadonlySet<StageId> = new Set(['online', 'result', 'spectate']);

function Screen({ game }: { game: GameActions }) {
	switch (stage.value) {
		case 'queue':
			return <QueueScreen game={game} />;
		case 'menu':
			if (menuView.value === 'settings') return <SettingsScreen />;
			if (menuView.value === 'shop') return <ShopScreen />;
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
