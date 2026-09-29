# T9 — load test, local online dev, deploy workflow, docs

Read first: `docs/multiplayer-server-design.md` §7, §14, §16. Code: `apps/server/**` (Worker, routes,
tests), `packages/net` (API routes, codecs), `.github/workflows/deploy-pages.yml`, `README.md`.

## Files you own

- `apps/server/scripts/loadtest.ts` (new)
- `scripts/dev-online.ts` (new; root `package.json` already has `"dev:online": "bun scripts/dev-online.ts"`)
- `apps/server/src/http.ts` (only the `ALLOWED_ORIGINS=*` change below) and its tests in
  `apps/server/test/api.test.ts` (add, do not rewrite)
- `.github/workflows/deploy-cloudflare.yml` (new), `.github/workflows/deploy-pages.yml` (one env line)
- `README.md` (new sections), `apps/server/.dev.vars.example`

Another task edits `apps/client/**` in parallel; do not touch it.

## 1. `ALLOWED_ORIGINS=*` for local development

In dev the browser loads the client from Vite (`http://<host>:5173`) and Vite proxies `/api` (HTTP and
WebSocket) to `wrangler dev` on 8787, so the Worker sees a different `Origin` than its own URL and
rejects the socket. Support a single `*` entry meaning "any origin" in `originAllowed` and
`corsHeaders` (echo the request's origin, never a literal `*` with credentials). Production keeps the
explicit list in `wrangler.jsonc`. Add api tests for `*`.

## 2. `scripts/dev-online.ts` (Bun)

- If `apps/client/dist` does not exist, run `bun run build` once (wrangler needs the assets directory).
- If `apps/server/.dev.vars` does not exist, copy `.dev.vars.example` and say so.
- Apply local D1 migrations (`bunx wrangler d1 migrations apply DB --local` in `apps/server`).
- Start `wrangler dev --port 8787 --ip 0.0.0.0 --var ALLOWED_ORIGINS:*` in `apps/server` and the Vite dev
  server (`bun run dev` in `apps/client`, which proxies `/api` to 8787) together; prefix their output
  (`[server]`, `[client]`), stop both on Ctrl+C or when either exits, and print the URL to open.
- Verify it: start the script, `curl http://127.0.0.1:5173/api/health` through the proxy and
  `curl -X POST http://127.0.0.1:8787/api/guest`, then stop it. Report what you saw.

## 3. `apps/server/scripts/loadtest.ts` (Bun) — the §14 go/no-go measurement

```
bun apps/server/scripts/loadtest.ts --url http://127.0.0.1:8787 --clients 12 --seconds 60
```

- Each client: `POST /api/guest` → `POST /api/quickplay` → WebSocket to `/api/match/:id/ws?...` with
  `binaryType = 'arraybuffer'` (Bun's global WebSocket; `wss` for `https` URLs). Clients join together,
  so 12 clients fill a room and start after the 1.5 s full-room delay.
- After `start`: send an input frame every 50 ms (`encodeInput`, seq +1) with a random run direction
  that changes every 1–3 s, attack on ~10% of frames, a touch dash on ~1%; pick a draft card whenever
  the `self` message has an `offer`.
- Measure per client: RTT with `PING`/`PONG` every 2 s (one outstanding), snapshot inter-arrival times,
  bytes and messages down/up, `ack` lag (`seq − ack`), reconnects/closes and codes.
- After `--seconds` (or `end`), send `leave`, close, and print a table per client plus totals: RTT
  p50/p95, snapshot interval p50/p95/p99/max, down/up KB/s, snapshots/s, final result if received.
  Exit non-zero if any client failed to start.
- Flags: `--url`, `--clients` (default 12), `--seconds` (default 60), `--spread` (clients per room is
  whatever the lobby does; no flag needed). Keep dependencies to `@ofa/net` and Bun built-ins.
- Verify it against `dev-online` (or `wrangler dev` alone) with 12 clients for ~30 s and paste the summary
  in your report. Note: this container has no Cloudflare credentials, so only local runs are possible.

## 4. `.github/workflows/deploy-cloudflare.yml`

Manual only (`workflow_dispatch`). Steps: checkout, setup bun (same version as the Pages workflow),
`bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`, `bun run build`,
`bunx wrangler d1 migrations apply DB --remote` and `bunx wrangler deploy` in `apps/server`, with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from repository secrets. A comment at the top says
the first deploy must be done locally (it creates the D1 database and writes its id into
`wrangler.jsonc`, which the workflow needs) and that `AUTH_SECRET` is set once with `wrangler secret put`.
Also: in `deploy-pages.yml`, pass `VITE_API_ORIGIN: ${{ vars.VITE_API_ORIGIN }}` to the build step
(empty → the Pages build stays offline-only).

## 5. README

Add, in Korean and matching the README's tone: a short 멀티플레이(온라인) section (what runs where:
Worker + Durable Objects + D1, link to the design doc), 로컬 온라인 개발 (`bun run dev:online`,
`.dev.vars`), 배포 (the first-deploy steps from design §16.2, the manual workflow, `VITE_API_ORIGIN`
for the Pages build and `ALLOWED_ORIGINS`), 지연 측정 (`bun run loadtest -- --url …` and what the
§14 thresholds are), and update the structure tree (`packages/net`, `packages/meta`, `apps/server`).
Keep the existing content accurate; the offline game still works as before.

## Checks

```bash
bun run typecheck
bunx vitest run --project workers
```
