# T7 — client: API client, match connection, OnlineMatch, view world

Read first: `docs/multiplayer-server-design.md` §4, §7, §10, §11 (all), §12. Contracts: `packages/net`
(everything: `api.ts`, `messages.ts`, `input.ts`, `snapshot.ts`, `aoi.ts`, `motion.ts`, `predictor.ts`,
`interp.ts`, `constants.ts`), sim types (`World`, `Fighter`, `Monster`, `Projectile`, `Pickup`,
`GameEvent`, `Command`, `summarizeBuild`, `MONSTER_TIERS`), and how the renderer and HUD read a world:
`apps/client/src/render/Renderer.ts` (`render(world, prev, alpha, focusId, dt)`, `handleEvents`) and
`apps/client/src/ui/Hud.ts` (`update(world, me, focus, dt)`, `handleEvents`).

## Files you own (all new, DOM-free except where noted, no three.js imports)

- `apps/client/src/net/api.ts` — `ApiClient`
- `apps/client/src/net/connection.ts` — `MatchConnection` (browser WebSocket via an injectable factory)
- `apps/client/src/net/viewWorld.ts` — `ViewWorldBuilder`
- `apps/client/src/net/onlineMatch.ts` — `OnlineMatch`
- tests next to them: `api.spec.ts`, `connection.spec.ts`, `viewWorld.spec.ts`, `onlineMatch.spec.ts`

Do not edit anything else (another task wires this into the Game and UI afterwards).

## `ApiClient` (`api.ts`)

```ts
export class ApiRequestError extends Error { constructor(readonly status: number, readonly code: ApiErrorCode | 'network', message: string) }
export interface ApiClientOptions { origin: string; fetch?: typeof fetch; storage?: Storage | undefined; timeoutMs?: number }
export const AUTH_STORAGE_KEY = 'ofa.auth.v1';
export class ApiClient {
	constructor(opts: ApiClientOptions);
	readonly origin: string;
	/** null when the API is unreachable, times out (default 3 s) or reports another protocol/data hash. */
	health(): Promise<HealthResponse | null>;
	/** Stored guest token → profile; missing or rejected (401) token → create a guest and store its token. */
	ensureGuest(): Promise<ProfileDto>;
	profile(): Promise<ProfileDto>;
	rename(name: string): Promise<ProfileDto>;
	buy(runeId: string): Promise<ProfileDto>;
	equip(runeId: string): Promise<ProfileDto>;
	quickplay(): Promise<QuickplayResponse>;
	/** ws(s)://<origin>/api/match/<id>/ws?ticket=…&v=PROTOCOL_VERSION&h=DATA_HASH (ws for http origins). */
	wsUrl(matchId: string, ticket: string): string;
}
```

Errors: non-2xx → `ApiRequestError(status, body.error.code)`; network failure or timeout → code `'network'`.
Storage access is wrapped in try/catch (private mode). Tests use a fake `fetch` and an in-memory Storage.

## `MatchConnection` (`connection.ts`)

```ts
export interface SocketLike {
	binaryType: string; readyState: number;
	send(data: string | ArrayBuffer | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export interface ConnectionHandlers {
	onOpen(): void;
	onText(text: string): void;
	onBinary(data: ArrayBuffer): void;
	/** Gave up: a 4xxx close (not retried), or reconnecting failed for 30 s. */
	onClosed(code: number, reason: string): void;
	onReconnecting(attempt: number): void;
}
export class MatchConnection {
	constructor(url: string, handlers: ConnectionHandlers, deps?: { createSocket?: (url: string) => SocketLike; now?: () => number; setTimer?: …; clearTimer?: … });
	open(): void;
	sendBinary(data: Uint8Array): void;   // dropped while not open
	sendText(text: string): void;
	close(code?: number, reason?: string): void; // no reconnect afterwards
	/** Latest RTT samples (ms) from ping/pong, newest last, at most 30. */
	readonly rtts: readonly number[];
}
```

- `binaryType = 'arraybuffer'`. The text `PONG` is consumed here (not passed to `onText`).
- Ping: every 2 s while open, send `PING` only if no ping is outstanding; RTT = time to `PONG`.
- Reconnect on an unexpected close (codes other than 1000 and 4000–4999): delays 0.5, 1, 2, 4, 8, 8… s;
  give up 30 s after the first failure → `onClosed`. 4xxx and 1000 → `onClosed` immediately.
- Tests use a fake socket factory and fake timers.

## `ViewWorldBuilder` (`viewWorld.ts`) — §11.3, §11.4

```ts
export interface ViewWorld extends World { aliveTotal: number; roster: ReadonlyMap<number, RosterEntry> }
export interface OwnState { self: SelfState; build: SelfMessage | null; motion: MotionState; displayPos: Vec2 }
export class ViewWorldBuilder {
	setRoster(fighters: readonly RosterEntry[]): void;
	/** World for the renderer: entities of `b`, positions of `a` in `prev`, own fighter at `own.displayPos`. */
	build(sample: Sample, selfId: number | null, own: OwnState | null): { world: ViewWorld; prev: Map<number, Vec2>; alpha: number };
}
```

- Reuse one object per entity id across frames (update fields in place); drop objects for ids no
  longer present. The returned `world` is also reused; it must satisfy what `Renderer` and `Hud` read:
  - fighters (alive ones from `b`): `id, kind: 'fighter', name/color` from the roster, `pos`, `facing`
    (unit vector from the angle), `alive: true`, `radius: 0.7`, `hp` = fraction × `maxHp` with
    `maxHp = 1` for others, `shield` likewise, `moveDir` (facing vector when moving, else null),
    `running`, `dashTime` (0.1 while dashing, else 0), `status.burnTime`/`bleedStacks` (1 when flagged),
    `bot` (`null` when the record's human flag is set, else a truthy placeholder), `build =
    summarizeBuild(weapon ? [weapon] : [])` cached per weapon, `level`. Fill every other required
    `Fighter` field with a neutral default so the object is a valid `Fighter`.
  - own fighter (id `selfId`, when `own` is given): `pos = own.displayPos`, motion fields from `own.motion`
    (`facing`, `moveDir`, `running`, `dashTime`, `dashCd`, `dashCdMax`), exact `hp`, `maxHp`, `shield`,
    `xp`, `level`, `kills` from `own.self`, and from `own.build`: `items`, `runes`, `offer`,
    `pendingDrafts`, `rerolls`, `exchangeTokens`, `build = summarizeBuild(items, runes)` (recompute only
    when items/runes change). In `prev`, the own id maps to the same display position.
  - monsters: `tier`, `passive`, `radius = MONSTER_TIERS[tier].radius`, `hp` = fraction, `maxHp = 1`,
    `targetId`, `returning`, status flags, `alive: true`.
  - projectiles: `kind`, `pos`, `vel = (cos, sin) × speed`.
  - pickups: `id`, `pos`, `itemId`.
  - `zone`: `current`, `to` (= `next`), `from` (= current), `stage`, `dps`, `timer`, `shrinking`.
  - `phase`, `tick = b.tick`, `time = b.tick × DT`, `over`, `winner`, `events: []` (events are delivered
    separately), `aliveTotal = b.alive`, `roster`.
  - `prev`: position in `a` for every id present in both `a` and `b`.

## `OnlineMatch` (`onlineMatch.ts`) — §11

```ts
export type OnlinePhase = 'idle' | 'connecting' | 'waiting' | 'running' | 'ended' | 'error';
export interface LobbyView { players: { name: string; you: boolean }[]; max: number; startsInMs: number | null }
export interface OnlineCallbacks {
	onLobby(l: LobbyView): void;
	onStart(): void;
	/** Events to feed renderer, HUD and sound, already in dispatch order (§11.5). */
	onEvents(events: readonly GameEvent[]): void;
	onSelfDied(): void;
	onResult(r: ResultMessage): void;
	onEnd(winner: number | null): void;
	onConnection(state: 'open' | 'reconnecting'): void;
	onError(code: 'full' | 'started' | 'ended' | 'version' | 'server' | 'network' | 'unauthorized', message: string): void;
}
export interface ViewFrame { world: ViewWorld; prev: Map<number, Vec2>; alpha: number; focusId: number | null; me: Fighter | undefined; focus: Fighter | undefined }
export interface NetStats { rttP50: number | null; rttP95: number | null; jitterMs: number; inputQueue: number; snapshotsPerSecond: number; tickMs: number }
export class OnlineMatch {
	constructor(api: ApiClient, cb: OnlineCallbacks, deps?: { createSocket?: (url: string) => SocketLike; now?: () => number });
	get phase(): OnlinePhase;
	get selfId(): number | null;
	/** quickplay → connect. A 4003 (started) close retries with a fresh quickplay up to 3 times. */
	start(): Promise<void>;
	command(c: Command): void;
	spectate(fighterId: number): void;
	/** Next living fighter by id after the current focus (living = roster minus fighter deaths seen). */
	spectateNext(): void;
	leave(): void;
	/** Once per animation frame: run local ticks, build what to draw. null until the match runs. */
	frame(nowMs: number): ViewFrame | null;
	netStats(): NetStats;
	dispose(): void;
}
```

- Messages: text → `parseServerMessage`: `lobby` → `onLobby` (`startsInMs = startsAt − (serverNow − localNowAtReceipt)` offset math, null when not set);
  `start` → roster, `selfId = you`, reset buffer/clock/predictor, phase `running`, `onStart`;
  `self` → keep for the view world and prediction stats; `result` → `onResult`, send `{ t: 'stats', rtt }`
  once; `end` → phase `ended`, `onEnd`. Binary → `decodeSnapshot` → buffer (on `'reset'` also reset
  the clock, the predictor and event bookkeeping) → clock → own events (§11.5) dispatched now →
  if `self` present: `predictor.reconcile(motionFromSelf(self), ack, stats)` (stats from
  `motionStats(summarizeBuild(items, runes), 0.7)`, base build until the first `self` message);
  the first snapshot without `self` after one with it → `onSelfDied`. Track `inputQueue`.
- Commands → input state (§11.1): `move` sets the held direction (`quantizeDir`) and run flag (null
  dir = standing); `attack`, `dash` (quantized dir, `touch`), `draft`, `reroll`, `exchange` become
  one-shots for the next frame.
- `frame(now)`: while running and the own fighter is alive, run local ticks from the accumulated time
  with `tickMs = TICK_MS × (1 + clamp(0.02 × (queueEma − 1), −0.05, 0.05))` (queue EMA α = 0.1); each
  tick builds an `InputFrame` (`seq` +1), sends `encodeInput`, `predictor.push`es it and clears the
  one-shots. Cap catch-up at 5 ticks per frame. Then `renderTick = clock.renderTick(now)`, dispatch
  the queued non-own events of snapshots with `lastDispatched < tick ≤ renderTick` via `onEvents`,
  `sample = buffer.sample(renderTick)`, and build the view with `own.displayPos =
  predictor.displayPos(dtSeconds)`. `focusId` = `sample.b.focusId`; `me`/`focus` from the built world.
- Connection close codes → `onError`: 4002 full, 4004 ended, 4006 version, 4005/4010 server,
  4001 (replaced) → `'server'` with a message saying another tab took over, give-up → `'network'`.
  `ApiRequestError` 401 → `'unauthorized'`, others → `'network'`.
- `leave()`: send `{ t: 'leave' }`, close with 1000, phase `ended`.

## Tests

Use real codecs with a fake server driving the fake socket: build worlds with sim
(`createWorld({ seed, fighters: 12, humans: [{ name: 'me' }] })`, step them) and send what the server
would (`start`, `self`, `encodeSnapshot` per tick with `ack`/`sinceAck`, `result`, `end`).
- `ViewWorldBuilder`: entity sets, positions/prev, own fighter from motion/self/build, object reuse,
  removal of vanished ids, the result passes a structural check against what Renderer/Hud read.
- `OnlineMatch`: lobby countdown math; start resets state; commands produce the right encoded frames
  (decode them on the fake server side); local ticks at the dilated rate; prediction follows input
  immediately and reconciles with server snapshots (fake server applies the frames with `frameToCommands`
  after a delay — the drawn own position must track the server within 0.05 units at steady state);
  own events on arrival vs others at render time; `onSelfDied`; `result`/`end`; 4003 retry via
  quickplay; error mapping; reconnection keeps the match (fake close 1006 → reopen → `start` again).
- `ApiClient`: guest creation and token reuse, 401 → new guest, error mapping, timeout, `wsUrl`.
- `MatchConnection`: ping/pong RTT, reconnect schedule and give-up, 4xxx not retried.

## Checks

```bash
bun run typecheck
bunx vitest run --project unit apps/client packages/net
```
