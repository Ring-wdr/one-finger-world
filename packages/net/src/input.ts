import type { Command, Vec2 } from '@ofa/sim';
import { DIR_SCALE } from './constants';
import { todo } from './todo';

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
	const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * DIR_SCALE);
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

export function encodeInput(f: InputFrame): Uint8Array {
	return todo('T3', f);
}

/** Null when the frame is malformed (wrong length or type, seq 0). Bad indices only drop that input. */
export function decodeInput(data: ArrayBuffer | Uint8Array): InputFrame | null {
	return todo('T3', data);
}

/** Whether a frame carries anything besides movement. */
export function hasOneShots(f: InputFrame): boolean {
	return todo('T3', f);
}

/**
 * When the server drops `from` (queue overflow), keep its one-shots by copying each one into
 * `into` unless `into` already has an input of that kind.
 */
export function mergeOneShots(into: InputFrame, from: InputFrame): void {
	todo('T3', into, from);
}
