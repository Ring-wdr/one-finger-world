import { useState } from 'preact/hooks';
import { sfx } from '../../app/sound';
import { menuView, settings } from '../../app/store';
import {
	INPUT_THRESHOLD_PRESETS,
	INPUT_THRESHOLD_RANGES,
	type InputThresholdOptions,
	type InputThresholdPresetId
} from '../../input/inputThresholdOptions';
import { defaultSettings, type Settings } from '../../meta/settings';
import { seenHints } from '../hints';
import { Page } from './common';

const PRESET_IDS = Object.keys(INPUT_THRESHOLD_PRESETS) as InputThresholdPresetId[];

const INPUT_FIELDS: { key: keyof InputThresholdOptions; label: string; help: string }[] = [
	{ key: 'tapMs', label: '탭 인식 시간', help: '길수록 느린 탭도 공격으로 인식' },
	{ key: 'dragStartPx', label: '드래그 시작 거리', help: '짧을수록 살짝 움직여도 이동 시작' },
	{ key: 'fastDragPxPerMs', label: '대시 스와이프 속도', help: '낮을수록 느린 스와이프도 대시' }
];

function presetOf(o: InputThresholdOptions): InputThresholdPresetId | null {
	return (
		PRESET_IDS.find((id) => {
			const v = INPUT_THRESHOLD_PRESETS[id].values;
			return v.tapMs === o.tapMs && v.dragStartPx === o.dragStartPx && v.fastDragPxPerMs === o.fastDragPxPerMs;
		}) ?? null
	);
}

export function SettingsScreen() {
	const s = settings.value;
	const [hintsReset, setHintsReset] = useState(false);
	const patch = (p: Partial<Settings>) => (settings.value = { ...settings.value, ...p });
	const patchInput = (p: Partial<InputThresholdOptions>) => patch({ input: { ...settings.value.input, ...p } });
	const preset = presetOf(s.input);

	return (
		<Page title="설정" onBack={() => (menuView.value = 'home')}>
			<section class="card-box">
				<h3>사운드</h3>
				<label class="field">
					<span>효과음 볼륨</span>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(s.volume * 100)}
						disabled={s.muted}
						onInput={(e) => patch({ volume: Number(e.currentTarget.value) / 100 })}
						onChange={() => sfx.play('ui')}
					/>
					<b>{s.muted ? '꺼짐' : `${Math.round(s.volume * 100)}`}</b>
				</label>
				<label class="field toggle">
					<span>음소거</span>
					<input type="checkbox" checked={s.muted} onChange={(e) => patch({ muted: e.currentTarget.checked })} />
				</label>
				<label class="field toggle">
					<span>피격 진동</span>
					<input type="checkbox" checked={s.vibrate} onChange={(e) => patch({ vibrate: e.currentTarget.checked })} />
				</label>
			</section>

			<section class="card-box">
				<h3>터치 감도</h3>
				<div class="row presets">
					{PRESET_IDS.map((id) => (
						<button
							key={id}
							class={`btn ${preset === id ? 'on' : ''}`}
							onClick={() => {
								sfx.play('ui');
								patch({ input: { ...INPUT_THRESHOLD_PRESETS[id].values } });
							}}
						>
							{INPUT_THRESHOLD_PRESETS[id].label}
						</button>
					))}
					<span class="muted">{preset ? '' : '사용자 지정'}</span>
				</div>
				{INPUT_FIELDS.map(({ key, label, help }) => {
					const r = INPUT_THRESHOLD_RANGES[key];
					const v = s.input[key];
					return (
						<label class="field" key={key}>
							<span>
								{label}
								<small>{help}</small>
							</span>
							<input
								type="range"
								min={r.min}
								max={r.max}
								step={r.step}
								value={v}
								onInput={(e) => patchInput({ [key]: Number(e.currentTarget.value) })}
							/>
							<b>
								{key === 'fastDragPxPerMs' ? v.toFixed(1) : v}
								<small>{r.unit}</small>
							</b>
						</label>
					);
				})}
			</section>

			<section class="card-box">
				<h3>기타</h3>
				<div class="row wrap">
					<button
						class="btn"
						disabled={hintsReset}
						onClick={() => {
							seenHints.reset();
							setHintsReset(true);
						}}
					>
						{hintsReset ? '힌트 초기화됨' : '본 게임 힌트 다시 보기'}
					</button>
					<button class="btn" onClick={() => (settings.value = defaultSettings())}>
						설정 기본값으로
					</button>
				</div>
			</section>
		</Page>
	);
}
