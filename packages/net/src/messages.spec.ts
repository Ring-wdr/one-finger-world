import { describe, expect, it } from 'vitest';
import { MAX_TEXT_MESSAGE } from './constants';
import { parseClientMessage, parseServerMessage } from './messages';

const j = JSON.stringify;

const lobby = { t: 'lobby', matchId: 'm', players: [{ name: 'a', you: true }], max: 12, startsAt: null, serverNow: 1 };
const start = { t: 'start', matchId: 'm', tick: 0, you: 3, fighters: [{ id: 3, name: 'a', color: '#fff', human: true }] };
const self = { t: 'self', items: ['x'], runes: [], offer: null, pendingDrafts: 0, rerolls: 2, exchangeTokens: 0 };
const result = {
	t: 'result',
	placement: 1,
	kills: 2,
	level: 3,
	time: 100,
	reward: { score: 10, coins: 1, breakdown: [{ label: 'win', points: 10 }] },
	coins: 5,
	best: null,
	newBest: false,
	rewardPending: false
};
const end = { t: 'end', winner: null };

describe('parseServerMessage', () => {
	it('accepts every well-formed message kind', () => {
		for (const m of [lobby, start, self, result, end]) expect(parseServerMessage(j(m))).toEqual(m);
		expect(parseServerMessage(j({ ...result, reward: null, coins: null }))).not.toBeNull();
		expect(parseServerMessage(j({ ...self, offer: ['a', 'b'] }))).not.toBeNull();
		expect(parseServerMessage(j({ ...start, you: null }))).not.toBeNull();
		expect(parseServerMessage(j({ ...lobby, startsAt: 123 }))).not.toBeNull();
	});

	it('rejects invalid JSON, non-objects and unknown kinds', () => {
		for (const text of ['', '{', 'null', '[]', '5', '"lobby"', j({}), j({ t: 'nope' }), j({ t: 'toString' }), j({ t: 'constructor' })]) {
			expect(parseServerMessage(text)).toBeNull();
		}
	});

	it('rejects wrong field types and missing fields', () => {
		const bad: unknown[] = [
			{ ...lobby, max: '12' },
			{ ...lobby, players: [{ name: 'a' }] },
			{ ...lobby, players: 'x' },
			{ ...lobby, startsAt: undefined },
			{ ...start, tick: null },
			{ ...start, fighters: [{ id: 1, name: 'a', color: '#fff' }] },
			{ ...start, you: 'a' },
			{ ...self, items: [1] },
			{ ...self, offer: [1] },
			{ ...self, offer: undefined },
			{ ...self, rerolls: null },
			{ ...result, newBest: 1 },
			{ ...result, reward: { score: 1, coins: 1 } },
			{ ...result, reward: { score: 1, coins: 1, breakdown: [{ label: 1, points: 1 }] } },
			{ ...result, reward: { score: 'x', coins: 1, breakdown: [] } },
			{ ...result, placement: '1' },
			{ ...end, winner: 'x' },
			{ ...end, winner: undefined }
		];
		for (const m of bad) expect(parseServerMessage(j(m)), j(m)).toBeNull();
	});

	it('rejects non-finite numbers', () => {
		// JSON has no NaN/Infinity literals; 1e999 parses to Infinity.
		expect(parseServerMessage('{"t":"end","winner":1e999}')).toBeNull();
		expect(parseServerMessage('{"t":"lobby","matchId":"m","players":[],"max":1e999,"startsAt":null,"serverNow":1}')).toBeNull();
	});
});

describe('parseClientMessage', () => {
	it('accepts the three client messages', () => {
		for (const m of [{ t: 'spectate', id: 4 }, { t: 'leave' }, { t: 'stats', rtt: { p50: 20, p95: 40, n: 10 } }]) {
			expect(parseClientMessage(j(m))).toEqual(m);
		}
	});

	it('rejects malformed messages', () => {
		for (const text of [
			'',
			'{',
			j({ t: 'spectate' }),
			j({ t: 'spectate', id: '4' }),
			j({ t: 'stats', rtt: { p50: 1, p95: 2 } }),
			j({ t: 'stats', rtt: null }),
			j({ t: 'lobby' }),
			j([{ t: 'leave' }])
		]) {
			expect(parseClientMessage(text), text).toBeNull();
		}
	});

	it('rejects text over the size limit, counting bytes', () => {
		const pad = (n: number) => j({ t: 'leave', pad: 'x'.repeat(n) });
		const room = MAX_TEXT_MESSAGE - pad(0).length;
		expect(parseClientMessage(pad(room))).not.toBeNull();
		expect(parseClientMessage(pad(room + 1))).toBeNull();
		// Two-byte characters: under the limit in characters, over it in bytes.
		expect(parseClientMessage(j({ t: 'leave', pad: 'é'.repeat(room) }))).toBeNull();
	});
});
