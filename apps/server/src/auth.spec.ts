import { describe, expect, it } from 'vitest';
import { signToken, verifyGuest, verifyTicket, TICKET_TTL_MS, type GuestClaims, type TicketClaims } from './auth';

const SECRET = 'unit-secret-0123456789abcdef0123456789';
const guest: GuestClaims = { typ: 'guest', sub: 'u-1', iat: 1000 };
const ticket: TicketClaims = { typ: 'ticket', sub: 'u-1', mid: 'a'.repeat(64), name: '날쌘여우27', runes: ['r1', 'r2'], iat: 1000, exp: 1000 + TICKET_TTL_MS };

const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('tokens', () => {
	it('round trips a guest token', async () => {
		expect(await verifyGuest(SECRET, await signToken(SECRET, guest))).toEqual(guest);
	});

	it('round trips a ticket with a Korean name', async () => {
		expect(await verifyTicket(SECRET, await signToken(SECRET, ticket), 2000)).toEqual(ticket);
	});

	it('rejects a tampered payload', async () => {
		const [, sig] = (await signToken(SECRET, guest)).split('.');
		const forged = b64(JSON.stringify({ ...guest, sub: 'u-2' }));
		expect(await verifyGuest(SECRET, `${forged}.${sig}`)).toBeNull();
	});

	it('rejects a tampered signature', async () => {
		const [payload, sig] = (await signToken(SECRET, guest)).split('.');
		const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
		expect(await verifyGuest(SECRET, `${payload}.${flipped}`)).toBeNull();
	});

	it('rejects a token signed with another secret', async () => {
		expect(await verifyGuest(SECRET, await signToken('other-secret', guest))).toBeNull();
	});

	it('rejects the wrong token type', async () => {
		expect(await verifyGuest(SECRET, await signToken(SECRET, ticket))).toBeNull();
		expect(await verifyTicket(SECRET, await signToken(SECRET, guest), 2000)).toBeNull();
	});

	it('rejects an expired ticket, including at the exact expiry', async () => {
		const token = await signToken(SECRET, ticket);
		expect(await verifyTicket(SECRET, token, ticket.exp - 1)).not.toBeNull();
		expect(await verifyTicket(SECRET, token, ticket.exp)).toBeNull();
	});

	it('rejects claims with missing or mistyped fields', async () => {
		const bad = [{ typ: 'guest', iat: 1 }, { typ: 'guest', sub: 5, iat: 1 }, { typ: 'guest', sub: 'u' }];
		for (const claims of bad) expect(await verifyGuest(SECRET, await signToken(SECRET, claims as never))).toBeNull();
		const noRunes = { ...ticket, runes: 'x' };
		expect(await verifyTicket(SECRET, await signToken(SECRET, noRunes as never), 2000)).toBeNull();
	});

	it('returns null for garbage without throwing', async () => {
		for (const s of ['', '.', 'a.b.c', 'abc', '%%%.%%%', '日本語.日本語', `${b64('not json')}.AAAA`]) {
			expect(await verifyGuest(SECRET, s)).toBeNull();
			expect(await verifyTicket(SECRET, s, 0)).toBeNull();
		}
	});
});
