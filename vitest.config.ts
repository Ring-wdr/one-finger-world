import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['packages/*/src/**/*.spec.ts', 'apps/client/src/**/*.spec.{ts,tsx}', 'apps/server/src/**/*.spec.ts'],
					environment: 'node'
				}
			},
			// Durable Objects, D1 and WebSockets inside workerd.
			'apps/server/vitest.config.ts'
		]
	}
});
