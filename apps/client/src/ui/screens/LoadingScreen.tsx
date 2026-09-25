import { cancelLoading, retryLoading, type LoadingState } from '../../app/gameHost';

export function LoadingScreen({ state }: { state: LoadingState }) {
	return (
		<div class="screen center dim">
			<div class="panel loading-panel">
				<h1>{state.next === 'tutorial' ? '📘 튜토리얼' : '⚔ 본 게임'}</h1>
				{state.error ? (
					<>
						<p class="sub">{state.error}</p>
						<div class="row">
							<button class="btn" onClick={cancelLoading}>
								메뉴
							</button>
							<button class="btn primary" onClick={retryLoading}>
								다시 시도
							</button>
						</div>
					</>
				) : (
					<>
						<div class="load-bar">
							<i style={{ width: `${Math.round(state.progress * 100)}%` }} />
						</div>
						<p class="sub">{state.label}</p>
						<p class="muted">처음 한 번만 받아요. 이후에는 바로 시작합니다.</p>
					</>
				)}
			</div>
		</div>
	);
}
