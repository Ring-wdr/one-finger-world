/** Environment of the match server (docs/match-server-oracle.md §4.4). Missing secrets stop the process at start. */
export interface Config {
	host: string;
	port: number;
	ticketSecret: string;
	internalSecret: string;
	/** https:// origin of the Worker, for reward grants. */
	workerOrigin: string;
	/** Page origins allowed to open match sockets; '*' only for local development. */
	allowedOrigins: string[];
	/** Directory of match.sqlite; empty keeps rooms in memory (lost on restart). */
	dataDir: string;
	maxConnectionsPerIp: number;
	/** Deployed git sha, reported by /health. */
	release: string;
}

export function readConfig(env: Record<string, string | undefined>): Config {
	const need = (name: string) => {
		const v = env[name]?.trim();
		if (!v) throw new Error(`${name} is not set`);
		return v;
	};
	const port = Number(env.PORT ?? 8080);
	if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer');
	return {
		host: env.HOST?.trim() || '127.0.0.1',
		port,
		ticketSecret: need('TICKET_SECRET'),
		internalSecret: need('INTERNAL_SECRET'),
		workerOrigin: need('WORKER_ORIGIN').replace(/\/+$/, ''),
		allowedOrigins: need('ALLOWED_ORIGINS')
			.split(',')
			.map((o) => o.trim())
			.filter(Boolean),
		dataDir: env.DATA_DIR?.trim() ?? '',
		// Generous: PC bangs, schools and carrier NAT put many players behind one address.
		maxConnectionsPerIp: Number(env.MAX_CONNECTIONS_PER_IP ?? 32),
		release: env.RELEASE?.trim() || 'dev'
	};
}
