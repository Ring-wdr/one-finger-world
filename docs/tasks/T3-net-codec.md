# T3 — net: input and snapshot codecs, interest management, control messages

Read first: `docs/multiplayer-server-design.md` §10 (all of it) and §13.

## Files you own

- `packages/net/src/input.ts` — implement `encodeInput`, `decodeInput`, `hasOneShots`, `mergeOneShots`
  (`quantizeDir`, `frameToCommands`, `emptyFrame` are already implemented; do not change them)
- `packages/net/src/snapshot.ts` — implement `encodeSnapshot`, `decodeSnapshot`
- `packages/net/src/aoi.ts` — implement all four functions
- `packages/net/src/messages.ts` — implement `parseServerMessage`, `parseClientMessage`
- new tests: `input.spec.ts`, `snapshot.spec.ts`, `aoi.spec.ts`, `messages.spec.ts` in `packages/net/src/`
- you may add private helpers in a new `packages/net/src/wire.ts` (a small DataView reader/writer)

Do not change any exported type, constant or signature in `packages/net/src/*`. Do not edit
`constants.ts`, `api.ts`, `motion.ts`, `predictor.ts`, `interp.ts` or `todo.ts` (another task owns
the last three). Remove the `todo` import from the files you finish.

## Rules

- Little-endian everywhere. Accept `ArrayBuffer` or `Uint8Array` (honour `byteOffset`/`byteLength`).
- Quantization (encode → decode):
  - positions `Math.round(v * POS_SCALE)` clamped to i16; decode `/ POS_SCALE`
  - radii (zone) `Math.round(r * POS_SCALE)` clamped to u16
  - angles `Math.round(Math.atan2(y, x) / (2π) * 256) & 255`; decode `byte / 256 * 2π`
    (facing vectors and projectile velocities are encoded as angles)
  - hp byte: `Math.max(1, Math.round(clamp01(hp / maxHp) * 255))` for living units; shield byte
    `Math.round(clamp01(shield / maxHp) * 255)`; decode `/ 255`
  - event radius byte `clamp(round(r * 16), 0, 255)`, decode `/ 16`; arc byte `255` when
    `arc >= 2π - 1e-6` else `clamp(round(arc * 40), 0, 254)`, decode `255 → 2π` else `/ 40`
  - hit amount `clamp(round(a * 10), 0, 65535)`, decode `/ 10`
  - zone timer `clamp(round(t * 10), 0, 65535)` deciseconds; dps `clamp(round(dps), 0, 255)`
  - projectile speed `clamp(round(hypot(vel)), 0, 255)`
  - ids: u16; `0` encodes null for optional ids (sim ids start at 1). An id above 65535 throws
    `RangeError` in the encoder.
- Indices use `itemIndex`/`tagIndex`/`skillIndex`/`weaponIndex` from `constants.ts`; the decoder maps
  back with `ITEM_IDS`/`TAG_IDS`/`SKILL_IDS`/`WEAPON_IDS` and throws `RangeError` on an index out of range.
- `encodeSnapshot(world, events, viewer)`:
  - `center = aoiCenter(world, viewer.focusId)`.
  - fighters: alive and (`id === viewer.selfId` or (`center` and `inAoi(center, pos)`)), world order.
    Flags: moving `moveDir !== null`, running, dashing `dashTime > 0`, burning `status.burnTime > 0`,
    bleeding `status.bleedStacks > 0`, human `bot === null`. Weapon `build.weapon` or `NO_WEAPON`.
    Level clamped to 255.
  - monsters: alive and in AOI. Tier in bits 0–1, flags per `MonsterFlag`, target `targetId ?? 0`.
  - projectiles: in AOI. Kind 0 arrow, 1 fireball.
  - pickups: all of them (global).
  - events: those passing `eventVisible(e, center, viewer.selfId)`, in order.
  - header: `alive` = living fighters in the whole world; flags over / zone shrinking / has self;
    `winner` (0 = none); zone from `world.zone` (`current`, `to`, `stage`, `dps`, `timer`, `shrinking`).
  - self block iff the `selfId` fighter exists and is alive: exact f64 position, the f32 fields and
    bytes in the §10.4 table (moveDir `(0, 0)` when null, self flags from `moveDir`/`running`).
  - each list truncated to `MAX_LIST`; `sinceAck` and `inputQueue` clamped to 255.
  - return a Uint8Array of exactly the encoded length.
- `decodeSnapshot` rebuilds `Snapshot`; events become the sim's `GameEvent` shapes (facing vectors as
  `{ x: cos, y: sin }`, null ids as `null`, `death.kind` as `'fighter' | 'monster'`). A truncated
  buffer, wrong type byte or unknown event kind throws `RangeError`.
- `aoiCenter`: the focus fighter's position plus `(0, AOI_NORTH_OFFSET)`, or null if it is missing or dead.
- `inAoi(center, p, margin)`: squared distance ≤ `(AOI_RADIUS + margin)²`.
- `pickFocus(world, selfId, spectateId)`: own fighter if alive; else `spectateId` if alive; else the own
  fighter's `lastAttacker` if alive; else the lowest-id living fighter; else null.
- `eventVisible(e, center, selfId)` per §10.5, positional checks with `inAoi(center, pos, EVENT_MARGIN)`
  (dash: `from` or `to`), `center === null` fails every positional check.
- Input: `decodeInput` returns null unless the length is exactly `INPUT_FRAME_BYTES`, the type byte is
  `MsgType.Input` and `seq ≥ 1`. Move flag with both components 0 → `move: null`. Dash flag → `dash`
  from the i8 pair (may be `(0, 0)`). Draft/exchange indices above `MAX_DRAFT_INDEX`/`MAX_EXCHANGE_INDEX`
  → that input is null. Encoded directions use `Math.round(v * DIR_SCALE)` of the (already quantized)
  frame values.
- `hasOneShots`: attack, dash, draft, reroll or exchange present. `mergeOneShots(into, from)`: attack
  and reroll OR together; dash (with its touch flag), draft and exchange copy only when `into` has none.
- Messages: `parseServerMessage`/`parseClientMessage` return null for invalid JSON, unknown `t`,
  wrong field types, or text longer than `MAX_TEXT_MESSAGE` (client messages). Check every field of
  every message kind (numbers finite, arrays of the right element types, `reward` either null or an
  object with numeric `score`/`coins` and a `breakdown` array of `{ label: string, points: number }`).

## Tests (meaningful, not exhaustive-for-its-own-sake)

- Input round trip: extreme and diagonal directions, every flag combination you can generate
  with a seeded loop, invalid lengths/type/seq, out-of-range indices dropping only that input.
- `mergeOneShots` precedence and `hasOneShots`.
- Snapshot round trip on a real match: `createWorld({ seed: 3, fighters: 12, humans: [...] })` is not
  available yet (another task adds `humans`), so use `createWorld({ seed: 3, fighters: 12, playerName: 'me' })`,
  step 400 ticks, encode for the player, decode, and compare: every included fighter/monster/projectile
  within quantization error, exactly the AOI set (recompute it independently in the test), all pickups,
  exact self block values (f64 position equal, f32 fields within 1e-6 relative), header fields.
- Every one of the 13 event kinds round-trips (build events by hand).
- AOI boundary: units just inside and just outside the offset circle; dead focus → null center;
  `pickFocus` fallbacks in order; `eventVisible` table for every event type and both "own" and
  "positional" branches.
- Malformed snapshot buffers (truncated at several points, bad type, bad event kind, bad item index) throw.
- A typical mid-match snapshot stays under 1,500 bytes (assert a loose upper bound, print the size).

## Checks

```bash
bun run typecheck
bunx vitest run packages/net
```
