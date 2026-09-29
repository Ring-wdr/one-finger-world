/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Origin of the multiplayer API; empty means the page's own origin. */
	readonly VITE_API_ORIGIN?: string;
}
