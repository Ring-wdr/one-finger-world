import type { Command, Vec2 } from '@ofa/sim';
import { DIR_SCALE, MsgType } from './constants';
import { Reader, Writer, clamp } from './wire';

/**
 * Client → server input frames (docs/multiplayer-server-design.md §10.3), 12 bytes:
 *   u8 type=MsgType.Input · u32 seq · u8 flags · i8 moveX · i8 moveY · i8 dashX · i8 dashY
 *   · u8 draftIndex · u8 exchangeIndex
 */
export const INPUT_FRAME_BYTES = 12;

export const InputFlag = {
	Move: 1,
	Run: 2,
	Attack: 4,
	Dash: 8,
	DashTouch: 16,
	Draft: 32,
	Reroll: 64,
	Exchange: 128
} as const;

/** Largest valid indices; out-of-range values drop just that input. */
export const MAX_DRAFT_INDEX = 2;
export const MAX_EXCHANGE_INDEX = 63;

/** One local tick of player input. Directions hold quantized values (see quantizeDir). */
export interface InputFrame {
	/** Local tick number: starts at 1, strictly increasing per connection. */
	seq: number;
	/** Joystick direction this tick, or null when standing. */
	move: Vec2 | null;
	run: boolean;
	attack: boolean;
	/** Set when a dash was requested this tick ((0, 0) dashes the way the fighter faces). */
	dash: Vec2 | null;
	dashTouch: boolean;
	draft: number | null;
	reroll: boolean;
	exchange: number | null;
}

export function emptyFrame(seq: number): InputFrame {
	return { seq, move: null, run: false, attack: false, dash: null, dashTouch: false, draft: null, reroll: false, exchange: null };
}

/**
 * The direction the server will see after the i8 round trip. The client predicts with this exact
 * vector so both ends normalize the same numbers.
 */
export function quantizeDir(d: Vec2): Vec2 {
	// `|| 0` turns Math.round's -0 into the 0 the server decodes, so both ends hold the same bits.
	const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * DIR_SCALE) || 0;
	return { x: q(d.x) / DIR_SCALE, y: q(d.y) / DIR_SCALE };
}

/** Commands for one consumed frame, in the server's fixed order: move, attack, dash, draft, reroll, exchange. */
export function frameToCommands(f: InputFrame): Command[] {
	const cmds: Command[] = [{ type: 'move', dir: f.move, run: f.run }];
	if (f.attack) cmds.push({ type: 'attack' });
	if (f.dash) cmds.push({ type: 'dash', dir: f.dash, touch: f.dashTouch });
	if (f.draft !== null) cmds.push({ type: 'draft', index: f.draft });
	if (f.reroll) cmds.push({ type: 'reroll' });
	if (f.exchange !== null) cmds.push({ type: 'exchange', itemIndex: f.exchange });
	return cmds;
}

const dirToWire = (v: number): number => clamp(Math.round(v * DIR_SCALE), -DIR_SCALE, DIR_SCALE);

export function encodeInput(f: InputFrame): Uint8Array {
	let flags = 0;
	if (f.move) flags |= InputFlag.Move;
	if (f.run) flags |= InputFlag.Run;
	if (f.attack) flags |= InputFlag.Attack;
	if (f.dash) flags |= InputFlag.Dash;
	if (f.dashTouch) flags |= InputFlag.DashTouch;
	if (f.draft !== null) flags |= InputFlag.Draft;
	if (f.reroll) flags |= InputFlag.Reroll;
	if (f.exchange !== null) flags |= InputFlag.Exchange;
	const w = new Writer();
	w.u8(MsgType.Input);
	w.u32(f.seq);
	w.u8(flags);
	w.i8(f.move ? dirToWire(f.move.x) : 0);
	w.i8(f.move ? dirToWire(f.move.y) : 0);
	w.i8(f.dash ? dirToWire(f.dash.x) : 0);
	w.i8(f.dash ? dirToWire(f.dash.y) : 0);
	w.u8(f.draft === null ? 0 : clamp(f.draft, 0, 255));
	w.u8(f.exchange === null ? 0 : clamp(f.exchange, 0, 255));
	return w.finish();
}

/** Null when the frame is malformed (wrong length or type, seq 0). Bad indices only drop that input. */
export function decodeInput(data: ArrayBuffer | Uint8Array): InputFrame | null {
	const r = new Reader(data);
	if (r.length !== INPUT_FRAME_BYTES || r.u8() !== MsgType.Input) return null;
	const seq = r.u32();
	if (seq < 1) return null;
	const flags = r.u8();
	const mx = r.i8();
	const my = r.i8();
	const dx = r.i8();
	const dy = r.i8();
	const draft = r.u8();
	const exchange = r.u8();
	return {
		seq,
		move: flags & InputFlag.Move && (mx !== 0 || my !== 0) ? { x: mx / DIR_SCALE, y: my / DIR_SCALE } : null,
		run: (flags & InputFlag.Run) !== 0,
		attack: (flags & InputFlag.Attack) !== 0,
		dash: flags & InputFlag.Dash ? { x: dx / DIR_SCALE, y: dy / DIR_SCALE } : null,
		dashTouch: (flags & InputFlag.DashTouch) !== 0,
		draft: flags & InputFlag.Draft && draft <= MAX_DRAFT_INDEX ? draft : null,
		reroll: (flags & InputFlag.Reroll) !== 0,
		exchange: flags & InputFlag.Exchange && exchange <= MAX_EXCHANGE_INDEX ? exchange : null
	};
}

/** Whether a frame carries anything besides movement. */
export function hasOneShots(f: InputFrame): boolean {
	return f.attack || f.dash !== null || f.draft !== null || f.reroll || f.exchange !== null;
}

/**
 * When the server drops `from` (queue overflow), keep its one-shots by copying each one into
 * `into` unless `into` already has an input of that kind.
 */
export function mergeOneShots(into: InputFrame, from: InputFrame): void {
	into.attack ||= from.attack;
	into.reroll ||= from.reroll;
	if (into.dash === null && from.dash !== null) {
		into.dash = from.dash;
		into.dashTouch = from.dashTouch;
	}
	if (into.draft === null) into.draft = from.draft;
	if (into.exchange === null) into.exchange = from.exchange;
}
