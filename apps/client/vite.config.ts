import { defineConfig } from 'vite';

/** Set by `bun run dev:online` (scripts/dev-online.ts): wrangler dev serves the API behind the page's own origin. */
const apiProxy = process.env.OFA_API_PROXY;

export default defineConfig({
	server: {
		port: Number(process.env.PORT) || 5173,
		// Only when the Worker runs; plain `bun run dev` stays offline without proxy errors.
		proxy: apiProxy ? { '/api': { target: apiProxy, ws: true } } : undefined
	},
	// Preact JSX for the menu/result screens (src/ui/screens).
	oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } }
});
