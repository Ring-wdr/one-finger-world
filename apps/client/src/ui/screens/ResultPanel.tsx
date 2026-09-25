import { getItem } from '@ofa/sim';
import type { GameActions, ResultInfo } from '../../app/store';
import { Coins, TagChip } from './common';

export function ResultPanel({ game, info }: { game: GameActions; info: ResultInfo }) {
	const r = info.reward;
	return (
		<div class="screen center dim">
			<div class="panel">
				<h1>{info.won ? '🏆 최후의 1인!' : `#${info.placement} 탈락`}</h1>
				<p class="sub">
					Lv {info.level} · 처치 {info.kills} · {Math.floor(info.time)}초 생존
				</p>
				<div class="tags">
					{info.tags.map((t) => (
						<TagChip key={t.tag} tag={t.tag} text={` ${t.count}`} on={t.on} />
					))}
				</div>
				<p class="items">{info.items.map((id) => getItem(id).name).join(', ') || '없음'}</p>

				{r && (
					<div class="reward">
						<ul>
							{r.breakdown.map((b) => (
								<li key={b.label}>
									<span>{b.label}</span>
									<b>{b.points.toLocaleString()}</b>
								</li>
							))}
						</ul>
						<div class="reward-total">
							<span>
								점수 <b>{r.score.toLocaleString()}</b>
								{info.newBest && <em class="new-best">최고 기록!</em>}
							</span>
							<span class="gain">+🪙 {r.coins}</span>
						</div>
						<div class="muted">
							보유 <Coins />
						</div>
					</div>
				)}

				<div class="row">
					<button class="btn" onClick={() => game.go('menu')}>
						메뉴
					</button>
					<button class="btn primary" onClick={() => game.restart()}>
						다시 하기
					</button>
					{info.canSpectate && (
						<button class="btn" onClick={() => game.go('spectate')}>
							관전
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
