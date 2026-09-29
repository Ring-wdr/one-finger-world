/**
 * Operator switch for online play (docs/multiplayer-server-design.md §7.1):
 *
 *   bun run multiplayer -- off        # close: no new matches, the menu explains why
 *   bun run multiplayer -- on         # open again
 *   bun run multiplayer -- status
 *
 * Writes the `settings` row in the remote D1 through wrangler (add --local for `wrangler dev`).
 * Running matches finish normally; Workers pick the change up within SETTINGS_CACHE_MS (10 s).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith('--'));
const where = args.includes('--local') ? '--local' : '--remote';

const sql: Record<string, string> = {
	on: "INSERT INTO settings (key, value, updated_at) VALUES ('multiplayer', 'on', unixepoch() * 1000) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
	off: "INSERT INTO settings (key, value, updated_at) VALUES ('multiplayer', 'off', unixepoch() * 1000) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
	status: "SELECT value, datetime(updated_at / 1000, 'unixepoch') AS updated_utc FROM settings WHERE key = 'multiplayer'"
};

if (!action || !(action in sql)) {
	console.error('usage: bun run multiplayer -- on|off|status [--local]');
	process.exit(2);
}

const cwd = join(import.meta.dirname, '..');
const run = (command: string) => spawnSync('bunx', ['wrangler', 'd1', 'execute', 'DB', where, '--command', command], { cwd, stdio: 'inherit' }).status ?? 1;

let status = action === 'status' ? 0 : run(sql[action]);
if (status === 0) status = run(sql.status);
if (status === 0 && action !== 'status') console.log(`multiplayer ${action} (${where.slice(2)}); Workers apply it within 10 s, running matches finish.`);
process.exit(status);
