import type { GameActions } from '../../app/store';

export function TutorialDone({ game }: { game: GameActions }) {
	return (
		<div class="screen center dim">
			<div class="panel">
				<h1>🎓 튜토리얼 완료!</h1>
				<p class="sub">본 게임에서는 자기장이 점점 줄어들고, 11명의 봇과 최후의 1인을 가립니다.</p>
				<ul class="howto">
					<li>외곽은 안전하지만 저효율, 중앙은 위험하지만 고효율</li>
					<li>페이즈마다 드래프트 자원이 바뀝니다: 스탯 → 스킬 → 전설(브릿지)</li>
					<li>처치하면 상대 아이템 1개가 떨어져요</li>
					<li>본 게임 결과로 코인을 얻어 상점에서 룬을 살 수 있어요</li>
				</ul>
				<div class="row">
					<button class="btn" onClick={() => game.go('tutorial')}>
						튜토리얼 다시
					</button>
					<button class="btn" onClick={() => game.go('menu')}>
						메뉴
					</button>
					<button class="btn primary" onClick={() => game.go('match')}>
						본 게임 시작
					</button>
				</div>
			</div>
		</div>
	);
}
