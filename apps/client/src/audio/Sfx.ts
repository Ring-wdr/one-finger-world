/**
 * Synthesized sound effects (WebAudio oscillators + noise, no asset files).
 * The context is created lazily on the first user gesture, as mobile browsers require.
 */
export type SfxId =
	| 'ui'
	| 'swing'
	| 'hit'
	| 'crit'
	| 'hurt'
	| 'dash'
	| 'levelUp'
	| 'synergy'
	| 'pickup'
	| 'kill'
	| 'win'
	| 'lose'
	| 'coin';

interface Tone {
	type: OscillatorType | 'noise';
	from: number;
	to?: number;
	dur: number;
	gain: number;
	delay?: number;
}

const SOUNDS: Record<SfxId, Tone[]> = {
	ui: [{ type: 'triangle', from: 660, to: 880, dur: 0.06, gain: 0.25 }],
	swing: [{ type: 'noise', from: 2200, to: 900, dur: 0.09, gain: 0.18 }],
	hit: [{ type: 'square', from: 220, to: 110, dur: 0.07, gain: 0.16 }],
	crit: [
		{ type: 'square', from: 330, to: 140, dur: 0.09, gain: 0.2 },
		{ type: 'triangle', from: 1320, to: 990, dur: 0.08, gain: 0.14, delay: 0.02 }
	],
	hurt: [{ type: 'sawtooth', from: 160, to: 70, dur: 0.14, gain: 0.2 }],
	dash: [{ type: 'noise', from: 600, to: 3200, dur: 0.16, gain: 0.2 }],
	levelUp: [523, 659, 784, 1047].map((f, i) => ({ type: 'triangle' as const, from: f, dur: 0.12, gain: 0.22, delay: i * 0.07 })),
	synergy: [
		{ type: 'sine', from: 440, to: 880, dur: 0.35, gain: 0.25 },
		{ type: 'triangle', from: 660, to: 1320, dur: 0.35, gain: 0.15, delay: 0.05 }
	],
	pickup: [
		{ type: 'triangle', from: 880, dur: 0.06, gain: 0.2 },
		{ type: 'triangle', from: 1175, dur: 0.08, gain: 0.2, delay: 0.06 }
	],
	kill: [
		{ type: 'square', from: 392, dur: 0.08, gain: 0.16 },
		{ type: 'square', from: 587, dur: 0.14, gain: 0.16, delay: 0.08 }
	],
	win: [523, 659, 784, 1047, 1319].map((f, i) => ({ type: 'triangle' as const, from: f, dur: 0.22, gain: 0.24, delay: i * 0.1 })),
	lose: [392, 330, 262].map((f, i) => ({ type: 'sine' as const, from: f, to: f * 0.97, dur: 0.3, gain: 0.24, delay: i * 0.16 })),
	coin: [
		{ type: 'square', from: 988, dur: 0.05, gain: 0.12 },
		{ type: 'square', from: 1319, dur: 0.18, gain: 0.12, delay: 0.05 }
	]
};

/** Same sound within this window is dropped (a 3-target cleave shouldn't triple the volume). */
const MIN_GAP = 0.045;

export class Sfx {
	private ctx: AudioContext | null = null;
	private out: GainNode | null = null;
	private noise: AudioBuffer | null = null;
	private volume = 0.7;
	private readonly lastPlayed = new Map<SfxId, number>();

	constructor() {
		window.addEventListener('pointerdown', this.unlock, { passive: true });
		window.addEventListener('keydown', this.unlock);
	}

	setVolume(v: number) {
		this.volume = v;
		if (this.out && this.ctx) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
	}

	private readonly unlock = () => {
		if (!this.ctx) {
			const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!Ctor) return;
			this.ctx = new Ctor();
			this.out = this.ctx.createGain();
			this.out.gain.value = this.volume;
			this.out.connect(this.ctx.destination);
			const len = Math.floor(this.ctx.sampleRate * 0.3);
			this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
			const data = this.noise.getChannelData(0);
			for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
		}
		if (this.ctx.state === 'suspended') void this.ctx.resume();
	};

	play(id: SfxId) {
		const ctx = this.ctx;
		if (!ctx || !this.out || this.volume <= 0 || ctx.state !== 'running') return;
		const now = ctx.currentTime;
		if (now - (this.lastPlayed.get(id) ?? -1) < MIN_GAP) return;
		this.lastPlayed.set(id, now);
		for (const t of SOUNDS[id]) this.tone(ctx, this.out, t, now + (t.delay ?? 0));
	}

	private tone(ctx: AudioContext, out: AudioNode, t: Tone, at: number) {
		const env = ctx.createGain();
		env.gain.setValueAtTime(0.0001, at);
		env.gain.exponentialRampToValueAtTime(t.gain, at + 0.008);
		env.gain.exponentialRampToValueAtTime(0.0001, at + t.dur);
		env.connect(out);

		let src: AudioScheduledSourceNode;
		if (t.type === 'noise') {
			// Band-passed noise; the sweep is on the filter.
			const n = ctx.createBufferSource();
			n.buffer = this.noise;
			const bp = ctx.createBiquadFilter();
			bp.type = 'bandpass';
			bp.Q.value = 1.2;
			bp.frequency.setValueAtTime(t.from, at);
			if (t.to) bp.frequency.exponentialRampToValueAtTime(t.to, at + t.dur);
			n.connect(bp).connect(env);
			src = n;
		} else {
			const o = ctx.createOscillator();
			o.type = t.type;
			o.frequency.setValueAtTime(t.from, at);
			if (t.to) o.frequency.exponentialRampToValueAtTime(t.to, at + t.dur);
			o.connect(env);
			src = o;
		}
		src.start(at);
		src.stop(at + t.dur + 0.02);
	}

	dispose() {
		window.removeEventListener('pointerdown', this.unlock);
		window.removeEventListener('keydown', this.unlock);
		void this.ctx?.close();
	}
}
