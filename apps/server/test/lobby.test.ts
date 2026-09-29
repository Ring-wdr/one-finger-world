import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MAX_HUMANS } from '@ofa/net';
import { OPEN_WINDOW_MS, type Lobby } from '../src/lobby';

// A fresh named lobby per test: the real one is a singleton, but the class does not care about the name.
const lobbyFor = () => env.LOBBY.getByName(`test-${crypto.randomUUID()}`);
const uid = () => crypto.randomUUID();

describe('Lobby', () => {
	it('groups uids arriving within the window into one match', async () => {
		const lobby = lobbyFor();
		const a = await lobby.assign(uid());
		const b = await lobby.assign(uid());
		expect(b.matchId).toBe(a.matchId);
		expect(a.matchId).toMatch(/^[0-9a-f]{64}$/);
	});

	it('gives the same uid the same match', async () => {
		const lobby = lobbyFor();
		const u = uid();
		const first = await lobby.assign(u);
		await lobby.assign(uid());
		expect(await lobby.assign(u)).toEqual(first);
		// A repeat must not take a second seat: 11 distinct uids so far, so the 12th still fits.
		for (let i = 0; i < MAX_HUMANS - 3; i++) await lobby.assign(uid());
		expect((await lobby.assign(uid())).matchId).toBe(first.matchId);
	});

	it('opens a new match for the 13th human', async () => {
		const lobby = lobbyFor();
		const first = await lobby.assign(uid());
		for (let i = 1; i < MAX_HUMANS; i++) expect((await lobby.assign(uid())).matchId).toBe(first.matchId);
		const next = await lobby.assign(uid());
		expect(next.matchId).not.toBe(first.matchId);
		expect((await lobby.assign(uid())).matchId).toBe(next.matchId);
	});

	it('opens a new match once the window has expired', async () => {
		const lobby = lobbyFor();
		const u = uid();
		const first = await lobby.assign(u);
		await runInDurableObject(lobby, (_instance: Lobby, state) => {
			const open = state.storage.kv.get<{ createdAt: number }>('open')!;
			state.storage.kv.put('open', { ...open, createdAt: Date.now() - OPEN_WINDOW_MS - 1 });
		});
		const next = await lobby.assign(u);
		expect(next.matchId).not.toBe(first.matchId);
	});
});
