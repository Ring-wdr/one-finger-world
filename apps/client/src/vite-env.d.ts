/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Origin of the multiplayer API; empty means the page's own origin. */
	readonly VITE_API_ORIGIN?: string;
	/** "1" builds the single-player-only site (GitHub Pages): no API probe, no online menu, local profile. */
	readonly VITE_OFFLINE_ONLY?: string;
}
