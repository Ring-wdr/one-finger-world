# T6 — server: MatchCore, MatchRoom Durable Object, reward grants

Read first: `docs/multiplayer-server-design.md` §5 (all), §9.3, §10, §14, §15. Contracts:
`apps/server/src/match/types.ts` (fixed; you may add fields to `MatchMeta` only if unavoidable and
say so in your report), `packages/net` (codecs, AOI, messages, constants), `packages/sim`
(`createWorld({ humans })`, `setBotControl`, `checkpointWorld`/`restoreWorld`, `step`, `runHeadless`),
`packages/meta` (`scoreMatch`).

## Files you own

- `apps/server/src/match/core.ts` (new) — `MatchCore`, no Cloudflare imports (runs in Node tests)
- `apps/server/src/match/room.ts` (replace the skeleton) — `MatchRoom extends DurableObject<Env>`
- `apps/server/src/match/rewards.ts` (new) — D1 grant and match record
- tests: `apps/server/src/match/core.spec.ts` (Node), `apps/server/test/match.test.ts` (workerd)

Another task implements `apps/server/src/{index,http,auth,db,lobby}.ts` in parallel; do not touch
them. Your workerd tests must talk to the room directly (below), not through the Worker routes.

## `MatchCore` public API

```ts
export class MatchCore {
	constructor(host: MatchHost, matchId: string, stored?: { meta: MatchMeta; checkpoint: WorldCheckpoint | null });
	get state(): MatchState;
	/** For the room's loop and for tests. */
	get world(): World | null;
	/** New or returning connection. null = accepted; otherwise close with this code and reason. */
	join(conn: ConnId, claim: SeatClaim): { code: CloseCode; reason: string } | null;
	/** A connection that survived hibernation or a restart, re-linked to its seat without a welcome. */
	reattach(conn: ConnId, uid: string): void;
	message(conn: ConnId, data: string | ArrayBuffer): void;
	disconnect(conn: ConnId): void;
	/** One 50 ms sim tick; the room calls it while state is 'running'. */
	tick(): void;
	/** Everything time-driven that is not per tick (start, watchdog, grants, closing, cleanup). */
	alarm(): Promise<void>;
	// test hooks (the room exposes them only when env.TEST_HOOKS === '1')
	forceStart(): void;
	fastForward(): void;
	debugState(): { state: MatchState; tick: number; seats: { uid: string; fighterId: number | null; connected: boolean; bot: boolean; final: SeatResult | null; outcome: SeatOutcome | null }[] };
}
```

Behaviour is §5; the points below settle details.

- Meta starts as `state: 'empty'`; the first accepted seat moves it to `waiting`. Persist meta
  (`host.save`) on every seat change and state transition; persist the checkpoint every
  `CHECKPOINT_EVERY_TICKS` ticks and at start (§5.7). After a checkpoint write following a restore,
  reset `crashes` to 0.
- A restored running core (`stored.meta.state === 'running'`) rebuilds the world with `restoreWorld`,
  increments `restores`, marks every seat disconnected now (grace timers start) and logs
  `{ event: 'match_restore', matchId, tick, crashes }`. If `crashes > MAX_TICK_CRASHES`, end the match
  as aborted: seats without a final result get none, close everyone with 4010, log, schedule cleanup.
- Per-seat runtime (not persisted): connection, input queue, `lastSeq`, `ack`, `sinceAck`,
  `spectateId`, last `self` key, `disconnectedAt`, reported RTT.
- Joining: §5.2. On a returning seat send `start` and `self` (running), `lobby` (waiting) or `result`
  and `end` (ended, when known). Replace an older connection with 4001.
- Inputs: `decodeInput`, drop `seq <= lastSeq`, queue cap `INPUT_QUEUE_MAX` with `mergeOneShots` into the
  next frame when dropping the oldest; ignore inputs from seats whose fighter is dead or AI-controlled.
  Each tick consume at most one frame per seat → `frameToCommands`.
- Text: `parseClientMessage`; `spectate` sets the seat's `spectateId`; `leave` locks and hands the fighter
  to the AI at once (§5.8); `stats` stores RTT.
- Per tick order: §5.5. Snapshots: `encodeSnapshot(world, world.events, { focusId: pickFocus(world,
  fighterId, spectateId), selfId: fighterId, ack, sinceAck, inputQueue })`. `self` goes out before the
  snapshot whenever `items|runes|offer|pendingDrafts|rerolls|exchangeTokens` changed.
- Locking: when the AI takes over (grace expired or leave) record `locked = { placement: living
  fighters now, kills, level, time: world.time, leftEarly: true }`; clear it when the human returns
  (`setBotControl(false)`) unless the seat's result is already final.
- Results: a seat is final when its fighter dies (use `locked` if set, else `{ placement:
  fighter.placement, kills, level, time: world.time, leftEarly: false }`) or at the end (locked →
  locked; alive → `placement: fighter.placement ?? 1` for the winner; at the `MAX_MATCH_SECONDS` cap
  every survivor gets `placement = survivors`). Then `scoreMatch({ placement, fighters: MATCH_FIGHTERS,
  kills, level, time })` and grant (below).
- Grants: `host.grant({ matchId, uid, result, score, coins })` is async; the tick loop must not wait
  for it. On success (`granted` or `duplicate`) store `outcome` (`newBest = score > prevBest`), save
  meta, send `result` if connected. On failure `status: 'pending'`, `attempts++`, retry from `alarm()`
  every `GRANT_RETRY_MS`; after `MAX_GRANT_ATTEMPTS` mark `failed` and log `grant_error`. Send the
  `result` right away with `rewardPending: true` when the first attempt fails.
- Abandonment: no seat connected for `ABANDON_MS` while running → `fastForward()`.
- `fastForward()`: step the world (no snapshots) until `world.over` or `MAX_MATCH_SECONDS`, finalizing
  seats as their fighters die, then end.
- End: `end { winner }` to everyone, `host.recordMatch(summary)` (winner uid if a human won), log
  `match_end` with the §14 fields (keep tick intervals from `host.now()`; ticks run back to back in
  one timer callback have the same `now` and count as 0 ms). Close sockets `END_LINGER_MS` later,
  `host.destroy()` `CLEANUP_AFTER_END_MS` later once no grant is still pending (or they failed).
- Alarms: §5.11, always `host.setAlarm(earliest deadline)` after handling; `alarm()` must be
  idempotent. Waiting rooms with no seats: `emptySince` + `EMPTY_ROOM_TTL_MS` → `destroy()`.
- Start: `seed = host.random32()`, `createWorld({ seed, fighters: MATCH_FIGHTERS, humans })`, AI for
  seats without a connection, `start` + `self` to each connected seat, log `match_start`.

## `MatchRoom` (the Durable Object shell)

- Constructor: `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))`, then
  `blockConcurrencyWhile` → load `meta` and `checkpoint` (async KV `get`), build the core, re-link every
  `this.ctx.getWebSockets()` from its attachment `{ conn, uid }` via `reattach`, and start the loop if running.
- `fetch(request)`: require `Upgrade: websocket` (426), `decodeSeatHeader(request.headers.get(SEAT_HEADER))`
  (400 if null). Create the pair, `conn = crypto.randomUUID()`, `this.ctx.acceptWebSocket(server)`,
  `server.serializeAttachment({ conn, uid })`, register it, then `core.join`; on rejection close the
  server side with that code after accepting. Start the loop if the core is running. Return 101.
- `webSocketMessage` / `webSocketClose` / `webSocketError` → core, via the attachment's `conn`.
- Host implementation: `save` → `this.ctx.storage.put({ meta, checkpoint? }, { allowUnconfirmed: true })`
  (delete the checkpoint key when `null`); `setAlarm` → `setAlarm(at, { allowUnconfirmed: true })` /
  `deleteAlarm()`; `send` → `ws.send` (ignore a closed socket); `close`; `grant`/`recordMatch` →
  `rewards.ts`; `destroy` → close sockets, `deleteAll()`; `log` → `console.log(JSON.stringify(fields))`;
  `random32` → `crypto.getRandomValues`.
- Loop: §5.4 (`setTimeout`, drift-corrected, at most `MAX_CATCHUP_TICKS` per callback, skip ahead
  beyond that). A `tick()` exception: log it, increment `meta.crashes`, `await` a plain `put` of the
  meta, then `this.ctx.abort('tick failed')` (the next event or the watchdog alarm restores from storage).
- `alarm()` → `await core.alarm()`; make sure the loop runs iff the core is running.
- Once, when a match starts in production (`env.TEST_HOOKS !== '1'`), fetch
  `https://cloudflare.com/cdn-cgi/trace`, parse `colo=`, and log `{ event: 'match_colo', matchId, colo }`;
  ignore failures.
- Test-only RPC (throw unless `env.TEST_HOOKS === '1'`): `debugForceStart()`, `debugFastForward()`,
  `debugState()`.

## Rewards (`rewards.ts`) — §9.3

```ts
export async function grantReward(db: D1Database, g: RewardGrant, now: number): Promise<RewardOutcome>;
export async function recordMatch(db: D1Database, s: MatchSummary): Promise<void>; // INSERT OR IGNORE
```

`grantReward`: read `best`, then `db.batch([INSERT INTO match_results …, UPDATE players SET coins = coins + ?,
best = MAX(best, ?), matches = matches + 1, version = version + 1, last_seen_at = ? WHERE id = ?])`,
then read `coins, best`. A `UNIQUE constraint failed` error on `match_results` means already granted:
return `status: 'duplicate'` with the current balances. Other errors propagate.

## Tests

Node (`core.spec.ts`) with a fake host (records sends/closes/saves/alarms, controllable `now`,
scripted `grant`) — decode what the core sends with `decodeSnapshot`/`parseServerMessage`:
- waiting: join order, `lobby` contents, `startsAt` at 15 s, full room at 12 pulls the start in,
  13th join → 4002, stale ticket (`iat` older than 30 s) → 4004 for a new seat, leave during waiting
  frees the seat, empty room cleanup.
- start: alarm at `startsAt` starts; 2 humans + 10 bots; `start`/`self`/snapshots sent; seed from host.
- inputs: a move frame moves the seat's fighter; out-of-order seq dropped; overflow merges one-shots;
  starvation raises `sinceAck`; `ack` reported in the snapshot.
- disconnect → AI after 3 s with a lock; reconnect restores control and clears the lock; leave locks at once.
- death finalizes and grants once; grant failure → pending → retried by `alarm()` → granted; duplicate.
- end: `end` to everyone, `recordMatch`, sockets closed after the linger, `destroy` after cleanup.
- restore: build a second core from the first core's last saved meta + checkpoint mid-match; it
  continues, seats start disconnected, `restores` incremented; crash counter past the limit aborts.
- abandonment fast-forwards to the end.

Workerd (`apps/server/test/match.test.ts`): get a room with `env.MATCH.get(env.MATCH.newUniqueId())`,
connect with `stub.fetch('http://room/ws', { headers: { Upgrade: 'websocket', [SEAT_HEADER]:
encodeSeatHeader(claim) } })`, then `res.webSocket!.accept()`. Insert the `players` rows the grants need
directly into `env.DB` first. Cover: two clients join → `lobby` → `debugForceStart()` → `start` and
binary snapshots arrive (decode them) → inputs move the fighter → `evictDurableObject(stub, { webSockets:
'close' })` → reconnect with the same claim → `start` again and the world tick continues from the
checkpoint → `debugFastForward()` → `result` + `end` and D1 has `match_results` rows and coins added
once → auto-response: sending `ping` yields `pong`. Wait on messages with small promise helpers and
timeouts, never fixed sleeps longer than needed.

## Checks

```bash
bun run typecheck
bunx vitest run --project unit apps/server
bunx vitest run --project workers
```
