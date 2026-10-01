import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests inside workerd: Worker routes, Durable Objects, D1 and WebSockets.
 * WebSocket tests need shared storage, so files run one at a time without isolation
 * (Workers Vitest known issues); tests use unique ids instead.
 */
// Required by wrangler.jsonc's secrets.required; read from process.env by the plugin.
process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdef0123456789abcdef';

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: path.join(import.meta.dirname, 'wrangler.jsonc') },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
					TEST_HOOKS: '1'
				}
			}
		}))
	],
	test: {
		name: 'workers',
		include: ['test/**/*.test.ts'],
		setupFiles: ['./test/setup.ts'],
		maxWorkers: 1,
		isolate: false,
		// Runs after the (parallel) unit project; Vitest needs distinct groups for different maxWorkers.
		sequence: { groupOrder: 1 }
	}
});
