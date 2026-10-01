import { ITEMS, RUNES, SKILLS, TAGS, WEAPON_IDS, type SkillId, type Tag } from '@ofa/sim';

/**
 * Protocol constants shared by client and server. See docs/multiplayer-server-design.md §10.
 * Changing a byte layout or message shape means bumping PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 1;

/** One sim tick (the sim runs at 20 Hz). */
export const TICK_MS = 50;
export const MAX_HUMANS = 12;
export const MATCH_FIGHTERS = 12;

/** Area of interest: a circle ahead of the focus, sized to the fixed camera's view (§10.5). */
export const AOI_RADIUS = 46;
export const AOI_NORTH_OFFSET = 8;
/** Extra reach for positional events, so effects at the view's edge still play. */
export const EVENT_MARGIN = 4;

/** Fixed-point scale for i16 positions and u16 radii: ±255 world units at 1/128 precision. */
export const POS_SCALE = 128;
/** Directions travel as i8 components of q / 127. */
export const DIR_SCALE = 127;

/** Server-side input buffer per seat; older frames are dropped (one-shots merged) past this. */
export const INPUT_QUEUE_MAX = 4;
/** Remote entities render this many ticks behind the estimated server tick, plus jitter. */
export const INTERP_DELAY_TICKS = 2;
export const MAX_INTERP_DELAY_TICKS = 5;
/** Text frames longer than this are ignored. */
export const MAX_TEXT_MESSAGE = 512;

/** Answered by the runtime without waking the Durable Object (setWebSocketAutoResponse). */
export const PING = 'ping';
export const PONG = 'pong';

export const MsgType = { Input: 1, Snapshot: 2 } as const;

export const Close = {
	Normal: 1000,
	Replaced: 4001,
	Full: 4002,
	Started: 4003,
	Ended: 4004,
	BadSeat: 4005,
	Version: 4006,
	Flood: 4007,
	ServerError: 4010
} as const;
export type CloseCode = (typeof Close)[keyof typeof Close];

// ── Index tables. The wire carries indices into these, so both ends must list them in the
// same order; DATA_HASH below makes a mismatch refuse the connection instead of garbling.

export const ITEM_IDS: readonly string[] = ITEMS.map((i) => i.id);
export const SKILL_IDS: readonly SkillId[] = Object.keys(SKILLS) as SkillId[];
export const TAG_IDS: readonly Tag[] = TAGS;
export { WEAPON_IDS };

const indexer = (ids: readonly string[]) => {
	const map = new Map(ids.map((id, i) => [id, i]));
	return (id: string): number => {
		const i = map.get(id);
		if (i === undefined) throw new RangeError(`unknown id "${id}"`);
		return i;
	};
};
export const itemIndex = indexer(ITEM_IDS);
export const skillIndex = indexer(SKILL_IDS);
export const tagIndex = indexer(TAG_IDS);
export const weaponIndex = indexer(WEAPON_IDS);

/** 32-bit FNV-1a, hex. */
export function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** Fingerprint of the protocol version and every index table the wire relies on. */
export const DATA_HASH = fnv1a(
	[
		PROTOCOL_VERSION,
		ITEMS.map((i) => `${i.id}:${i.kind}`).join(','),
		WEAPON_IDS.join(','),
		TAG_IDS.join(','),
		SKILL_IDS.join(','),
		RUNES.map((r) => r.id).join(',')
	].join('|')
);
