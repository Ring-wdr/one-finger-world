# T4 — net: movement prediction, reconciliation, snapshot timing

Read first: `docs/multiplayer-server-design.md` §11.2 and §11.3, and in `packages/sim/src`:
`world.ts` (`step`, `applyCommand`, `updateFighter`) and `combat.ts` (`startDash`, `updateDash`,
`performAttack`, `dashCooldownFor`).

## Files you own

- `packages/net/src/motion.ts` — implement `motionFromFighter`, `motionFromSelf`, `motionStats`, `stepMotion`
- `packages/net/src/predictor.ts` — implement `Predictor` (you may add private fields and helpers)
- `packages/net/src/interp.ts` — implement `ServerClock` and `SnapshotBuffer` (private fields allowed)
- new tests: `motion.spec.ts`, `predictor.spec.ts`, `interp.spec.ts` in `packages/net/src/`

Do not change exported signatures or other files. `input.ts` (`quantizeDir`, `frameToCommands`,
`emptyFrame`) is already implemented and yours to use. Another task implements the codecs; you do
not need them.

## `stepMotion` — must match the sim bit for bit

For one fighter, sim `step()` first applies that tick's commands (`applyCommand`, in
`frameToCommands` order) and then runs `updateFighter`. Mirror exactly the motion-relevant parts,
in the same order, with the same helpers (`normalize`, `copy`, `scale`, `clampToCircle`,
`moveWithCollision`) and the exported constants (`DT`, `MAP_RADIUS`, `DASH_TIME`, `DASH_DISTANCE`,
`ATTACK_BUFFER_TIME`, `WALK_SPEED_FACTOR`, `ATTACK_ROOT_TIME`, `HASTE_ATTACK_MULT`,
`DASH_HASTE_TIME`, `dashCooldownFor`):

1. Commands (only when `frame` is not null):
   - move: `moveDir = frame.move ? normalize(frame.move) : null`, then null if it is `(0, 0)`; `running = frame.run`
   - attack: `attackQueued = ATTACK_BUFFER_TIME`
   - dash: unless `dashCd > 0 || dashTime > 0 || rootTime > 0`: `d = normalize(frame.dash)`,
     `dashDir = (d is (0,0)) ? copy(facing) : d`, `facing = copy(dashDir)`, `dashTime = DASH_TIME`,
     `attackQueued = 0`, `dashCd = dashCdMax = dashCooldownFor(speedTier, cdr, frame.dashTouch)`
2. Timers: `attackCd`, `dashCd`, `rootTime`, `attackQueued`, `hasteBuff` each `-= DT` (this order).
3. If `dashTime > 0`: `step = (DASH_DISTANCE / DASH_TIME) * Math.min(DT, Math.max(0, dashTime))`,
   `pos = moveWithCollision(pos, scale(dashDir, step), radius)`, `dashTime -= DT`, and if
   `dashTime <= 0 && speedTier >= 2` then `hasteBuff = DASH_HASTE_TIME`.
   Else: if `moveDir && rootTime <= 0`: `pos = moveWithCollision(pos, scale(moveDir, moveSpeed * (running ? 1 : WALK_SPEED_FACTOR) * DT), radius)`
   and `facing = copy(moveDir)`; then if `attackQueued > 0 && attackCd <= 0`:
   `attackCd = 1 / (attackRate * (hasteBuff > 0 ? HASTE_ATTACK_MULT : 1))`, `attackQueued = 0`,
   `rootTime = ATTACK_ROOT_TIME` (the sim also turns to the nearest enemy; prediction cannot, leave facing).
4. `pos = clampToCircle(pos, { x: 0, y: 0 }, MAP_RADIUS)`.

Keep the arithmetic expressions in the sim's order (for example `speed * DT` computed first, then
`scale`), otherwise floating point results drift.

`motionStats(build, radius)`: `{ moveSpeed: build.stats.moveSpeed, attackRate: build.stats.attackRate, cdr: build.stats.cdr, speedTier: build.tiers.speed, radius }`.
`motionFromFighter` / `motionFromSelf` copy the fields (fresh vector objects, never shared).

### Equivalence test (the key test of this task)

`createWorld({ seed, fighters: 1, playerName: 'me', sandbox: true })`, set `offer = null`,
`pendingDrafts = 0`. Run several scenarios of 2,000 ticks with seeded pseudo-random frames (sim `Rng`,
never `Math.random`): quantized move directions or null, run on/off, attack ~15%, dash ~4% with random
direction and touch flag. Feed the sim `step(world, new Map([[id, frameToCommands(frame)]]))` and
`stepMotion(state, frame, stats)` side by side; after every tick all `MotionState` fields must be
`===` equal (vectors component-wise). Scenarios: base build; a speed-tier build (equip speed-tag
items via `equip(world, f, id)` from sim so `tiers.speed` reaches 1 and 2 — recompute stats after
equipping); a start near the map edge moving outward; a start next to a rock (use `OBSTACLES`) to
exercise sliding. Include ticks with `frame = null` (no new input).

## `Predictor`

- `reset(state)`: copy of state, empty history, zero correction offset.
- `push(frame, stats)`: `stepMotion(state, frame, stats)`, remember `frame` (keep at most `historySize`,
  default 128; drop the oldest).
- `reconcile(server, ack, stats)`: remember the current predicted position `p0`; forget frames with
  `seq <= ack`; `state = copy(server)`; replay remaining frames in order with `stepMotion`; then
  `offset += p0 - state.pos`; if `|offset| > snapDistance` (default 3) set it to zero. Before the
  first `reset`, `reconcile` acts as `reset(server)` plus replay.
- `displayPos(dt)`: `offset *= Math.exp(-smoothRate * dt)` (default 12), return `state.pos + offset`.
- `state`: the live predicted state (null before the first reset); `clear()` forgets everything.

### Predictor tests

Simulate client and server in one test with a sandbox world as the server:
- Each tick the client builds a frame, `push`es it and "sends" it; delivery takes `L` ticks (try 0, 2, 5).
- The server queue: frames arrive in order; each server tick pops at most one frame, applies
  `frameToCommands`, steps, and "sends back" `motionFromFighter(fighter)` with `ack = last popped seq`
  (or the previous ack when none) after `L` ticks; the client `reconcile`s on arrival.
- With no jitter and a steady queue, after warm-up the predicted state equals exactly the state the
  server later reaches after applying the same frame (compare by seq).
- With random delivery jitter (seeded) and occasional starvation, the displayed position error
  stays bounded and returns to 0 within a second once input stops.
- Snap: a server correction of 5 units snaps (offset zero), 0.5 units eases.

## `ServerClock` and `SnapshotBuffer`

- `ServerClock.onSnapshot(tick, now)`: `c = now - tick * TICK_MS`; first sample sets `base = c`;
  later `base = c` if `c < base` (arrived early), else `base += (c - base) * 0.02`. Jitter:
  `jitterMs = ema(|c - base|, 0.1)`. `serverTick(now) = (now - base) / TICK_MS`.
  `renderTick(now) = serverTick(now) - Math.min(MAX_INTERP_DELAY_TICKS, INTERP_DELAY_TICKS + jitterMs / TICK_MS)`.
  `reset()` forgets everything (serverTick before any sample returns 0).
- `SnapshotBuffer.push(s)`: equal tick → ignore (`'ok'`); lower tick than the newest → clear, keep `s`,
  return `'reset'`; else append and drop the oldest past `capacity`.
- `sample(rt)`: null when empty; `rt >= newest.tick` → `{ a: newest, b: newest, alpha: 1 }`;
  `rt <= oldest.tick` → `{ a: oldest, b: oldest, alpha: 1 }`; otherwise the consecutive pair with
  `a.tick <= rt < b.tick` and `alpha = (rt - a.tick) / (b.tick - a.tick)`.
- `between(from, to)`: snapshots with `from < tick <= to`, oldest first. `latest()`, `clear()`.
- Tests: steady 40 ms latency; uniform 0–30 ms jitter (render tick stays behind the newest snapshot,
  sampled alpha in [0, 1]); a server clock 1% fast; tick going backwards resets; capacity.
  Build minimal `Snapshot` objects by hand (only `tick` matters to these classes).

## Checks

```bash
bun run typecheck
bunx vitest run packages/net
```
