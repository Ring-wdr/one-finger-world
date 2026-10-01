import { join } from 'node:path';
import { readConfig } from './config';
import { Rooms } from './rooms';
import { startServer } from './server';
import { SqliteStore } from './sqlite';
import { MemoryStore, type RoomStore } from './store';
import { WorkerClient } from './worker';

/** Entry point (systemd ExecStart). docs/match-server-oracle.md §4.4, §6. */
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

const config = readConfig(process.env);
const store: RoomStore = config.dataDir ? new SqliteStore(join(config.dataDir, 'match.sqlite')) : new MemoryStore();
const rooms = new Rooms({ store, worker: new WorkerClient(config.workerOrigin, config.internalSecret), log });
const restored = rooms.restore();
const server = startServer(config, rooms, log);
log({ event: 'server_start', release: config.release, port: server.port, restored, store: config.dataDir ? 'sqlite' : 'memory' });

let stopping = false;
function stop(signal: string): void {
	if (stopping) return;
	stopping = true;
	// No new sockets; every running room writes a checkpoint and closes with 1012 so clients reconnect to the next process.
	void server.stop();
	rooms.shutdown();
	if (store instanceof SqliteStore) store.close();
	log({ event: 'server_stop', signal });
	process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
