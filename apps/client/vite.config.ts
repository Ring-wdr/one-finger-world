import { defineConfig } from 'vite';

export default defineConfig({
	server: { port: Number(process.env.PORT) || 5173 },
	// Preact JSX for the menu/result screens (src/ui/screens).
	oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } }
});
