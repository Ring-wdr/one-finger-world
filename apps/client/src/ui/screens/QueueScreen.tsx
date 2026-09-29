import { useEffect, useState } from 'preact/hooks';
import { lobby, lobbyAt, onlineError, onlineErrorCode } from '../../app/online';
import type { GameActions } from '../../app/store';

/** Whole seconds left of the countdown, measured from when the lobby message arrived. */
function useCountdown(): number | null {
	const [now, setNow] = useState(performance.now());
	useEffect(() => {
		const t = setInterval(() => setNow(performance.now()), 250);
		return () => clearInterval(t);
	}, []);
	const l = lobby.value;
	if (!l || l.startsInMs === null) return null;
	return Math.max(0, Math.ceil((l.startsInMs - (now - lobbyAt.value)) / 1000));
}

export function QueueScreen({ game }: { game: GameActions }) {
	const seconds = useCountdown();
	const l = lobby.value;
	const error = onlineError.value;

	if (error) {
		const stale = onlineErrorCode.value === 'version';
		return (
			<div class="screen center dim">
				<div class="panel">
					<h1>매칭 실패</h1>
					<p class="sub">{stale ? '새 버전이 있어요 — 새로고침' : error}</p>
					<div class="row">
						<button class="btn" onClick={() => game.go('menu')}>
							메뉴
						</button>
						{stale ? (
							<button class="btn primary" onClick={() => location.reload()}>
								새로고침
							</button>
						) : (
							<button class="btn primary" onClick={() => game.restart()}>
								다시 시도
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div class="screen center dim">
			<div class="panel">
				<h1>{l ? `대기실 ${l.players.length}/${l.max}` : '매칭 중…'}</h1>
				{l && (
					<>
						<ul class="lobby-list">
							{l.players.map((p, i) => (
								<li key={i} class={p.you ? 'you' : ''}>
									{p.name}
								</li>
							))}
						</ul>
						<p class="sub">{seconds === null ? '다른 플레이어를 기다리는 중' : `${seconds}초 후 시작 · 빈자리는 봇`}</p>
					</>
				)}
				<div class="row">
					<button class="btn" onClick={() => game.go('menu')}>
						취소
					</button>
				</div>
			</div>
		</div>
	);
}
