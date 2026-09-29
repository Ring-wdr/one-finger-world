import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		port: Number(process.env.PORT) || 5173,
		// `bun run dev:online`: wrangler dev serves the API, so the page and API share one origin.
		proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } }
	},
	// Preact JSX for the menu/result screens (src/ui/screens).
	oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } }
});
