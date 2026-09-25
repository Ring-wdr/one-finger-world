import { useEffect, useState } from 'preact/hooks';
import { RUNE_SLOT_INFO, RUNE_SLOTS, RUNES, type RuneDef } from '@ofa/sim';
import { menuView, profile, type GameActions } from '../../app/store';
import { buyRune, toggleRune } from '../../meta/profile';
import { modText, Page } from './common';

function runeEffect(r: RuneDef) {
	const parts = r.mods.map(modText);
	if (r.rerolls) parts.push(`시작 리롤 +${r.rerolls}`);
	return parts.join(' · ');
}

export function ShopScreen({ game }: { game: GameActions }) {
	const p = profile.value;
	const [flash, setFlash] = useState<string | null>(null);
	useEffect(() => {
		if (!flash) return;
		const t = setTimeout(() => setFlash(null), 1800);
		return () => clearTimeout(t);
	}, [flash]);

	const act = (r: RuneDef) => {
		if (!p.owned.includes(r.id)) {
			const next = buyRune(p, r.id);
			if (typeof next === 'string') {
				setFlash(next === 'coins' ? `코인이 ${r.cost - p.coins} 부족해요` : null);
				return;
			}
			game.click();
			profile.value = next;
			setFlash(`${r.name} 구매 완료`);
			return;
		}
		game.click();
		profile.value = toggleRune(p, r.id);
		setFlash(null);
	};

	return (
		<Page title="상점 · 룬" onBack={() => (menuView.value = 'home')}>
			<p class="muted shop-note">
				룬은 본 게임 시작 시 적용되는 작은 보너스입니다. 슬롯마다 1개씩 장착하며, 룬 하나는 일반 아이템의 약 1/3 가치예요.
				코인은 본 게임 결과(순위·처치·레벨·생존 시간)로 얻습니다.
			</p>
			{flash && <div class="shop-flash">{flash}</div>}
			{RUNE_SLOTS.map((slot) => (
				<section class="card-box" key={slot}>
					<h3>
						{RUNE_SLOT_INFO[slot].icon} {RUNE_SLOT_INFO[slot].label}
					</h3>
					<div class="rune-grid">
						{RUNES.filter((r) => r.slot === slot).map((r) => {
							const owned = p.owned.includes(r.id);
							const on = p.equipped[slot] === r.id;
							const affordable = p.coins >= r.cost;
							return (
								<button
									key={r.id}
									class={`rune ${owned ? 'owned' : ''} ${on ? 'on' : ''} ${!owned && !affordable ? 'poor' : ''}`}
									onClick={() => act(r)}
								>
									<b>{r.name}</b>
									<span class="effect">{runeEffect(r)}</span>
									<span class="state">{on ? '✓ 장착됨' : owned ? '장착' : `🪙 ${r.cost}`}</span>
								</button>
							);
						})}
					</div>
				</section>
			))}
		</Page>
	);
}
