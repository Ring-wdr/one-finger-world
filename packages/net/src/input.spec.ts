import { describe, expect, it } from 'vitest';
import { MsgType } from './constants';
import { INPUT_FRAME_BYTES, InputFlag, decodeInput, emptyFrame, encodeInput, hasOneShots, mergeOneShots, quantizeDir, type InputFrame } from './input';

/** Small deterministic PRNG so the flag sweep is reproducible. */
function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

describe('input codec', () => {
	it('encodes exactly 12 bytes with the documented layout', () => {
		const f: InputFrame = { ...emptyFrame(0x01020304), move: { x: 1, y: -1 }, run: true, attack: true, draft: 2, exchange: 63 };
		const b = encodeInput(f);
		expect(b.length).toBe(INPUT_FRAME_BYTES);
		expect(b[0]).toBe(MsgType.Input);
		expect([...b.slice(1, 5)]).toEqual([4, 3, 2, 1]);
		expect(b[5]).toBe(InputFlag.Move | InputFlag.Run | InputFlag.Attack | InputFlag.Draft | InputFlag.Exchange);
		expect(new Int8Array(b.buffer, 6, 2)).toEqual(new Int8Array([127, -127]));
		expect(b[10]).toBe(2);
		expect(b[11]).toBe(63);
	});

	it('round-trips extreme and diagonal directions exactly', () => {
		const dirs = [
			{ x: 1, y: 0 },
			{ x: -1, y: 0 },
			{ x: 0, y: -1 },
			{ x: Math.SQRT1_2, y: Math.SQRT1_2 },
			{ x: -Math.SQRT1_2, y: Math.SQRT1_2 },
			{ x: 1 / 127, y: -1 / 127 },
			// Rounds to -0 before the fix; the server only ever decodes +0.
			{ x: -0.001, y: 1 }
		].map(quantizeDir);
		for (const d of dirs) {
			const f = { ...emptyFrame(1), move: d, dash: d, dashTouch: true };
			expect(decodeInput(encodeInput(f))).toEqual(f);
		}
	});

	it('round-trips random flag combinations', () => {
		const rnd = lcg(7);
		const dir = () => quantizeDir({ x: rnd() * 2 - 1, y: rnd() * 2 - 1 });
		for (let i = 0; i < 500; i++) {
			const move = rnd() < 0.5 ? dir() : null;
			const f: InputFrame = {
				seq: 1 + Math.floor(rnd() * 0xfffffffe),
				// A (0, 0) move decodes as "standing", so only keep non-zero vectors.
				move: move && (move.x !== 0 || move.y !== 0) ? move : null,
				run: rnd() < 0.5,
				attack: rnd() < 0.5,
				dash: rnd() < 0.5 ? dir() : null,
				dashTouch: rnd() < 0.5,
				draft: rnd() < 0.5 ? Math.floor(rnd() * 3) : null,
				reroll: rnd() < 0.5,
				exchange: rnd() < 0.5 ? Math.floor(rnd() * 64) : null
			};
			expect(decodeInput(encodeInput(f))).toEqual(f);
		}
	});

	it('treats a move flag with a zero vector as standing, and keeps a (0, 0) dash', () => {
		const zero = { x: 0, y: 0 };
		const out = decodeInput(encodeInput({ ...emptyFrame(1), move: zero, dash: zero }));
		expect(out?.move).toBeNull();
		expect(out?.dash).toEqual(zero);
	});

	it('accepts an ArrayBuffer and honours the byteOffset of a view', () => {
		const f = { ...emptyFrame(9), attack: true };
		const b = encodeInput(f);
		expect(decodeInput(b.buffer as ArrayBuffer)).toEqual(f);
		const padded = new Uint8Array(20);
		padded.set(b, 5);
		expect(decodeInput(padded.subarray(5, 5 + INPUT_FRAME_BYTES))).toEqual(f);
	});

	it('rejects wrong lengths, wrong type and seq 0', () => {
		const good = encodeInput(emptyFrame(1));
		expect(decodeInput(good.slice(0, 11))).toBeNull();
		expect(decodeInput(new Uint8Array(13))).toBeNull();
		expect(decodeInput(new Uint8Array(0))).toBeNull();
		const wrongType = good.slice();
		wrongType[0] = MsgType.Snapshot;
		expect(decodeInput(wrongType)).toBeNull();
		expect(decodeInput(encodeInput(emptyFrame(0)))).toBeNull();
	});

	it('drops only the input whose index is out of range', () => {
		const b = encodeInput({ ...emptyFrame(3), attack: true, draft: 0, exchange: 0, reroll: true });
		b[10] = 3;
		let out = decodeInput(b)!;
		expect(out.draft).toBeNull();
		expect(out.exchange).toBe(0);
		expect(out.attack && out.reroll).toBe(true);
		b[10] = 2;
		b[11] = 64;
		out = decodeInput(b)!;
		expect(out.draft).toBe(2);
		expect(out.exchange).toBeNull();
	});

	it('ignores payload bytes whose flag is not set', () => {
		const b = encodeInput(emptyFrame(1));
		b.set([50, 50, 50, 50, 1, 1], 6);
		expect(decodeInput(b)).toEqual(emptyFrame(1));
	});
});

describe('one-shots', () => {
	it('hasOneShots ignores movement but sees every one-shot', () => {
		expect(hasOneShots(emptyFrame(1))).toBe(false);
		expect(hasOneShots({ ...emptyFrame(1), move: { x: 1, y: 0 }, run: true })).toBe(false);
		for (const patch of [{ attack: true }, { dash: { x: 0, y: 0 } }, { draft: 0 }, { reroll: true }, { exchange: 0 }]) {
			expect(hasOneShots({ ...emptyFrame(1), ...patch })).toBe(true);
		}
	});

	it('mergeOneShots ORs attack and reroll', () => {
		const into = { ...emptyFrame(2), attack: true };
		mergeOneShots(into, { ...emptyFrame(1), reroll: true });
		expect(into.attack && into.reroll).toBe(true);
		const other = emptyFrame(2);
		mergeOneShots(other, { ...emptyFrame(1), attack: true });
		expect(other.attack).toBe(true);
	});

	it('mergeOneShots copies dash (with touch), draft and exchange only into empty slots', () => {
		const into = emptyFrame(2);
		mergeOneShots(into, { ...emptyFrame(1), dash: { x: 1, y: 0 }, dashTouch: true, draft: 1, exchange: 5 });
		expect(into).toMatchObject({ dash: { x: 1, y: 0 }, dashTouch: true, draft: 1, exchange: 5 });

		const taken = { ...emptyFrame(2), dash: { x: 0, y: 1 }, dashTouch: false, draft: 0, exchange: 0 };
		mergeOneShots(taken, { ...emptyFrame(1), dash: { x: 1, y: 0 }, dashTouch: true, draft: 2, exchange: 9 });
		expect(taken).toMatchObject({ dash: { x: 0, y: 1 }, dashTouch: false, draft: 0, exchange: 0 });
	});

	it('mergeOneShots leaves the movement of the surviving frame alone', () => {
		const into = { ...emptyFrame(2), move: { x: 0, y: 1 }, run: true };
		mergeOneShots(into, { ...emptyFrame(1), move: { x: 1, y: 0 }, attack: true });
		expect(into.move).toEqual({ x: 0, y: 1 });
		expect(into.run).toBe(true);
	});
});

describe('quantizeDir', () => {
	it('never returns -0, matching what the server decodes', () => {
		const q = quantizeDir({ x: -0.001, y: -0.002 });
		expect(Object.is(q.x, -0)).toBe(false);
		expect(Object.is(q.y, -0)).toBe(false);
	});
});
