import { expect } from 'vitest';
import { decodeSnapshot, emptyFrame, encodeInput, parseServerMessage, type ServerMessage, type Snapshot } from '@ofa/net';
import { SEAT_HEADER, encodeSeatHeader } from '../src/match/types';

/** Test WebSocket client shared by the room and end-to-end tests. */

export type Item = { msg: ServerMessage } | { snap: Snapshot } | { text: string } | { close: number };

/** A room connection that records everything it receives. */
export class Client {
	readonly items: Item[] = [];
	private waiters: (() => void)[] = [];
	seq = 0;

	constructor(readonly ws: WebSocket) {
		ws.binaryType = 'arraybuffer';
		ws.addEventListener('message', (e) => {
			if (typeof e.data !== 'string') this.push({ snap: decodeSnapshot(e.data as ArrayBuffer) });
			else {
				const msg = parseServerMessage(e.data);
				this.push(msg ? { msg } : { text: e.data });
			}
		});
		ws.addEventListener('close', (e) => this.push({ close: e.code }));
	}

	static async connect(stub: DurableObjectStub, uid: string): Promise<Client> {
		const claim = { uid, name: `player-${uid}`, runes: [], iat: Date.now() };
		const res = await stub.fetch('http://room/ws', { headers: { Upgrade: 'websocket', [SEAT_HEADER]: encodeSeatHeader(claim) } });
		expect(res.status).toBe(101);
		return Client.from(res);
	}

	/** Wraps a 101 response (from a room stub or the Worker route). */
	static from(res: Response): Client {
		expect(res.status).toBe(101);
		const ws = res.webSocket!;
		ws.accept();
		return new Client(ws);
	}

	private push(item: Item): void {
		this.items.push(item);
		for (const w of this.waiters.splice(0)) w();
	}

	/** The first received item the picker accepts, waiting up to `timeout` ms. */
	async waitFor<T>(pick: (item: Item) => T | undefined, timeout = 8000): Promise<T> {
		const deadline = Date.now() + timeout;
		for (;;) {
			for (const item of this.items) {
				const v = pick(item);
				if (v !== undefined) return v;
			}
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out; received ${JSON.stringify(this.items.map((i) => Object.keys(i)[0]))}`);
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, left);
				this.waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}

	message<T extends ServerMessage['t']>(t: T, where: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) {
		return this.waitFor((i) => ('msg' in i && i.msg.t === t && where(i.msg as Extract<ServerMessage, { t: T }>) ? (i.msg as Extract<ServerMessage, { t: T }>) : undefined));
	}

	snapshot(where: (s: Snapshot) => boolean = () => true) {
		return this.waitFor((i) => ('snap' in i && where(i.snap) ? i.snap : undefined));
	}

	/** Sends one input frame per 50 ms until the returned function is called. */
	streamInput(over: Partial<ReturnType<typeof emptyFrame>>): () => void {
		const iv = setInterval(() => this.ws.send(encodeInput({ ...emptyFrame(++this.seq), ...over })), 50);
		return () => clearInterval(iv);
	}
}
