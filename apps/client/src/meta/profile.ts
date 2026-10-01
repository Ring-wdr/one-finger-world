import { defaultProfile, parseProfile, type Profile } from '@ofa/meta';

/** Local (offline) persistence of the profile; the rules live in @ofa/meta. */

export const PROFILE_STORAGE_KEY = 'ofa.profile.v1';

export function loadProfile(storage: Storage | undefined): Profile {
	try {
		const raw = storage?.getItem(PROFILE_STORAGE_KEY);
		return raw ? parseProfile(JSON.parse(raw)) : defaultProfile();
	} catch {
		return defaultProfile();
	}
}

export function saveProfile(storage: Storage | undefined, p: Profile) {
	try {
		storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(p));
	} catch {
		// Private mode / quota: progress lasts for this session only.
	}
}
