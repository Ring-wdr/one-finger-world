# T1 — sim: several humans, AI stand-in, checkpoints

Read first: `docs/multiplayer-server-design.md` §5.3, §5.7, §5.8.

## Files you own

- `packages/sim/src/world.ts`
- `packages/sim/src/checkpoint.ts` (contract signatures are fixed; implement the bodies)
- `packages/sim/src/index.ts` (add exports only)
- new tests: `packages/sim/src/multiplayer.spec.ts`, `packages/sim/src/checkpoint.spec.ts`

Do not change behaviour of existing code paths. Do not touch other packages.

## 0. Baseline first

Before editing anything, write a tiny throwaway script (do not commit it) that runs
`createWorld({ seed: 42, fighters: 12, playerName: '나', playerRunes: ['rune_power'] })`, steps it
600 times with no commands, and prints `fnv1a(JSON.stringify(world))` (any stable string hash).
Keep the value: a test must assert the same hash after your change (legacy path bit-identical).
Do the same for an all-bot world (`{ seed: 7, fighters: 12 }`, 600 steps).

## 1. Several humans in `createWorld`

```ts
export interface HumanSeat { name: string; runes?: readonly string[] }
export interface WorldOptions {
	// existing fields unchanged…
	/** Human fighters, in this order, before the bots. Mutually exclusive with playerName. */
	humans?: readonly HumanSeat[];
}
export function createWorld(opts: WorldOptions): { world: World; playerId: number | null; humanIds: number[] };
```

- `humans` and `playerName` together → throw `TypeError`. `humans.length > fighters` → throw `RangeError`.
- With `humans`: fighter index `i < humans.length` is a human (`bot: false`), named `humans[i].name`,
  runes `humans[i].runes`, colour `COLORS[i % COLORS.length]` (not white: every client sees its own
  marker). Remaining fighters are bots exactly as today (same name and colour indexing by `i`).
- `humanIds` lists the human fighter ids in seat order. `playerId` stays `humanIds[0] ?? null` for
  `humans`, the legacy player for `playerName`, `null` otherwise.
- The legacy `playerName` path and the all-bot path must produce bit-identical worlds (baseline hashes).

## 2. `newBotBrain` and `setBotControl`

```ts
/** A fresh bot brain; draws from `rng` in the same order spawnFighter always has. */
export function newBotBrain(rng: Rng, aggressive?: boolean): BotBrain;
/** Hands a living fighter to the AI (on) or back to its human (off). No-op for missing/dead fighters or when already in that state. */
export function setBotControl(world: World, fighterId: number, on: boolean): void;
```

- `spawnFighter` must use `newBotBrain` and keep the exact RNG draw order: `prefTags` (shuffle), then
  `risk`, then `thinkTimer`. The baseline hashes prove it.
- `on`: `f.bot = newBotBrain(world.rng)`, then `f.bot.thinkTimer = 0` so the AI decides next tick.
- `off`: `f.bot = null`, `f.moveDir = null`, `f.running = false`, `f.attackQueued = 0` (the human must
  send fresh input; nothing the AI queued leaks into their control).
- An AI-controlled former human keeps drafting its pending offers (bots already do this).

## 3. Checkpoints (`checkpoint.ts`)

- `checkpointWorld(world)`: `{ v: 1, tick: world.tick, world: structuredClone({ ...world, rng: { state: world.rng.state }, events: [] }) }`.
  It must not alias the live world (mutating one never affects the other).
- `restoreWorld(cp)`: throw `TypeError` unless `cp.v === 1`. Deep-copy `cp.world` (so a checkpoint
  can be restored twice), rebuild `rng` as an `Rng` whose `state` equals the saved state, and call
  `reindex(world)` (from `./combat`) so unit lookups work before the first `step`.
- structuredClone preserves `-0`, `NaN` and `Infinity`; do not use JSON for the copy.

## 4. Tests

- Legacy/all-bot baseline hashes unchanged.
- `humans` of 3 in a 12-fighter world: 3 humans with the given names, runes reflected in
  `build.stats`, `bot === null`, distinct colours; 9 bots; `humanIds` in seat order; errors for
  both options together and for too many humans.
- `setBotControl`: on → a standing human starts moving within ~20 ticks of `step`; off → `bot`
  null and `moveDir` null; repeated calls are no-ops; dead/missing ids ignored.
- Checkpoint determinism: world A with 2 humans stepped 300 ticks with seeded pseudo-random human
  commands (use the sim `Rng` with a fixed seed, never `Math.random`); `B = restoreWorld(checkpointWorld(A))`;
  step A and B 900 more ticks with identical commands → `JSON.stringify(A) === JSON.stringify(B)` and
  equal `rng.state`. Also: restoring the same checkpoint twice gives two independent worlds; the
  checkpoint survives `structuredClone`.

## Checks

```bash
bun run typecheck
bunx vitest run packages/sim
```
