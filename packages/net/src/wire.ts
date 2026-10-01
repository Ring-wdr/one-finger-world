import { POS_SCALE } from './constants';

/** Little-endian byte writer and reader plus the quantizers shared by the codecs. */

const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

export class Writer {
	private bytes = new Uint8Array(256);
	private view = new DataView(this.bytes.buffer);
	private len = 0;

	/** Callers take the offset before touching `view`: growing replaces it. */
	private reserve(n: number): number {
		const at = this.len;
		if (at + n > this.bytes.length) {
			const grown = new Uint8Array(Math.max(this.bytes.length * 2, at + n));
			grown.set(this.bytes);
			this.bytes = grown;
			this.view = new DataView(grown.buffer);
		}
		this.len += n;
		return at;
	}

	u8(v: number): void {
		const at = this.reserve(1);
		this.view.setUint8(at, v);
	}
	i8(v: number): void {
		const at = this.reserve(1);
		this.view.setInt8(at, v);
	}
	u16(v: number): void {
		const at = this.reserve(2);
		this.view.setUint16(at, v, true);
	}
	i16(v: number): void {
		const at = this.reserve(2);
		this.view.setInt16(at, v, true);
	}
	u32(v: number): void {
		const at = this.reserve(4);
		this.view.setUint32(at, v, true);
	}
	f32(v: number): void {
		const at = this.reserve(4);
		this.view.setFloat32(at, v, true);
	}
	f64(v: number): void {
		const at = this.reserve(8);
		this.view.setFloat64(at, v, true);
	}

	finish(): Uint8Array {
		return this.bytes.slice(0, this.len);
	}
}

/** Reads past the end throw RangeError (DataView's own bounds check). */
export class Reader {
	private view: DataView;
	private at = 0;

	constructor(data: ArrayBuffer | Uint8Array) {
		this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
	}

	get length(): number {
		return this.view.byteLength;
	}

	u8(): number {
		return this.view.getUint8(this.at++);
	}
	i8(): number {
		return this.view.getInt8(this.at++);
	}
	u16(): number {
		const v = this.view.getUint16(this.at, true);
		this.at += 2;
		return v;
	}
	i16(): number {
		const v = this.view.getInt16(this.at, true);
		this.at += 2;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.at, true);
		this.at += 4;
		return v;
	}
	f32(): number {
		const v = this.view.getFloat32(this.at, true);
		this.at += 4;
		return v;
	}
	f64(): number {
		const v = this.view.getFloat64(this.at, true);
		this.at += 8;
		return v;
	}
}

/** Sim ids start at 1, so 0 stands for "none". */
export function idToWire(id: number | null): number {
	if (id === null) return 0;
	if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new RangeError(`id ${id} does not fit in u16`);
	return id;
}
export const idFromWire = (v: number): number | null => (v === 0 ? null : v);

export const posToWire = (v: number): number => clamp(Math.round(v * POS_SCALE), -32768, 32767);
export const posFromWire = (v: number): number => v / POS_SCALE;
export const radiusToWire = (r: number): number => clamp(Math.round(r * POS_SCALE), 0, 0xffff);

/** Angle of (x, y) in 256 steps; the & 255 wraps the round-up of a value just below 2π. */
export const angleToWire = (x: number, y: number): number => Math.round((Math.atan2(y, x) / TAU) * 256) & 255;
export const angleFromWire = (b: number): number => (b / 256) * TAU;

/** Fraction of max HP as a byte; living units never encode as 0. */
export const hpToWire = (hp: number, maxHp: number): number => Math.max(1, Math.round(clamp01(hp / maxHp) * 255));
export const shieldToWire = (shield: number, maxHp: number): number => Math.round(clamp01(shield / maxHp) * 255);
export const fractionFromWire = (b: number): number => b / 255;

export const effectRadiusToWire = (r: number): number => clamp(Math.round(r * 16), 0, 255);
export const effectRadiusFromWire = (b: number): number => b / 16;

/** 255 means a full circle; other arcs use 1/40 rad steps up to 254. */
export const arcToWire = (arc: number): number => (arc >= TAU - 1e-6 ? 255 : clamp(Math.round(arc * 40), 0, 254));
export const arcFromWire = (b: number): number => (b === 255 ? TAU : b / 40);
