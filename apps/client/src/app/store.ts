import { effect, signal } from '@preact/signals';
import type { MatchReward, Profile } from '@ofa/meta';
import type { Tag } from '@ofa/sim';
import type { StageId } from '../game/stages';
import { loadProfile, saveProfile } from '../meta/profile';
import { loadSettings, saveSettings, type Settings } from '../meta/settings';

/**
 * App-wide UI state. The Game writes stage/result/tutorial signals; the preact screens
 * read them and call back into the Game through `GameActions`. Settings and profile
 * persist themselves.
 */

export function safeStorage(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

export type MenuView = 'home' | 'settings' | 'shop';

export interface ResultInfo {
	won: boolean;
	placement: number;
	level: number;
	kills: number;
	time: number;
	tags: { tag: Tag; count: number; on: boolean }[];
	items: string[];
	/** Null for a match that paid out already (re-shown after spectating). */
	reward: MatchReward | null;
	newBest: boolean;
	canSpectate: boolean;
	/** Which kind of match this was; "다시 하기" follows it. */
	mode: 'local' | 'online';
	/** Online only: the payout is queued and shows up with the next profile load. */
	rewardPending: boolean;
	/** A local match under the server profile: no coins (the client cannot be trusted). */
	practice: boolean;
}

export const stage = signal<StageId>('menu');
export const menuView = signal<MenuView>('home');
export const result = signal<ResultInfo | null>(null);
export const tutorialDone = signal(false);

const storage = safeStorage();
export const settings = signal<Settings>(loadSettings(storage));
export const profile = signal<Profile>(loadProfile(storage));
/** Where `profile` comes from; the server one must never overwrite the offline save. */
export const profileSource = signal<'local' | 'server'>('local');

effect(() => saveSettings(storage, settings.value));
effect(() => {
	if (profileSource.value === 'local') saveProfile(storage, profile.value);
});

/** What the screens can ask the game to do. */
export interface GameActions {
	go(next: StageId): void;
	/** Restart whatever mode is running (match or tutorial). */
	restart(): void;
	spectateNext(): void;
}
