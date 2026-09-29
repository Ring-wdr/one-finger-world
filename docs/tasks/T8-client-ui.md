# T8 — client: online mode in the Game, stages, screens, shop and HUD

Read first: `docs/multiplayer-server-design.md` §11, §12. Code to build on:
`apps/client/src/net/{api,onlineMatch,viewWorld,connection}.ts` (implemented, tested; do not change
their public APIs — small fixes are fine if you find a bug, say so in the report),
`apps/client/src/game/{Game,stages}.ts`, `apps/client/src/app/{store,gameHost}.ts`,
`apps/client/src/ui/Hud.ts`, `apps/client/src/ui/screens/*`, `apps/client/src/style.css`,
`packages/meta` (profile rules, `normalizeNickname`).

## Files you own

- `apps/client/src/game/Game.ts`, `apps/client/src/game/stages.ts`, `apps/client/src/game/stages.spec.ts`
- `apps/client/src/app/store.ts`, `apps/client/src/app/gameHost.ts`, new `apps/client/src/app/online.ts` (+ `online.spec.ts`)
- `apps/client/src/ui/Hud.ts`, `apps/client/src/ui/screens/*` (edit and add), `apps/client/src/style.css`
- `apps/client/src/main.tsx`, `apps/client/src/vite-env.d.ts`, `apps/client/vite.config.ts`

Do not touch `packages/*`, `apps/server/*`, `apps/client/src/net/*` public APIs, README or workflows.

## 1. Online availability and the server profile (`app/online.ts`)

- API origin: `import.meta.env.VITE_API_ORIGIN || location.origin` (declare `VITE_API_ORIGIN?: string`
  in `vite-env.d.ts`). One `ApiClient` for the app (`storage` = `safeStorage()`).
- `initOnline()` at startup (from `main.tsx`, not awaited): `health()` → if null, stay offline.
  Otherwise `ensureGuest()` → set the `profile` signal from the server profile (`coins, owned,
  equipped, best, matches`), set `profileSource = 'server'` and `playerName` (a new signal). Failures
  leave the app offline and log once to the console.
- Signals: `onlineAvailable`, `profileSource: 'local' | 'server'`, `playerName`, `lobby: LobbyView | null`
  (+ the local time it arrived, for the countdown), `connection: 'open' | 'reconnecting' | null`,
  `onlineError: string | null`.
- Server-mode actions: `buyRune`, `toggleRune`, `rename` go through the API and replace `profile` with
  the response; map `ApiRequestError.code` to Korean messages (`coins` → 코인이 부족해요, `owned`,
  `unknown_rune`, `bad_name` → 닉네임은 2~12자 한글·영문·숫자·_-·공백, `rate_limited`, `network` →
  서버에 연결할 수 없어요, others → 잠시 후 다시 시도해 주세요).
- `store.ts`: persist `profile` to localStorage only while `profileSource` is `'local'` (the server
  profile must never overwrite the offline one).

## 2. Stages (`game/stages.ts`)

```ts
export type StageId = 'menu' | 'match' | 'queue' | 'online' | 'result' | 'spectate' | 'tutorial';
TRANSITIONS = {
	menu: ['match', 'tutorial', 'queue'],
	queue: ['online', 'menu'],
	online: ['result'],
	match: ['result'],
	result: ['menu', 'match', 'queue', 'spectate'],
	spectate: ['result', 'match', 'queue'],
	tutorial: ['menu', 'tutorial', 'match']
};
```

- `queue`: no gameplay input; enter → `host.startQueue()`; exit to `menu` → `host.cancelQueue()`;
  frame → `host.present(dt, false)` (the menu backdrop keeps rendering).
- `online`: input on; enter → `host.enterOnline()`; frame → `host.simulate(dt)`, `host.present(dt, true)`,
  and `go('result')` when `host.playerDown() || host.worldOver()`.
- `result`/`spectate` keep their frames; they already go through `simulate`/`present`, which now
  dispatch to the active mode. Extend `StageHost` with `startQueue`, `cancelQueue`, `enterOnline`.
- Update `stages.spec.ts` for the new table and stages.

## 3. The Game in online mode (`game/Game.ts`)

- Keep one active mode: `'local'` (today's behaviour, unchanged) or `'online'` (an `OnlineMatch`).
- `startQueue()`: create an `OnlineMatch` with callbacks that write the `lobby`/`connection`/`onlineError`
  signals, call `go('online')` on `onStart`, feed `onEvents` to sounds, `renderer.handleEvents` and
  `hud.handleEvents` (with the roster name lookup, below), set the result on `onResult`, and so on;
  then `start()`. `cancelQueue()`: `dispose()` it, clear the signals.
- `enterOnline()`: `renderer.reset()`, `hud.reset()`, `hud.setMode('match')`, `hud.onMatchStart()`
  (the opening weapon pick is a draft offer in `self`), `result.value = null`.
- Player commands: `queue()` (keyboard, HUD) and `onGesture` push to `OnlineMatch.command` while online
  instead of the local `pending` list. The input controller keeps its current behaviour.
- `simulate(dt)`: local mode as today; online mode does nothing (the OnlineMatch runs its own ticks).
- `present(dt, hud)`: online → `const f = online.frame(performance.now())`; if a frame exists,
  `renderer.render(f.world, f.prev, f.alpha, f.focusId, dt)` and `hud.update(f.world, f.me, f.focus, dt)`;
  if not (yet), keep rendering the local backdrop world.
- `playerDown()`: online → the self-died callback has fired. `worldOver()`: online → phase `ended`.
- `showResult()` online: `ResultInfo` from the last own fighter in the view (level, kills, items, tags
  from its build), `placement` from the `result` message when it has arrived (else `aliveTotal + 1` at
  death as a provisional value), `reward` from the `result` message (null until then; update
  `result.value` when it arrives), `newBest`, `canSpectate` while the match runs, `mode: 'online'`.
  Put the server's coin balance from `result.coins` into the `profile` signal.
- Local practice matches while `profileSource === 'server'` pay no coins (they cannot be trusted):
  `reward: null`, `practice: true` in `ResultInfo`; the panel says 연습 매치는 코인이 지급되지 않아요.
- `spectateNext()`: online → `online.spectateNext()`. `restart()`: after an online result → `go('queue')`.
- Leaving an online match from the HUD's 나가기 (tutorial only today) is not needed; the result
  screen's 메뉴 button calls `online.leave()` when the match is still running.
- Dispose the OnlineMatch in `dispose()`.

## 4. HUD (`ui/Hud.ts`)

- Alive count: use `(world as { aliveTotal?: number }).aliveTotal` when present.
- `handleEvents(world, events, playerId, nameOf?)`: an optional `(id: number) => string` for the
  kill feed; online passes a roster lookup (fighters outside the view are not in `world.fighters`).
- No other behaviour changes in local mode.

## 5. Screens

- `MainMenu`: when `onlineAvailable`: primary **⚔ 온라인 매치** (`go('queue')`, sub-label 전 세계
  플레이어와 12인 배틀로얄 · 빈자리는 봇), secondary **🤖 연습 매치** (`go('match')`); otherwise keep
  today's **⚔ 본 게임**. Show `playerName` next to the coins when online.
- New `QueueScreen` (shown in stage `queue`): 매칭 중… while connecting; then 대기실 n/12, the player
  names (`you` highlighted), and a countdown in whole seconds from `startsInMs` minus the time since
  the lobby message arrived; 취소 → `go('menu')`. Errors: message + 다시 시도 (restart the queue)
  + 메뉴. 4006 → 새 버전이 있어요 — 새로고침 with a reload button.
- `ResultPanel`: online → 보상 집계 중… until the reward arrives, `rewardPending` → 보상은 곧 반영돼요;
  the practice note above; 다시 하기 follows the mode.
- `SpectateBar`: its 다시 하기 follows the mode.
- `ShopScreen`: server mode uses the online actions (disable buttons while a request runs, show the
  error text); local mode unchanged.
- `SettingsScreen`: when online, a 닉네임 field with 저장 (validate with `normalizeNickname` first).
- A small connection badge (재연결 중…) while `connection === 'reconnecting'` during `online`/`result`/`spectate`.
- Debug overlay when the page URL has `?net=1`: RTT p50/p95, jitter, input queue, snapshots/s, local
  tick ms from `OnlineMatch.netStats()`, refreshed about 4×/s.
- Keep the existing look (reuse `.panel`, `.btn`, `.screen` styles; add minimal CSS).

## 6. Dev proxy (`vite.config.ts`)

`server.proxy['/api'] = { target: 'http://127.0.0.1:8787', ws: true }` so `bun run dev:online`
(wrangler dev + vite) works from one origin. Production builds are unaffected.

## Tests

- `stages.spec.ts`: the new transitions and stage behaviours with the fake host.
- `online.spec.ts`: `initOnline` with a fake `ApiClient` (offline on failed health, server profile on
  success, local profile untouched), server-mode shop and rename error mapping.
- Keep every existing client test passing. Run the app in a browser if you can (`bun run dev` offline
  mode must look and behave exactly as before).

## Checks

```bash
bun run typecheck
bunx vitest run --project unit apps/client
bun run build
```
