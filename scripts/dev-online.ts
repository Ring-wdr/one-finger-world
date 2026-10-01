/**
 * Local online development (docs/multiplayer-server-design.md §16.1): `wrangler dev` for the Worker on
 * 8787 and the Vite dev server on 5173, which proxies /api (HTTP and WebSocket) to the Worker.
 * Run with `bun run dev:online`; Ctrl+C stops both.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const server = join(root, 'apps/server');
const client = join(root, 'apps/client');

/** Runs a one-off step, streaming its output; exits the script when it fails. */
function step(label: string, cmd: string[], cwd: string): void {
	console.log(`[dev-online] ${label}`);
	const { status } = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
	if (status !== 0) {
		console.error(`[dev-online] "${cmd.join(' ')}" failed with exit code ${status ?? 'null'}`);
		process.exit(status ?? 1);
	}
}

// wrangler refuses to start when the assets directory is missing.
if (!existsSync(join(client, 'dist'))) step('apps/client/dist is missing, building the client once', ['bun', 'run', 'build'], root);

const vars = join(server, '.dev.vars');
const example = join(server, '.dev.vars.example');
if (!existsSync(vars)) {
	copyFileSync(example, vars);
	console.log('[dev-online] created apps/server/.dev.vars from .dev.vars.example (local-only secrets)');
} else {
	// Secrets added after the file was created (e.g. TICKET_SECRET): wrangler refuses to start without them.
	const have = readFileSync(vars, 'utf8');
	const names = new Set(have.split(/\r?\n/).map((line) => line.split('=')[0]));
	const missing = readFileSync(example, 'utf8')
		.split(/\r?\n/)
		.filter((line) => /^[A-Z_]+=/.test(line) && !names.has(line.split('=')[0]));
	if (missing.length > 0) {
		appendFileSync(vars, (have.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
		console.log(`[dev-online] added ${missing.map((l) => l.split('=')[0]).join(', ')} to apps/server/.dev.vars`);
	}
}

step('applying local D1 migrations', ['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], server);

/** Starts a long-running child and prefixes each output line with its name. */
function start(name: string, cmd: string[], cwd: string, env: Record<string, string> = {}): ChildProcess {
	const child = spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
	const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
		let pending = '';
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			pending += chunk;
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) out.write(`[${name}] ${line}\n`);
		});
		stream.on('end', () => pending && out.write(`[${name}] ${pending}\n`));
	};
	pipe(child.stdout!, process.stdout);
	pipe(child.stderr!, process.stderr);
	return child;
}

// `*` lets the Worker accept the Vite origin (see ALLOWED_ORIGINS in apps/server/src/http.ts).
const children = [
	start('server', ['bunx', 'wrangler', 'dev', '--port', '8787', '--ip', '0.0.0.0', '--var', 'ALLOWED_ORIGINS:*'], server),
	// Vite proxies /api (HTTP and WebSocket) to the Worker only when this is set (apps/client/vite.config.ts).
	start('client', ['bun', 'run', 'dev'], client, { OFA_API_PROXY: 'http://127.0.0.1:8787' })
];

let stopping = false;
function stop(code: number): void {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill();
	setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const child of children) {
	child.on('exit', (code) => {
		if (!stopping) console.error(`[dev-online] a process exited with code ${code}, stopping the other`);
		stop(code === 0 ? 0 : 1);
	});
}

const lan = Object.values(networkInterfaces())
	.flat()
	.find((i) => i?.family === 'IPv4' && !i.internal)?.address;
console.log(`\n[dev-online] open http://localhost:5173${lan ? `  (phone on the same network: http://${lan}:5173)` : ''}\n`);
