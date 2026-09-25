import { effect, signal } from '@preact/signals';
import type { Tag } from '@ofa/sim';
import type { StageId } from '../game/stages';
import { loadProfile, saveProfile, type Profile } from '../meta/profile';
import type { MatchReward } from '../meta/rewards';
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
}

export const stage = signal<StageId>('menu');
export const menuView = signal<MenuView>('home');
export const result = signal<ResultInfo | null>(null);
export const tutorialDone = signal(false);

const storage = safeStorage();
export const settings = signal<Settings>(loadSettings(storage));
export const profile = signal<Profile>(loadProfile(storage));

effect(() => saveSettings(storage, settings.value));
effect(() => saveProfile(storage, profile.value));

/** What the screens can ask the game to do. */
export interface GameActions {
	go(next: StageId): void;
	/** Restart whatever mode is running (match or tutorial). */
	restart(): void;
	spectateNext(): void;
}
