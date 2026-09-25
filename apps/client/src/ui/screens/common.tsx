import type { ComponentChildren } from 'preact';
import { STAT_INFO, TAG_INFO, type StatMod, type Tag } from '@ofa/sim';
import { profile } from '../../app/store';

export function Coins({ amount }: { amount?: number }) {
	return <span class="coins">🪙 {(amount ?? profile.value.coins).toLocaleString()}</span>;
}

export function TagChip({ tag, text, on }: { tag: Tag; text: string; on?: boolean }) {
	const t = TAG_INFO[tag];
	return (
		<span class={`tag ${on ? 'on' : ''}`} style={{ '--c': t.color }}>
			{t.icon} {t.label}
			{text}
		</span>
	);
}

export function modText(m: StatMod) {
	const info = STAT_INFO[m.stat];
	const sign = m.value >= 0 ? '+' : '−';
	const abs = Math.abs(m.value);
	const v = info.percent ? `${+(abs * 100).toFixed(1)}%` : `${+abs.toFixed(1)}`;
	return `${info.label} ${sign}${v}`;
}

/** Full-screen menu page: header with back button and coins, scrollable body. */
export function Page({ title, onBack, children }: { title: string; onBack: () => void; children: ComponentChildren }) {
	return (
		<div class="screen page">
			<header class="page-head">
				<button class="btn" onClick={onBack}>
					← 뒤로
				</button>
				<h2>{title}</h2>
				<Coins />
			</header>
			<div class="page-body">{children}</div>
		</div>
	);
}
