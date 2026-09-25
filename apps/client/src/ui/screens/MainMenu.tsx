import { getRune, RUNE_SLOT_INFO, RUNE_SLOTS } from '@ofa/sim';
import { sfx } from '../../app/sound';
import { menuView, profile, type GameActions, type MenuView } from '../../app/store';
import { Coins } from './common';

export function MainMenu({ game }: { game: GameActions }) {
	const p = profile.value;
	const open = (v: MenuView) => {
		sfx.play('ui');
		menuView.value = v;
	};
	return (
		<div class="screen center">
			<div class="panel menu-panel">
				<div class="menu-top">
					<Coins />
					{p.best > 0 && <span class="best">최고 점수 {p.best.toLocaleString()}</span>}
				</div>
				<h1>One Finger Royale</h1>
				<p class="sub">한 손가락 3D 육성 배틀로얄 · 봇 11명</p>

				<button class="btn big primary play" onClick={() => game.go('match')}>
					⚔ 본 게임
					<small>순위·처치·레벨에 따라 코인 획득</small>
				</button>
				<div class="loadout" onClick={() => open('shop')}>
					{RUNE_SLOTS.map((slot) => {
						const id = p.equipped[slot];
						return (
							<span key={slot} class={`rune-pill ${id ? 'on' : ''}`}>
								{RUNE_SLOT_INFO[slot].icon} {id ? getRune(id)!.name : '비어 있음'}
							</span>
						);
					})}
				</div>

				<div class="row menu">
					<button class="btn big" onClick={() => game.go('tutorial')}>
						📘 튜토리얼
						<small>조작·빌드 연습 (약 3분)</small>
					</button>
					<button class="btn big" onClick={() => open('shop')}>
						🛒 상점
						<small>룬 구매·장착</small>
					</button>
					<button class="btn big" onClick={() => open('settings')}>
						⚙ 설정
						<small>사운드·터치 감도</small>
					</button>
				</div>

				<details class="howto-box">
					<summary>조작법</summary>
					<ul class="howto">
						<li>
							<b>시작 무기</b>로 근접/원거리가 정해집니다. 드래프트의 무기 카드로 교체 가능
						</li>
						<li>
							<b>탭</b> 공격 (자동 조준 · 3연타) · <b>드래그</b> 이동, 멀리 끌면 달리기
						</li>
						<li>
							<b>빠르게 두 번 스와이프</b> 대시 (무적)
						</li>
						<li>
							<b>레벨업</b> 버튼으로 3장 중 1장 선택 — 같은 태그 3·5개에서 시너지 발동
						</li>
					</ul>
					<p class="keys">키보드: WASD 이동 · Space 공격 · Shift 대시 · E 드래프트 · 1/2/3 선택 · R 리롤 · B 빌드</p>
				</details>
			</div>
		</div>
	);
}
