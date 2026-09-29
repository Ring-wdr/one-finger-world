# T5 — server: Worker router, auth tokens, HTTP API, D1 players, Lobby DO, nicknames

Read first: `docs/multiplayer-server-design.md` §2, §4, §6, §7, §8, §9.1–9.2, §13, §16.1.
Contracts: `packages/net/src/api.ts` (routes, DTOs, error codes, `MATCH_ID_PATTERN`),
`packages/net/src/constants.ts` (`PROTOCOL_VERSION`, `DATA_HASH`, `MAX_HUMANS`),
`apps/server/src/match/types.ts` (`SeatClaim`, `SEAT_HEADER`, `encodeSeatHeader`),
`apps/server/wrangler.jsonc`, `apps/server/worker-configuration.d.ts` (`Env`),
`apps/server/migrations/0001_init.sql`, `packages/meta/src/profile.ts` (shop rules).

## Files you own

- `apps/server/src/index.ts` (replace the skeleton; keep exporting `Lobby` and `MatchRoom`)
- `apps/server/src/http.ts`, `apps/server/src/auth.ts`, `apps/server/src/db.ts` (new)
- `apps/server/src/lobby.ts` (replace the skeleton)
- `packages/meta/src/names.ts` (new) and its export from `packages/meta/src/index.ts`
- tests: `apps/server/src/auth.spec.ts` (Node), `packages/meta/src/names.spec.ts` (Node),
  `apps/server/test/api.test.ts`, `apps/server/test/lobby.test.ts` (workerd)

Another task is implementing `apps/server/src/match/**` in parallel; do not touch it. The skeleton
`MatchRoom` accepts a WebSocket and immediately closes it with 4010, which is enough to test your
forwarding. Do not edit `wrangler.jsonc`, the migration, the `Env` types or any package.json.

## Nicknames (`packages/meta/src/names.ts`)

```ts
export const NAME_MIN = 2;
export const NAME_MAX = 12;
/** NFC-normalized, trimmed, inner whitespace collapsed to one space; null unless 2–12 code points of
 *  Hangul syllables (U+AC00–U+D7A3), ASCII letters/digits, '_', '-' or ' '. */
export function normalizeNickname(raw: string): string | null;
/** "<adjective><noun><2 digits>" in Korean from fixed word lists (≈10 × 10), e.g. "날쌘여우27";
 *  always passes normalizeNickname. */
export function generateGuestName(random: () => number): string;
```

## Tokens (`auth.ts`) — §8

```ts
export interface GuestClaims { typ: 'guest'; sub: string; iat: number }
export interface TicketClaims { typ: 'ticket'; sub: string; mid: string; name: string; runes: string[]; iat: number; exp: number }
export async function signToken(secret: string, claims: GuestClaims | TicketClaims): Promise<string>;
export async function verifyGuest(secret: string, token: string): Promise<GuestClaims | null>;
export async function verifyTicket(secret: string, token: string, now: number): Promise<TicketClaims | null>;
export const TICKET_TTL_MS = 15 * 60_000;
```

- Format `base64url(utf8(JSON)) + '.' + base64url(HMAC-SHA256(secret, ascii(payloadPart)))`. Import the
  key once per secret (cache the `Promise<CryptoKey>`). Verify with `crypto.subtle.verify`.
- Reject: wrong part count, bad base64/JSON, bad signature, wrong `typ`, missing/mistyped fields,
  ticket `exp <= now`. Never throw on bad input; return null.
- Node tests: round trip both kinds (including Korean names), tampered payload, tampered signature,
  wrong secret, wrong typ, expired ticket, garbage strings.

## HTTP helpers (`http.ts`)

- `json(data, status = 200, headers?)`, `apiError(status, code: ApiErrorCode, message)` →
  `{ error: { code, message } }`.
- `readJson<T>(request, validate: (v: unknown) => T | null)`: 400 `bad_request` on invalid JSON,
  wrong content, or body over 4 KB.
- `bearer(request)`: token from `Authorization: Bearer <token>`.
- CORS per §7: same-origin requests need nothing; an `Origin` in `env.ALLOWED_ORIGINS`
  (comma-separated, trimmed) gets `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`,
  `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
  `Access-Control-Max-Age: 86400` on every response; `OPTIONS` preflight → 204 when allowed, 403 otherwise.
- `originAllowed(request, env)`: true when `Origin` is absent, equals the request URL's origin, or is listed.

## D1 (`db.ts`) — §9.1–9.2

```ts
export async function createPlayer(db: D1Database, id: string, name: string, now: number): Promise<ProfileDto>;
export async function getProfile(db: D1Database, uid: string): Promise<ProfileDto | null>;
export async function renamePlayer(db: D1Database, uid: string, name: string): Promise<ProfileDto | null>;
/** Optimistic concurrency: read, apply `change` (from @ofa/meta), UPDATE … WHERE version = ?; up to 3 tries. */
export async function updateProfile(db: D1Database, uid: string, change: (p: Profile) => Profile | ShopError):
	Promise<ProfileDto | ShopError | 'conflict' | null>;
```

- Rows store `owned`/`equipped` as JSON; run them through `parseProfile` when reading (it drops
  unknown runes). All SQL uses bound parameters.
- `toDto` maps a row to `ProfileDto` (`uid`, `name`, `coins`, `owned`, `equipped`, `best`, `matches`).

## Lobby DO (`lobby.ts`) — §6

- `assign(uid: string): Promise<{ matchId: string }>` (RPC). State `open = { matchId, createdAt, uids }`
  in the synchronous KV API (`this.ctx.storage.kv.get/put`).
- Same uid within the open window → same matchId. Open window: 12 s from `createdAt` and fewer than
  `MAX_HUMANS` uids. Otherwise open a new match: `this.env.MATCH.newUniqueId().toString()`.
- Export the window as `OPEN_WINDOW_MS = 12_000` for tests.

## Router (`index.ts`) — §7

| Route | Behaviour |
| --- | --- |
| `OPTIONS /api/*` | CORS preflight |
| `GET /api/health` | `HealthResponse` |
| `POST /api/guest` | `env.GUEST_LIMITER.limit({ key: ip })` (ip from `CF-Connecting-IP`, else `'local'`) → 429 `rate_limited`; `crypto.randomUUID()` uid, `generateGuestName(Math.random)`, `createPlayer`, guest token → `GuestResponse` |
| `GET /api/profile` | guest token → `ProfileResponse`; unknown uid → 401 |
| `POST /api/profile/name` | `{ name }` → `normalizeNickname` (422 `bad_name`) → `renamePlayer` |
| `POST /api/shop/buy` | `{ runeId }` (string ≤ 64 chars) → `updateProfile(buyRune)`; errors: `unknown` → 422 `unknown_rune`, `owned` → 409 `owned`, `coins` → 409 `coins`, `'conflict'` → 409 `conflict` |
| `POST /api/shop/equip` | `{ runeId }` → `updateProfile(toggleRune)`; a rune not owned is a no-op that returns the profile |
| `POST /api/quickplay` | guest token → `env.PLAY_LIMITER.limit({ key: uid })` → profile → `env.LOBBY.getByName('lobby', { locationHint })`.`assign(uid)` → ticket `{ typ: 'ticket', sub: uid, mid, name, runes: equippedRunes(profile), iat: now, exp: now + TICKET_TTL_MS }` → `QuickplayResponse` |
| `GET /api/match/:id/ws` | `Upgrade: websocket` else 426; `:id` matches `MATCH_ID_PATTERN` else 404; `originAllowed` else 403; query `v == PROTOCOL_VERSION` and `h == DATA_HASH` else 409 `version`; ticket valid and `mid === id` else 401; then forward to `env.MATCH.get(env.MATCH.idFromString(id), { locationHint: env.LOCATION_HINT })` with a copy of the request whose headers have `SEAT_HEADER` set to `encodeSeatHeader({ uid, name, runes, iat })` (overwrite any incoming value) |
| other `/api/*` | 404 `not_found`; wrong method on a known path → 405 `bad_request` |

`locationHint` is `env.LOCATION_HINT` cast to `DurableObjectLocationHint`. `AUTH_SECRET` comes from
`env.AUTH_SECRET`. Every handler must stay small (free-plan Workers get 10 ms of CPU per request).
Unexpected exceptions → 500 `server` and a `console.error` of the message only (never tokens).

## Workerd tests (`apps/server/test/*.test.ts`)

Use `import { env, exports } from 'cloudflare:workers'` and `exports.default.fetch(...)`. Tests share
storage (see `vitest.config.ts`), so create fresh guests per test instead of relying on empty tables.

- Guest → profile → rename (valid, invalid) → buy with no coins (409 `coins`) → give coins directly in
  D1 → buy → owned + auto-equipped → equip toggles off → buy again (409 `owned`) → unknown rune (422).
- Auth failures: missing/garbage/ticket-typed token on profile (401).
- Concurrent buys of two runes costing more than half the coins each: exactly one succeeds.
- Quickplay: two guests get the same matchId, the ticket verifies (`verifyTicket` with the test
  secret, which is `process.env.AUTH_SECRET` in the Vitest config) with the equipped runes and name.
- WS route: non-upgrade 426, bad id 404, bad version/hash 409, bad or mismatched ticket 401, disallowed
  Origin 403, valid → 101 (the skeleton room then closes it). Pass headers `Upgrade: websocket`.
- CORS: allowed origin preflight 204 with headers; disallowed 403; same-origin requests work.
- Lobby (`lobby.test.ts`, via `env.LOBBY.getByName(...)` RPC): grouping, same uid twice → same match,
  13th uid → new match, window expiry (use `runInDurableObject` to rewrite the stored `createdAt`
  instead of sleeping).
- Rate limiting: if the local runtime enforces the limiter, assert 429 after the limit; if it does not,
  leave a comment explaining why the test only checks the binding is called (do not fake a pass).

## Checks

```bash
bun run typecheck
bunx vitest run --project unit packages/meta apps/server
bunx vitest run --project workers
```
