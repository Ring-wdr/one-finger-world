import type { GameActions } from '../../app/store';

export function SpectateBar({ game }: { game: GameActions }) {
	return (
		<div class="screen">
			<div class="spectate-bar">
				<span>관전 중</span>
				<button class="btn" onClick={() => game.spectateNext()}>
					다음
				</button>
				<button class="btn primary" onClick={() => game.go('match')}>
					다시 하기
				</button>
			</div>
		</div>
	);
}
