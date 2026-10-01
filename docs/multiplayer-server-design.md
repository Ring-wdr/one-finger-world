# 멀티플레이 서버 설계 (Cloudflare Workers + Durable Objects)

작성 기준: 2026-09, `docs/multiplayer-cloud-analysis.md`의 2순위안을 채택한 구현 설계입니다.
Cloudflare 기능 선택의 근거는 `cloudflare/cloudflare-docs` 저장소(2026-09-29 `production` 브랜치)의 문서입니다. 인용한 문서 경로는 각 절에 적었습니다.

이 문서는 구현의 기준입니다. 계약(타입·바이트 레이아웃·상수)은 코드의 계약 파일과 이 문서가 같아야 하며, 바꿀 때는 둘을 함께 바꿉니다.

## 1. 목표와 범위

- 서버가 `packages/sim`을 권위적으로 실행하는 12인 배틀로얄 매치. 빈자리는 봇이 채웁니다.
- 한국 우선 배치. 매치 DO는 `apac-ne`(일본·한국) 위치 힌트로 생성합니다.
- 게스트 계정, 서버에서 계산하는 보상·코인·룬 상점.
- 재접속, 끊긴 사람 자리의 봇 대행, 배포·재시작 후 매치 복구.
- 지연 검증 도구: 매치 종료 로그의 틱 지터·RTT 지표, 부하 테스트 스크립트.

범위 밖: 소셜 로그인(카카오·구글·애플), 랭크 매치메이킹, 다중 리전 로비, 리플레이 저장, 결제. 확장 경로는 18절에 적었습니다.

## 2. Cloudflare 기술 선택

| 필요 | 선택 | 근거 (문서) | 채택하지 않은 대안 |
| --- | --- | --- | --- |
| 클라이언트 정적 호스팅 | 같은 Worker의 **Workers Static Assets** | 정적 자산 요청은 무료·무제한이고 저장 비용이 없습니다 (`workers/static-assets/billing-and-limitations`). API·WebSocket과 같은 출처라 CORS가 필요 없습니다. `_headers`로 캐시 정책을 줍니다 (`workers/static-assets/headers`). | Pages(별도 프로젝트). GitHub Pages 빌드는 오프라인판으로 유지합니다. |
| HTTP API 진입 | Worker `fetch` + `assets.run_worker_first: ["/api/*"]` | 지정한 경로만 Worker를 실행하고 나머지는 자산이 바로 응답합니다 (`workers/static-assets/binding`). | 모든 요청을 Worker로 받기 |
| 실시간 매치 | 매치당 **Durable Object 1개** (SQLite 백엔드, `exports` 선언) + **Hibernation WebSocket API** | DO는 조정 단위("atom")당 하나가 권장 모델이고 초당 500~1,000 요청을 처리합니다 (`best-practices/rules-of-durable-objects`). 하이버네이션 API는 소켓별 첨부(16 KB)를 재시작 후에도 유지하고, `ping`/`pong` 자동 응답을 DO를 깨우지 않고 처리합니다 (`best-practices/websockets`, `api/state`). 새 클래스는 2026-07부터 선언형 `exports`로 관리합니다 (`reference/durable-objects-migrations`). | 표준 WebSocket API(하이버네이션·첨부 없음), PartyServer(틱 루프·체크포인트를 직접 제어해야 해서 추상화 이득이 작음), Containers(과함) |
| 매치 배치 | `newUniqueId()` + `get(id, { locationHint: 'apac-ne' })` | 이름 기반 ID는 첫 접근 때 전역 유일성 확인으로 수백 ms가 걸리고 `newUniqueId`는 이를 건너뜁니다 (`api/namespace`). 힌트는 첫 `get()`에만 적용되고 보장은 아닙니다 (`reference/data-location`). | `idFromName`으로 매치 생성 |
| 매치메이킹 | 단일 **Lobby DO** (`getByName('lobby')`) + RPC | 인구가 적을 때도 15초 창 안의 사람들을 한 매치로 묶습니다. 요청은 빠른 매치 1회당 RPC 1건이라 DO 처리량 한도보다 수백 배 낮습니다. 전역 싱글톤 경고(`rules-of-durable-objects`)는 처리량 문제이므로 샤딩 경로를 18절에 둡니다. | 시간 버킷 이름(`match:{15초 구간}`)은 싱글톤이 없지만 저인구에서 묶임이 나쁩니다. KV는 결과적 일관성이라 부적합합니다. |
| 틱 루프 | 매치 진행 중 DO 안의 `setTimeout` 드리프트 보정 루프 | 진행 중인 DO는 어차피 메모리에 있어야 합니다. 알람은 ms 단위지만 유지보수 시 최대 1분 지연될 수 있고 호출마다 과금됩니다 (`api/alarms`, `rules`의 "Only schedule alarms when there is work to do"). | 틱마다 알람 |
| 배포·장애 복구 | 2초마다 체크포인트(`storage.put(..., { allowUnconfirmed: true })`) + 5초 워치독 알람 | 배포하면 모든 DO가 재시작되고 WebSocket이 끊깁니다 (`best-practices/websockets`, `concepts/durable-object-lifecycle`). 종료 훅은 없으니 상태를 계속 기록해야 합니다 (`working-without-shutdown-hooks`). 출력 게이트는 쓰기 확정까지 나가는 메시지를 붙잡으므로 `allowUnconfirmed`로 스냅샷 전송이 막히지 않게 합니다 (`api-async-kv-legacy`의 `allowUnconfirmed`). SQLite 백엔드는 키+값 2 MB까지라 월드(약 100 KB)를 그대로 저장합니다 (`platform/limits`). | 체크포인트 없음(배포마다 진행 중 매치가 모두 사라짐) |
| 계정·프로필·경제 | **D1** (`players`, `matches`, `match_results`) | 사용자 간 조회(리더보드)와 관리 도구, 마이그레이션, Time Travel 백업이 있습니다. `batch()`는 SQL 트랜잭션이라 한 문장이 실패하면 전체가 롤백되고, 이를 이용해 보상 지급을 멱등하게 만듭니다 (`d1/worker-api/d1-database`). `database_id` 없이 바인딩하면 첫 `wrangler deploy`가 DB를 만들고 ID를 설정에 기록합니다 (`wrangler/configuration`의 Automatic provisioning). | 사용자별 DO(사용자 간 조회 불가), KV(결과적 일관성) |
| 인증 | 게스트 계정 + HMAC-SHA256 서명 토큰(Web Crypto), 비밀은 `wrangler secret` | Cloudflare에는 최종 사용자 인증 제품이 없습니다(Access는 조직 구성원용). `secrets.required`로 배포 시 누락을 막습니다 (changelog 2026-03-25). | Cloudflare Access, Turnstile(가입 남용이 생기면 추가) |
| 남용 방지 | **Rate Limiting 바인딩** (`ratelimits`) | 위치별 카운터를 Worker에서 바로 씁니다 (`runtime-apis/bindings/rate-limit`). | 전역 레이트 리밋 DO(문서가 명시한 안티패턴) |
| 관측 | **Workers Logs** (`observability.enabled`) + 구조화 JSON 로그 | 추가 비용 없이 필드로 조회합니다. 보존 7일 (`observability/logs/workers-logs`). | Analytics Engine(지표가 늘면 추가) |
| 테스트 | 순수 로직은 Node Vitest, DO·D1·WebSocket은 **`@cloudflare/vitest-plugin`**(workerd) | 2026-08에 `vitest-pool-workers`가 v1로 이름을 바꿨고 Vitest 4.1을 지원합니다. `evictDurableObject`로 퇴거를 재현합니다 (changelog 2026-06-25). WebSocket DO 테스트는 저장소 격리 없이(`maxWorkers: 1`, `isolate: false`) 돌립니다 (`vitest-integration/known-issues`). | Miniflare 직접 구동 |
| 로컬 개발 | `wrangler dev`(apps/server) + Vite 프록시 `/api`(HTTP·WS) | 클라이언트 빌드와 GitHub Pages 워크플로를 건드리지 않습니다. | Cloudflare Vite 플러그인(Vite 8 지원하지만 클라이언트 출력이 `dist/client`로 바뀌고 빌드가 묶임. 나중에 전환 가능) |

호환 날짜는 `2026-09-25`입니다(로컬 workerd 1.20260926 지원 범위). 이 날짜에서 켜지는 동작 중 설계가 기대는 것: WebSocket Close 자동 응답(`2026-04-07`), `deleteAll()`이 알람도 삭제(`2026-02-24`), Node 호환 기본값(`2026-08-04`, 쓰지 않음). DO의 `webSocketMessage`는 바이너리를 계속 `ArrayBuffer`로 받습니다(changelog 2026-04-21).

### 2.1 비용 추정

매치 DO는 진행 중 계속 메모리에 있으므로 128 MB × 330초 ≈ 42 GB-s를 씁니다. 입력은 사람당 초당 20개이고 수신 메시지는 20:1로 과금되므로 사람 12명 매치는 약 4,000 요청입니다 (`platform/pricing`).

| 플랜 | 한도 | 하루 가능한 매치(사람 12명 기준) |
| --- | --- | --- |
| Workers Free | DO 요청 10만/일, 13,000 GB-s/일 | 요청 기준 약 24판, 시간 기준 약 300판 |
| Workers Paid (월 5달러) | 요청 100만/월 포함 후 100만당 0.15달러, 40만 GB-s/월 포함 후 100만 GB-s당 12.5달러 | 제한 없음. 매치당 약 0.0012달러 |

유료 플랜은 상한 없이 쓴 만큼 냅니다. 월 5달러에 포함된 양은 사람 12명 매치로 약 250판(요청 기준, 하루 약 8판)이고, 그 뒤로는 판당 약 0.0012달러(요청 0.0006 + 실행 시간 0.0005)가 붙습니다. 예: 하루 100판이면 월 약 6.7달러, 하루 1,000판이면 월 약 34달러입니다.

사람이 적은 매치(대부분 봇)는 요청이 훨씬 적습니다. 출시 전 테스트는 무료 플랜으로 충분하고, 공개 출시는 유료 플랜을 전제로 합니다.

## 3. 전체 구조

```
브라우저 (Vite · three · Preact)
 ├─ GET /, /assets/*, /models/*  ──► Workers Static Assets (무료, 캐시)
 ├─ /api/* (HTTP)  ──────────────► Worker fetch
 │     ├─ POST /api/guest, GET /api/profile, POST /api/profile/name ── D1
 │     ├─ POST /api/shop/buy, /api/shop/equip ────────────────────── D1
 │     └─ POST /api/quickplay ── Lobby DO.assign() (RPC) ─ 매치 ID ─► 서명 티켓
 └─ WS /api/match/:id/ws?ticket= ──► Worker (티켓 검증) ─► MatchRoom DO.fetch (101)
                                          MatchRoom DO (매치당 1개, apac-ne)
                                           ├─ waiting: 최대 12명, 첫 입장 후 15초
                                           ├─ running: 20 Hz step(), 사람별 AOI 스냅샷
                                           │    2초마다 체크포인트, 5초 워치독 알람
                                           ├─ 사람 결과 확정 시 D1 보상(멱등 배치)
                                           └─ ended: 5초 후 소켓 종료, 60초 후 deleteAll
```

### 3.1 저장소 구성

```
packages/sim     (기존) + 여러 사람 createWorld, 봇 대행 전환, 체크포인트/복원
packages/meta    @ofa/meta: 프로필·룬 상점 규칙, 매치 보상(scoreMatch), 닉네임 규칙
packages/net     @ofa/net: HTTP API 타입, WebSocket 프로토콜 코덱, AOI, 클라이언트 예측·보간
apps/client      (기존) + 온라인 모드: API 클라이언트, 연결, OnlineMatch, 뷰 월드, 대기실·결과 UI
apps/server      @ofa/server: Worker 라우터·인증·API·D1, Lobby DO, MatchRoom DO
docs/multiplayer-server-design.md   이 문서
```

`@ofa/net`과 `@ofa/meta`는 DOM과 Workers API 어느 쪽에도 의존하지 않습니다. 브라우저 전용 코드(WebSocket 연결, localStorage)는 `apps/client`, Workers 전용 코드(`cloudflare:workers`)는 `apps/server`에만 둡니다.

## 4. 매치메이킹 흐름

```
클라이언트                Worker                  Lobby DO              MatchRoom DO
 │ POST /api/quickplay ─►│ 토큰 검증, D1 프로필 │                      │
 │                       │ assign(uid) ────────►│ open 매치 재사용/생성 │
 │                       │◄──── { matchId } ────│                      │
 │◄ { matchId, ticket } ─│ 티켓 서명(15분)      │                      │
 │ WS /api/match/:id/ws?ticket&v&h ─►│ 티켓·버전 검증 ───────────────►│ fetch(Upgrade)
 │◄──────────────────── 101 ─────────────────────────────────────────── │ acceptWebSocket
 │◄──── lobby {players, startsAt} ──────────────────────────────────────│ 좌석 추가
 │         ... 15초 또는 12명 ...                                        │ 알람 → start
 │◄──── start {you, fighters} / self / snapshot(20 Hz) ────────────────│
 │ input frame(20 Hz) ─────────────────────────────────────────────────►│
```

- Lobby는 매치를 만들 때 ID만 발급합니다. 매치 DO는 첫 WebSocket 연결 때 `apac-ne` 힌트와 함께 생성됩니다.
- Lobby의 열린 매치는 생성 후 12초 또는 배정 12명에서 닫힙니다. 매치 DO는 첫 입장 후 15초에 시작하므로 Lobby가 먼저 닫혀 이미 시작한 매치로 사람을 보내지 않습니다.
- 배정만 받고 접속하지 않은 사람은 좌석이 없을 뿐 문제를 만들지 않습니다.
- 시작된 매치에 새로 들어오려 하면 `4003 started`로 닫히고 클라이언트는 빠른 매치를 다시 요청합니다.

## 5. MatchRoom DO

코드는 두 층입니다.

- `apps/server/src/match/core.ts`의 `MatchCore`: Cloudflare API를 모르는 순수 상태 기계. 시간·전송·저장·보상 지급은 `MatchHost` 인터페이스(`apps/server/src/match/types.ts`)로 주입받습니다. Node Vitest로 테스트합니다.
- `apps/server/src/match/room.ts`의 `MatchRoom extends DurableObject`: 소켓·타이머·알람·저장소·D1을 `MatchHost`로 연결하는 얇은 껍데기. workerd 통합 테스트로 확인합니다.

### 5.1 상태 기계

| 상태 | 들어오는 조건 | 하는 일 | 나가는 조건 |
| --- | --- | --- | --- |
| `empty` | 저장된 메타 없음 | 없음 | 신선한 티켓으로 첫 입장 → `waiting` |
| `waiting` | 첫 좌석 | 좌석 추가·제거, `lobby` 방송, 시작 알람 | `startsAt` 도달 → `running`. 좌석이 0명으로 60초 → 삭제 |
| `running` | 시작 | 20 Hz 틱, 스냅샷, 체크포인트, 봇 대행, 사람 결과 확정·보상 | `world.over` 또는 900초 상한 → `ended` |
| `ended` | 종료 | 남은 결과 확정·보상, `end` 방송 | 5초 뒤 소켓 종료, 60초 뒤 `deleteAll()` |

`MatchMeta`(저장 키 `meta`)와 `WorldCheckpoint`(저장 키 `checkpoint`)만 저장합니다. 입력 큐와 소켓 매핑은 메모리 상태입니다.

### 5.2 좌석과 입장 규칙

좌석은 사람 1명입니다. 입장 요청은 Worker가 검증한 `SeatClaim { uid, name, runes, iat }`을 `X-OFA-Seat` 헤더(base64url JSON)로 전달합니다.

1. 같은 `uid`의 좌석이 있으면 **재접속**입니다. 이전 연결은 `4001 replaced`로 닫습니다. 상태와 무관하게 허용합니다(`ended` 포함, 결과를 다시 받습니다).
2. 새 좌석은 `waiting`(또는 `empty`)에서만, 그리고 `now - claim.iat ≤ 30초`일 때만 받습니다. 오래된 티켓이 정리된 매치 ID로 새 대기실을 만드는 일을 막습니다.
3. 좌석이 12개면 `4002 full`, 이미 시작했으면 `4003 started`, 정리된 매치에 오래된 티켓이면 `4004 ended`.
4. 첫 좌석이 생기면 `startsAt = now + 15초`, 12번째 좌석이 생기면 `startsAt = min(startsAt, now + 1.5초)`로 당깁니다.
5. `waiting` 중 연결이 끊기면 좌석을 지우고 `lobby`를 다시 보냅니다.

### 5.3 시작

`seed`는 `crypto.getRandomValues`의 u32입니다. `createWorld({ seed, fighters: 12, humans: seats })`로 좌석 순서대로 사람 전투원을 만들고 나머지는 봇입니다. 연결이 끊긴 좌석은 즉시 봇 대행으로 둡니다. 모든 연결에 `start`와 `self`를 보내고 루프를 시작합니다.

### 5.4 틱 루프 (DO 껍데기)

```
nextTickAt = now + 50
onTimer():
  now = Date.now()
  n = 0
  while now >= nextTickAt and n < 3: core.tick(); nextTickAt += 50; n++
  if now >= nextTickAt: nextTickAt = now + 50      // 3틱 넘게 밀리면 따라잡지 않고 건너뜀
  if core.phase == 'running': setTimeout(onTimer, max(0, nextTickAt - Date.now()))
```

Workers의 `Date.now()`는 I/O 때만 진행하지만 타이머 콜백 시작 시점은 반영합니다. 틱 간격 통계는 콜백 시작 시각으로 잽니다.

### 5.5 `core.tick()` 순서

1. 사람 좌석마다 입력 큐에서 프레임 하나를 꺼냅니다(5.6). 봇 대행 중이거나 전투원이 죽은 좌석은 큐를 비웁니다.
2. `step(world, commands)`.
3. 결과 확정 검사(5.9): 이번 틱에 죽은 사람 좌석의 결과를 확정하고 보상 지급을 시작합니다.
4. 연결된 좌석마다: 빌드·드래프트 상태 키가 바뀌었으면 `self`를 먼저 보내고, 스냅샷(10절)을 보냅니다.
5. 끊긴 지 3초가 지난 좌석은 봇 대행으로 전환합니다(5.8).
6. 40틱마다 체크포인트를 저장합니다.
7. `world.over`이면 종료 처리(5.10).

### 5.6 입력 큐

- 좌석마다 큐를 둡니다. 바이너리 메시지는 입력 프레임(10.3)만 받고, 길이·형식이 틀리면 무시합니다.
- `seq ≤ lastSeq`인 프레임은 버립니다. 재접속하면 `lastSeq = 0`으로 되돌립니다.
- 큐가 4개를 넘으면 가장 오래된 프레임을 버리되 일회성 입력(공격·대시·드래프트·리롤·교환)은 다음 프레임에 합칩니다(`mergeOneShots`).
- 틱마다 프레임이 있으면 하나를 꺼내 `frameToCommands` 순서(이동 → 공격 → 대시 → 드래프트 → 리롤 → 교환)로 명령을 만들고 `ack = seq`, `sinceAck = 0`으로 둡니다. 없으면 명령 없이 진행하고(`moveDir`는 전투원에 남아 있음) `sinceAck`를 1 올립니다(최대 255).
- 스냅샷에는 꺼낸 뒤 남은 큐 길이 `inputQueue`를 싣습니다. 클라이언트는 이 값으로 로컬 틱 속도를 조절합니다(11.6).

### 5.7 체크포인트와 복구

- `checkpointWorld(world)`는 `rng`를 `{ state }`로, `events`를 `[]`로 바꾼 구조적 복제본입니다(`structuredClone`, -0·NaN 보존). `restoreWorld`는 `Rng`를 다시 만들고 유닛 색인을 재구성합니다. 같은 입력이면 복원한 월드와 원본이 이후에도 같은 결과를 냅니다(테스트로 보장).
- 저장은 `ctx.storage.put('checkpoint', cp, { allowUnconfirmed: true })`로 하고 메타도 같은 방식으로 함께 씁니다. 상태 전환(시작·종료) 때는 즉시 저장합니다.
- DO 생성자는 `blockConcurrencyWhile` 안에서 메타와 체크포인트를 읽어 `MatchCore`를 복원하고, 살아남은 소켓(`ctx.getWebSockets()`의 첨부 `{ uid }`)을 좌석에 다시 붙이고, `running`이면 루프를 시작합니다.
- 재시작 후 모든 좌석은 끊긴 상태에서 시작하므로 3초 안에 재접속하지 않으면 봇이 대행합니다. 월드는 최대 2초 되돌아갑니다.
- 복원 직후 3회 연속 틱 예외가 나면(`crashes`) 매치를 `aborted`로 끝내고 보상 없이 정리합니다. 틱 예외는 로그로 남기고 루프를 멈춘 뒤 워치독이 복원을 다시 시도합니다.

### 5.8 끊김, 봇 대행, 떠나기

- 끊김(`webSocketClose`/`webSocketError`): 좌석의 연결을 비우고 `disconnectedAt = now`.
- 3초가 지나도 돌아오지 않으면 `setBotControl(world, fighterId, true)`로 봇이 조작합니다. 이 순간의 **잠긴 결과**를 기록합니다: `placement = 그때 살아 있는 전투원 수(자신 포함)`, 킬·레벨·시간.
- 돌아오면 `setBotControl(false)`로 되돌리고 잠긴 결과를 지웁니다. `start`·`self`와 다음 스냅샷을 보냅니다.
- `{ t: 'leave' }`는 즉시 봇 대행으로 전환하고 잠급니다. 같은 좌석으로 다시 들어오면 잠금이 풀립니다.
- 잠긴 결과는 자리를 비운 사람이 봇 덕분에 보상을 받는 것을 막습니다(자리를 비운 순간 탈락으로 계산).
- 연결된 사람이 30초 동안 한 명도 없으면 남은 매치를 `runHeadless`로 즉시 끝냅니다(수백 ms). 사람의 결과는 죽을 때나 잠길 때 이미 정해지므로 결과가 바뀌지 않습니다.

### 5.9 결과 확정과 보상

- 좌석의 결과는 다음 중 먼저 오는 때 확정됩니다: 전투원이 죽음(잠겨 있으면 잠긴 결과), 매치 종료(생존자·잠긴 좌석).
- 확정 결과로 `scoreMatch({ placement, fighters: 12, kills, level, time })`를 계산하고 D1에 지급합니다(9.3). 연결돼 있으면 `result` 메시지를 보냅니다.
- 지급이 실패하면 좌석을 `pendingGrant`로 메타에 남기고 30초 간격으로 최대 10회 알람에서 재시도합니다. 이 경우 `result.rewardPending = true`이고 코인은 다음 프로필 조회에서 보입니다.

### 5.10 종료와 정리

- `world.over`(또는 900초 상한)이면 남은 결과를 확정·지급하고 `end { winner }`를 보냅니다. 상태를 저장하고 루프를 멈춥니다.
- 5초 뒤 모든 소켓을 `1000`으로 닫고, 60초 뒤 `deleteAll()`로 저장소와 알람을 지웁니다. 900초 상한에서 살아 있는 전투원은 모두 `placement = 생존자 수`로 처리합니다.

### 5.11 알람

DO는 알람을 하나만 가질 수 있으므로 `MatchCore`가 다음 마감 시각 중 가장 이른 것을 계산해 `host.setAlarm`을 부릅니다.

| 상태 | 마감 |
| --- | --- |
| waiting | `startsAt`, 좌석 0명이면 `emptySince + 60초` |
| running | `now + 5초`(워치독: 체크포인트, 루프 확인, 방치 검사) |
| ended | 소켓 종료 시각, 보상 재시도 시각, 정리 시각 |

알람은 최소 1회 실행을 보장하지만 여러 번 올 수 있으므로 모든 처리는 멱등입니다(`rules`의 "Make alarm handlers idempotent").

### 5.12 타이밍 상수 (`apps/server/src/match/types.ts`)

| 상수 | 값 |
| --- | --- |
| `WAIT_MS` | 15,000 |
| `FULL_START_DELAY_MS` | 1,500 |
| `JOIN_TICKET_MAX_AGE_MS` | 30,000 |
| `DISCONNECT_GRACE_MS` | 3,000 |
| `ABANDON_MS` | 30,000 |
| `CHECKPOINT_EVERY_TICKS` | 40 |
| `WATCHDOG_MS` | 5,000 |
| `END_LINGER_MS` | 5,000 |
| `CLEANUP_AFTER_END_MS` | 60,000 |
| `EMPTY_ROOM_TTL_MS` | 60,000 |
| `MAX_CATCHUP_TICKS` | 3 |
| `MAX_TICK_CRASHES` | 3 |
| `MAX_MATCH_SECONDS` | 900 |
| `GRANT_RETRY_MS` / `MAX_GRANT_ATTEMPTS` | 30,000 / 10 |

## 6. Lobby DO

- `assign(uid): Promise<{ matchId }>` RPC 하나만 둡니다.
- 상태 `open = { matchId, createdAt, uids[] }`를 동기 KV(`ctx.storage.kv`)에 저장합니다. 하이버네이션 뒤에도 묶음이 유지됩니다.
- 같은 `uid`가 창 안에서 다시 요청하면 같은 매치를 돌려줍니다.
- `open`이 없거나, 12초가 지났거나, 12명이 찼으면 `env.MATCH.newUniqueId().toString()`으로 새 매치를 엽니다.
- Worker는 `env.LOBBY.getByName('lobby', { locationHint })`로 부릅니다.

## 7. Worker HTTP API

모든 응답은 JSON입니다. 오류는 `{ "error": { "code": ApiErrorCode, "message": string } }`입니다.

| 메서드 | 경로 | 인증 | 요청 | 응답 | 레이트 리밋 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | 없음 | - | `HealthResponse { ok, protocol, dataHash, multiplayer }` | - |
| POST | `/api/guest` | 없음 | - | `GuestResponse { token, profile }` | `GUEST_LIMITER` IP당 30/60초 |
| GET | `/api/profile` | Bearer 게스트 토큰 | - | `ProfileResponse { profile }` | - |
| POST | `/api/profile/name` | Bearer | `{ name }` | `ProfileResponse` | - |
| POST | `/api/shop/buy` | Bearer | `{ runeId }` | `ProfileResponse` | - |
| POST | `/api/shop/equip` | Bearer | `{ runeId }` | `ProfileResponse` (장착 중인 룬이면 해제) | - |
| POST | `/api/quickplay` | Bearer | - | `QuickplayResponse { matchId, ticket }`, 닫혀 있으면 503 `closed` | `PLAY_LIMITER` uid당 20/60초 |
| GET | `/api/match/:id/ws` | 쿼리 `ticket` | `v`, `h` 쿼리 | 101 | - |

- 상태 코드: 400 `bad_request`, 401 `unauthorized`, 404 `not_found`, 409 `coins`·`owned`·`conflict`·`version`, 422 `unknown_rune`·`bad_name`, 426 WebSocket 아님, 429 `rate_limited`, 500 `server`, 503 `closed`(운영 스위치, 7.1).
- `/api/match/:id/ws`는 `Upgrade: websocket`, `:id` 형식(64자리 16진수), 티켓 서명·만료·`mid` 일치, `v == PROTOCOL_VERSION`, `h == DATA_HASH`를 확인한 뒤 `X-OFA-Seat` 헤더를 붙여 `env.MATCH.get(idFromString(id), { locationHint }).fetch(request)`로 넘깁니다. 버전이 다르면 409 `version`입니다.
- CORS: 같은 출처 요청은 헤더가 필요 없습니다. `Origin`이 `ALLOWED_ORIGINS`(쉼표 목록)에 있으면 CORS 헤더를 붙이고 `OPTIONS`에 204로 답합니다. WebSocket은 `Origin`이 없거나, 같은 출처이거나, 허용 목록에 있어야 합니다(교차 사이트 WebSocket 탈취 방지).
- 무료 플랜 Worker는 요청당 CPU 10 ms입니다. 모든 핸들러는 서명 1~2회와 D1 호출 1~3회로 끝나야 합니다.

### 7.1 운영 스위치 (멀티플레이 켜기/끄기)

무료 플랜 한도를 지키거나 장애에 대응할 때 관리자가 재배포 없이 온라인 매치를 닫습니다.

```bash
bun run multiplayer -- off      # 닫기 (원격 D1)
bun run multiplayer -- on       # 열기
bun run multiplayer -- status   # 현재 값 (--local: wrangler dev의 로컬 D1)
```

- 값은 D1 `settings` 테이블의 `multiplayer` 행(`on`/`off`, `migrations/0002_settings.sql`)입니다. 스크립트는 로그인된 wrangler로 `d1 execute`만 하므로 새 비밀이나 관리자 API가 없습니다. 대시보드의 D1 콘솔에서 행을 고쳐도 됩니다.
- Worker는 isolate마다 10초 캐시(`SETTINGS_CACHE_MS`)로 읽으므로 전 세계 반영까지 최대 10초입니다. 행이 없으면 열림, 읽기에 실패하면 마지막 값을 씁니다.
- 닫히면 `/api/quickplay`가 503 `closed`를 돌려주고 `/api/health`의 `multiplayer`가 `false`가 됩니다. 이미 진행 중인 매치와 프로필·상점 API는 그대로입니다.
- 클라이언트는 온라인 매치 버튼을 그대로 두되 "지금은 닫혀 있어요"로 표시하고, 누르면 서버에 다시 확인한 뒤 닫혀 있으면 대기열에 들어가지 않고 안내 팝업만 띄웁니다. 버튼을 누른 사이에 닫힌 경우에도 대기 화면이 같은 문구를 보여 줍니다.

## 8. 인증 토큰

형식: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(AUTH_SECRET, 앞부분의 ASCII 바이트))`. 검증은 `crypto.subtle.verify`(상수 시간)로 합니다. 키는 격리 단위로 한 번만 가져옵니다.

| 종류 | 페이로드 | 수명 |
| --- | --- | --- |
| 게스트 | `{ typ: 'guest', sub: uid, iat }` | 만료 없음(비밀 교체로 무효화) |
| 티켓 | `{ typ: 'ticket', sub: uid, mid, name, runes, iat, exp }` | 15분 |

`typ`이 다르면 거부합니다. `AUTH_SECRET`은 32바이트 이상 무작위 값이고 `wrangler secret put AUTH_SECRET`으로 넣습니다. 로컬은 `apps/server/.dev.vars`(커밋하지 않음).

## 9. D1

### 9.1 스키마 (`apps/server/migrations/0001_init.sql`)

`players(id, name, coins, best, matches, owned JSON, equipped JSON, version, created_at, last_seen_at)`, `matches(id, seed, started_at, ended_at, duration_s, humans, winner_player_id)`, `match_results(match_id, player_id, placement, kills, level, survived_s, score, coins, left_early)`. 기본 키 `(match_id, player_id)`가 멱등성의 근거입니다.

### 9.2 상점 (낙관적 동시성)

```
SELECT ... FROM players WHERE id = ?        → parseProfile → buyRune/toggleRune (@ofa/meta)
UPDATE players SET coins=?, owned=?, equipped=?, version=version+1 WHERE id=? AND version=?
changes == 0 이면 최대 3회 재시도, 그래도 실패하면 409 conflict
```

규칙은 클라이언트와 같은 `@ofa/meta` 함수를 씁니다.

### 9.3 보상 지급 (좌석 단위, 멱등)

```
prev = SELECT best FROM players WHERE id = ?
batch([
  INSERT INTO match_results (...) VALUES (...),          -- (match_id, player_id) 중복이면 배치 전체 롤백
  UPDATE players SET coins = coins + ?, best = MAX(best, ?), matches = matches + 1,
         version = version + 1, last_seen_at = ? WHERE id = ?
])
after = SELECT coins, best FROM players WHERE id = ?
```

중복 오류(`UNIQUE constraint failed: match_results`)는 "이미 지급됨"으로 보고 `after`만 읽습니다. 매치 종료 때 `INSERT OR IGNORE INTO matches`로 매치 행을 남깁니다. 재시도해도 코인이 두 번 들어가지 않습니다.

## 10. 실시간 프로토콜

계약 파일: `packages/net/src/constants.ts`, `input.ts`, `snapshot.ts`, `messages.ts`, `api.ts`. 모든 정수는 리틀 엔디언입니다.

### 10.1 연결

- URL: `/api/match/{matchId}/ws?ticket={ticket}&v={PROTOCOL_VERSION}&h={DATA_HASH}`.
- `DATA_HASH`는 `ITEMS`(id·종류), `WEAPON_IDS`, `TAGS`, 스킬 ID 순서, `RUNES` id를 이어 붙인 문자열의 FNV-1a 32비트 16진수입니다. 아이템·무기·태그·스킬 색인을 바이트로 보내므로 순서가 다르면 연결을 거부합니다.
- 핑: 클라이언트가 텍스트 `"ping"`을 보내면 런타임이 DO를 깨우지 않고 `"pong"`으로 답합니다(`setWebSocketAutoResponse`). 한 번에 하나씩 보내 RTT를 잽니다.

### 10.2 종료 코드

| 코드 | 이름 | 의미 |
| --- | --- | --- |
| 1000 | Normal | 매치 종료 후 정상 종료 |
| 4001 | Replaced | 같은 계정의 새 연결 |
| 4002 | Full | 좌석 12개가 참 |
| 4003 | Started | 이미 시작한 매치에 새 좌석 요청 |
| 4004 | Ended | 끝났거나 정리된 매치 |
| 4005 | BadSeat | 좌석 정보 누락·형식 오류 |
| 4006 | Version | 프로토콜 또는 데이터 해시 불일치 |
| 4010 | ServerError | 복구 불가 오류(`aborted`) |

### 10.3 입력 프레임 (클라이언트 → 서버, 바이너리 12바이트)

| 오프셋 | 형식 | 필드 |
| --- | --- | --- |
| 0 | u8 | `MsgType.Input` = 1 |
| 1 | u32 | `seq` (로컬 틱 번호, 1부터, 단조 증가) |
| 5 | u8 | 플래그: bit0 이동, bit1 달리기, bit2 공격, bit3 대시, bit4 터치 대시, bit5 드래프트, bit6 리롤, bit7 교환 |
| 6 | i8 | 이동 x × 127 |
| 7 | i8 | 이동 y × 127 |
| 8 | i8 | 대시 x × 127 |
| 9 | i8 | 대시 y × 127 |
| 10 | u8 | 드래프트 색인(0~2) |
| 11 | u8 | 교환 아이템 색인(0~63) |

- 방향은 `quantizeDir`로 `q/127` 값으로 만든 뒤 보내고, 클라이언트 예측도 같은 값을 씁니다. 서버와 클라이언트가 같은 벡터를 `normalize`하므로 이동 결과가 비트 단위로 같습니다.
- 이동 플래그가 있는데 두 성분이 0이면 이동 없음으로 봅니다. 드래프트 색인이 2를 넘거나 교환 색인이 63을 넘으면 그 입력만 버립니다.
- 클라이언트는 매치가 진행 중이고 자기 전투원이 살아 있으면 **매 로컬 틱마다** 프레임을 보냅니다(멈춰 있어도). 서버가 틱마다 프레임 하나를 소비하므로 `ack` 이후 프레임만 다시 적용하면 예측이 정확합니다.

### 10.4 스냅샷 (서버 → 클라이언트, 바이너리)

좌표는 `POS_SCALE = 128`의 고정소수점 i16(±255 유닛), 반지름은 u16(×128), 각도는 u8(`round(atan2(y, x) / 2π × 256) & 255`)입니다.

헤더 34바이트:

| 오프셋 | 형식 | 필드 |
| --- | --- | --- |
| 0 | u8 | `MsgType.Snapshot` = 2 |
| 1 | u32 | `tick` |
| 5 | u32 | `ack` (0 = 없음) |
| 9 | u8 | `sinceAck` |
| 10 | u8 | `inputQueue` |
| 11 | u8 | `phase` (1~3) |
| 12 | u8 | 살아 있는 전투원 수(전역) |
| 13 | u8 | 플래그: bit0 `over`, bit1 자기장 수축 중, bit2 자기 블록 있음 |
| 14 | u16 | `focusId` (AOI 중심 전투원, 0 = 없음) |
| 16 | u16 | `winner` (0 = 없음) |
| 18 | u8 | 자기장 단계 |
| 19 | u8 | 자기장 초당 피해(정수) |
| 20 | u16 | 자기장 타이머(0.1초 단위) |
| 22 | i16 ×2, u16 | 현재 원 중심 x·y, 반지름 |
| 28 | i16 ×2, u16 | 다음 원 중심 x·y, 반지름 |

자기 블록 87바이트(자기 전투원이 살아 있을 때만):

| 오프셋 | 형식 | 필드 |
| --- | --- | --- |
| +0 | f64 ×2 | 위치 x, y (예측 기준점이라 정밀도를 유지) |
| +16 | f32 ×2 | facing x, y |
| +24 | f32 ×2 | moveDir x, y (없으면 0, 0) |
| +32 | f32 | dashTime |
| +36 | f32 ×2 | dashDir x, y |
| +44 | f32 | dashCd |
| +48 | f32 | dashCdMax |
| +52 | f32 | rootTime |
| +56 | f32 | attackCd |
| +60 | f32 | attackQueued |
| +64 | f32 | hasteBuff |
| +68 | f32 ×4 | hp, maxHp, shield, xp |
| +84 | u8 ×2 | level, kills |
| +86 | u8 | 플래그: bit0 이동 중, bit1 달리기 |

엔티티 목록(각각 u8 개수 뒤에 레코드):

| 목록 | 레코드 | 크기 | 포함 조건 |
| --- | --- | --- | --- |
| 전투원 | u16 id, i16 x, i16 y, u8 facing, u8 hp(0~255 비율), u8 shield(비율), u8 플래그(bit0 이동, bit1 달리기, bit2 대시, bit3 화상, bit4 출혈, bit5 사람 좌석), u8 무기 색인(255 = 없음), u8 레벨 | 12 | 살아 있고 AOI 안(자기 전투원 포함) |
| 몬스터 | u16 id, i16 x, i16 y, u8 (bit0-1 티어, bit2 훈련 인형, bit3 화상, bit4 출혈, bit5 귀환 중), u8 hp 비율, u16 targetId(0 = 없음) | 10 | 살아 있고 AOI 안 |
| 투사체 | u16 id, i16 x, i16 y, u8 종류(0 화살, 1 화염구), u8 진행 각도, u8 속도(유닛/초) | 9 | AOI 안 |
| 획득물 | u16 id, i16 x, i16 y, u8 아이템 색인 | 7 | 전부(맵 전체에 수 개) |

hp 비율은 살아 있으면 최소 1입니다. 목록은 255개에서 자릅니다(실제 최대 약 110).

이벤트(u8 개수 뒤에 u8 종류 + 본문):

| 종류 | 이벤트 | 본문 |
| --- | --- | --- |
| 0 | attack | u16 unit, i16 x, i16 y, u8 facing, u8 radius×16, u8 arc×40 (255 = 한 바퀴), u8 combo |
| 1 | hit | u16 target, u16 src(0 = 없음), u16 amount×10, u8 crit, i16 x, i16 y |
| 2 | death | u16 unit, u8 kind(0 fighter, 1 monster), u16 killer(0 = 없음), i16 x, i16 y |
| 3 | levelUp | u16 unit, u8 level |
| 4 | synergy | u16 unit, u8 태그 색인, u8 tier |
| 5 | dash | u16 unit, i16 fromX, fromY, toX, toY |
| 6 | pickup | u16 unit, u8 아이템 색인 |
| 7 | drop | i16 x, i16 y, u8 아이템 색인, u16 from |
| 8 | skill | u16 unit, u8 스킬 색인, i16 x, i16 y, u8 radius×16 |
| 9 | explode | i16 x, i16 y, u8 radius×16, u16 src |
| 10 | phase | u8 phase |
| 11 | zone | u8 stage |
| 12 | end | u16 winner |

디코더는 sim의 `GameEvent` 객체를 그대로 만들어 기존 렌더러·HUD가 바꾸지 않고 소비합니다.

### 10.5 관심 영역(AOI)

- 중심 = 초점 전투원 위치 + (0, `AOI_NORTH_OFFSET` = 8), 반지름 `AOI_RADIUS` = 46.
- 근거: 카메라는 고정 쿼터뷰라 화면 위쪽이 더 멀리 보입니다. 세로 화면(`cameraScale` ≈ 2)에서는 초점 기준 북쪽 43.6·남쪽 25·좌우 10~18 유닛, 가로 화면(21:9)에서는 북쪽 21·남쪽 12·좌우 최대 41 유닛이 보입니다. 이 원은 두 방향의 화면 모서리를 3 유닛 여유로 덮고, 미니맵의 적 표시 반경(35)도 덮습니다. 분석 문서의 35는 카메라 계산 전 추정치였습니다.
- 초점: 자기 전투원이 살아 있으면 자신, 아니면 관전 대상(`spectate`로 지정한 살아 있는 전투원), 아니면 자기를 죽인 전투원, 아니면 id가 가장 작은 살아 있는 전투원.
- 이벤트 가시성(`eventVisible`): phase·zone·end·전투원 death는 항상. levelUp·synergy·pickup은 자기 것만. hit은 자기가 가해자·피해자면 항상, 아니면 위치로. attack·dash·skill은 자기 것이면 항상, 아니면 위치로(dash는 시작점이나 끝점). monster death·drop·explode는 위치로. 위치 판정 반경은 `AOI_RADIUS + EVENT_MARGIN(4)`.

### 10.6 JSON 제어 메시지

서버 → 클라이언트:

| `t` | 필드 | 보내는 때 |
| --- | --- | --- |
| `lobby` | `matchId, players[{ name, you }], max, startsAt, serverNow` | 대기실 변화 |
| `start` | `matchId, tick, you(fighterId 또는 null), fighters[{ id, name, color, human }]` | 시작, 재접속 |
| `self` | `items, runes, offer, pendingDrafts, rerolls, exchangeTokens` | 시작, 재접속, 변경 시(스냅샷보다 먼저) |
| `result` | `placement, kills, level, time, reward, coins, best, newBest, rewardPending` | 자기 좌석 결과 확정 시, 재접속 시 |
| `end` | `winner` | 매치 종료 |

클라이언트 → 서버: `{ t: 'spectate', id }`, `{ t: 'leave' }`, `{ t: 'stats', rtt: { p50, p95, n } }`. 텍스트 메시지는 512바이트 이하만 파싱합니다.

## 11. 클라이언트 넷코드

`@ofa/net`의 순수 모듈과 `apps/client/src/net`의 브라우저 모듈로 나눕니다.

### 11.1 로컬 틱과 입력

- `OnlineMatch.frame(now)`가 누적 시간으로 로컬 틱(기본 50 ms, 11.6에서 조절)을 돌립니다.
- 틱마다 입력 상태(조이스틱 방향·달리기)와 쌓인 일회성 입력으로 `InputFrame`을 만들고, `quantizeDir`를 적용해 보내고, 예측기에 넣습니다.
- 제스처·키보드·HUD의 `Command`는 기존 `Game.queue` 경로로 들어와 `OnlineMatch.command()`가 입력 상태와 일회성 입력으로 바꿉니다.

### 11.2 예측과 조정 (자기 전투원 이동만)

- `stepMotion(state, frame, stats)`은 sim의 `step()` 중 자기 전투원 이동에 해당하는 부분을 같은 연산 순서로 재현합니다: 명령 적용(이동 → 공격 → 대시) 다음 `updateFighter`의 타이머 감소, 대시 또는 걷기·달리기 이동, 공격 발동 시 `rootTime`, 맵 경계 제한. 상수와 `moveWithCollision`, `normalize`, `dashCooldownFor`는 sim에서 가져옵니다.
- 모르는 것(자동 조준 facing, 피격 사망, 레벨업 중 스탯 변화)은 조정으로 메웁니다.
- 조정: 스냅샷의 자기 블록을 기준점으로 삼아 `seq > ack`인 보낸 프레임을 다시 적용합니다. 서버는 틱마다 프레임을 하나씩 소비하므로 `ack` 이후 프레임이 아직 적용되지 않은 입력과 정확히 일치합니다. 서버가 굶은 틱(`sinceAck > 0`)은 이미 기준점에 반영돼 있습니다.
- 표시 위치는 `예측 위치 + 오차`이고 오차는 초당 12의 지수 감쇠로 0이 됩니다. 오차가 3 유닛을 넘으면 즉시 맞춥니다.
- 등가성 테스트: sandbox 월드에서 사람 한 명에게 무작위 프레임 2,000틱을 넣고, 매 틱 sim 결과와 `stepMotion` 결과의 위치·타이머가 정확히 같아야 합니다.
- 비트 단위 일치는 같은 JS 엔진 안에서만 성립합니다. 구현 중 같은 sim이 Bun(JavaScriptCore)과 Node(V8)에서 다른 결과를 내는 것을 확인했습니다(`Math.hypot` 등 마지막 비트 차이). 서버(workerd)는 V8이므로 Chrome·Android와는 같고, iOS Safari(JavaScriptCore)는 아주 작은 차이가 날 수 있으며 조정이 흡수합니다. 서버 권위 모델이라 이 차이는 판정에 영향이 없습니다.

### 11.3 보간

- `ServerClock`: 스냅샷 도착 시각으로 서버 틱 시계를 추정합니다. `base = now - tick × 50`의 최솟값을 따르되 늦게 도착하는 쪽으로는 2%씩 천천히 이동합니다. 도착 간격 지터의 이동 평균을 따로 잽니다.
- 렌더 틱 = 추정 서버 틱 − (2 + 지터/50, 최대 5).
- `SnapshotBuffer`는 최근 32개를 틱 순서로 보관하고 `sample(renderTick)`이 앞뒤 스냅샷과 alpha를 줍니다. 최신보다 앞이면 최신에 멈춥니다(외삽하지 않음). 틱이 되돌아가면(서버 복원) 버퍼와 시계를 초기화합니다.
- 렌더러에는 `world` = 뒤 스냅샷의 엔티티, `prev` = 앞 스냅샷의 위치, `alpha`를 넘깁니다. 기존 `Renderer.render(world, prev, alpha, ...)` 계약을 그대로 씁니다. 자기 전투원은 `prev`와 `world` 모두에 표시 위치를 넣어 alpha와 무관하게 예측 위치에 그립니다.

### 11.4 뷰 월드

`apps/client/src/net/viewWorld.ts`가 스냅샷을 `World` 모양의 객체(`ViewWorld = World & { aliveTotal, roster }`)로 바꿉니다. 렌더러·HUD가 읽는 필드만 채우고 나머지는 기본값입니다. 원격 전투원의 `maxHp`는 1, `hp`는 비율입니다(렌더러는 비율만 씀). 자기 전투원은 자기 블록·`self` 메시지·예측 상태를 합쳐 전체 `Fighter`와 `summarizeBuild(items, runes)`를 채웁니다. 엔티티 객체는 id별로 재사용해 프레임마다 할당하지 않습니다.

### 11.5 이벤트 전달

자기 전투원이 주체인 이벤트(`attack`·`dash`·`levelUp`·`synergy`·`pickup`, `src`가 자신인 `hit`)는 도착 즉시, 나머지는 해당 스냅샷이 렌더 틱에 닿을 때 렌더러·HUD·효과음에 넘깁니다. 자기 공격의 손맛(약 RTT/2 + 틱 대기)을 보간 지연(100 ms)에서 떼어 냅니다.

### 11.6 로컬 틱 속도 조절

`inputQueue`의 이동 평균이 목표(1)보다 크면 로컬 틱을 늘이고 작으면 줄입니다: `tickMs = 50 × (1 + clamp(0.02 × (depth − 1), −0.05, 0.05))`. 클라이언트와 서버의 시계 차이로 큐가 쌓이거나 비는 것을 막습니다.

### 11.7 재접속

- 예기치 않은 종료(1000·40xx 외)는 0.5, 1, 2, 4, 8초 간격으로 같은 티켓(15분 유효)으로 다시 붙습니다. 30초 안에 못 붙으면 포기합니다.
- 40xx는 오류로 보고 사용자에게 알립니다. 4006은 새로고침을 안내합니다.
- 재접속 후 `start`를 받으면 예측기와 버퍼를 초기화합니다.

### 11.8 RTT 측정

2초마다 `ping`을 보내 `pong`까지 시간을 잽니다. 최근 30개로 p50·p95를 내고, 디버그 오버레이(`?net=1`)에 틱 간격·큐 길이와 함께 표시하고, 자기 결과를 받으면 `stats`로 서버에 보냅니다.

## 12. 클라이언트 흐름

- 시작 시 `GET /api/health`(3초 제한)로 온라인 가능 여부를 봅니다. API 출처는 `import.meta.env.VITE_API_ORIGIN || location.origin`입니다. GitHub Pages 빌드처럼 API가 없으면 오프라인 모드로 지금과 똑같이 동작합니다.
- 온라인 가능하면 게스트 토큰을 확인하거나 만들고(`localStorage` 키 `ofa.auth.v1`) 서버 프로필을 씁니다. 메뉴·상점·결과가 서버 프로필을 보여 주고, 상점은 API로 사고 장착합니다. 로컬 연습 매치는 코인을 주지 않습니다(서버 프로필 모드). 오프라인 모드는 기존 로컬 프로필을 그대로 씁니다. 기존 로컬 코인은 서버로 옮기지 않습니다(조작 가능한 값이라서).
- 스테이지: `menu → queue → online → result`, `result → queue | menu | spectate`, `spectate → result | queue`. 기존 `match`(연습)와 `tutorial`은 그대로입니다. 결과 화면의 "다시 하기"는 마지막 모드를 따릅니다.
- `queue` 화면은 대기실 인원과 시작까지 남은 시간(`startsAt − (Date.now() + serverNow 보정)`)을 보여 주고 취소하면 연결을 닫습니다.
- 온라인 매치에서 자기 전투원이 죽으면 결과 화면으로 가고, `result` 메시지가 오면 보상을 채웁니다. 관전은 연결을 유지한 채 `spectate`로 초점을 바꿉니다. 로스터와 전역 사망 이벤트로 살아 있는 전투원 목록을 유지합니다.
- HUD 변경은 두 가지입니다: 생존자 수는 `aliveTotal`을 우선 쓰고, 킬피드 이름은 로스터 조회 함수를 받습니다.

## 13. 보안

- 모든 게임 판정은 서버에서 합니다. 클라이언트가 보내는 것은 방향과 버튼뿐이고 쿨다운·사거리·드래프트 가능 여부는 sim이 검사합니다.
- AOI 밖 엔티티를 보내지 않아 맵핵이 불가능합니다. 획득물 위치만 전역으로 보냅니다(기존 미니맵과 같음).
- 보상·코인·룬은 서버에서만 바뀌고, 매치의 룬은 티켓에 담긴 서버 프로필 값만 씁니다.
- 입력: 바이너리 프레임은 12바이트만, 큐는 4개까지, 텍스트는 512바이트까지. 요청 본문은 형식을 검사하고, SQL은 모두 바인딩 파라미터를 씁니다.
- DO는 Worker 바인딩으로만 닿으므로 `X-OFA-Seat` 헤더를 신뢰합니다. Worker는 외부에서 들어온 같은 이름의 헤더를 덮어씁니다.
- 닉네임은 2~12자, 한글·영문·숫자·`_`·`-`·공백만 허용합니다. HUD는 이름을 `textContent`로만 넣습니다.
- 로그에 토큰·비밀을 남기지 않습니다.

## 14. 관측과 검증 기준

매치 DO는 구조화 로그를 남깁니다(`console.log(JSON.stringify(...))`).

| 이벤트 | 주요 필드 |
| --- | --- |
| `match_start` | matchId, humans, seed, colo(DO 위치: `cdn-cgi/trace` 1회 조회) |
| `match_end` | matchId, durationS, ticks, humans, tickIntervalMs{p50,p95,p99,max}, lateTicks(>70 ms), skippedTicks, snapshotBytesAvg, inputsDropped, inputStarvedTicks, reconnects, botTakeovers, restores, rtt{p50,p95}(사람들 보고의 중앙값) |
| `match_restore` | matchId, tick, crashes |
| `grant_error` | matchId, uid, attempt, message |

분석 문서의 채택 조건을 그대로 씁니다: 국내 모바일 회선 RTT 중앙값 40 ms 미만·p95 80 ms 미만, 12명 접속 상태에서 틱 간격 p99 70 ms 미만. `apps/server/scripts/loadtest.ts`로 측정하고 Workers Logs의 `match_end`로 교차 확인합니다.

## 15. 테스트 전략

| 층 | 도구 | 대상 |
| --- | --- | --- |
| sim | Node Vitest | 여러 사람 createWorld, 봇 대행 전환, 체크포인트 왕복의 결정론 |
| meta | Node Vitest | 기존 보상·상점 테스트 이전, 닉네임 규칙 |
| net | Node Vitest | 입력·스냅샷·이벤트 코덱 왕복, 양자화 경계값, AOI 포함·제외, 이벤트 가시성, `stepMotion` 등가성, 예측 조정(지연·손실 시뮬레이션), 스냅샷 버퍼·시계 |
| server 순수 로직 | Node Vitest | 토큰 서명·검증·위조·만료, `MatchCore` 전체 흐름(가짜 호스트·가짜 시계) |
| server 통합 | `@cloudflare/vitest-plugin` | API(게스트→프로필→구매 실패→장착→빠른 매치), Lobby 묶음·교체, WebSocket 입장·시작·입력·스냅샷, 퇴거 후 복원(`evictDurableObject`), D1 보상 멱등성 |
| client | Node Vitest | 뷰 월드 변환, OnlineMatch(가짜 WebSocket·가짜 시계), 스테이지 전이 |
| 종단 | `wrangler dev` + 부하 테스트 스크립트 + 브라우저 스모크 | 실제 프로세스 사이의 동작 |

통합 테스트 전용 RPC(`debugForceStart`, `debugFastForward`, `debugState`)는 `TEST_HOOKS == "1"`일 때만 동작합니다. 운영 설정은 `"0"`입니다.

## 16. 개발과 배포

### 16.1 로컬 개발

```bash
bun install
bun run dev:online   # wrangler dev(8787) + vite(5173, /api 프록시) → http://localhost:5173
```

`scripts/dev-online.ts`가 처음 한 번 필요한 준비를 합니다: `apps/client/dist`가 없으면 빌드(Worker 정적 에셋 디렉터리), `apps/server/.dev.vars`가 없으면 `.dev.vars.example` 복사(로컬 `AUTH_SECRET`), 로컬 D1 마이그레이션. Worker는 `--var ALLOWED_ORIGINS:*`로 띄워 Vite 출처의 WebSocket을 받고, Vite는 `OFA_API_PROXY`가 있을 때만 `/api`(HTTP·WS)를 프록시합니다. 그래서 오프라인 개발은 기존 `bun run dev` 그대로이고 프록시 오류도 없습니다.

### 16.2 첫 배포 (wrangler가 로그인된 로컬 머신에서)

```bash
cd apps/server
npx wrangler secret put AUTH_SECRET          # openssl rand -base64 48 값을 붙여 넣기
cd ../..
bun run deploy                               # 클라이언트 빌드 → wrangler deploy (D1 자동 생성, ID가 wrangler.jsonc에 기록됨)
bun run db:migrate:remote                    # 원격 D1에 스키마
git add apps/server/wrangler.jsonc && git commit -m "chore(server): record the D1 database id"
```

- 첫 배포 직후 마이그레이션 전까지 약 1분간 API가 테이블 없음 오류를 냅니다. 공개 전이라 문제되지 않습니다.
- `secrets.required`에 `AUTH_SECRET`이 있어 비밀 없이 배포하면 실패합니다.
- 배포하면 진행 중 매치의 소켓이 끊기고 체크포인트에서 이어집니다(최대 2초 되돌아감). 사람이 많을 때는 배포를 피합니다.

### 16.3 CI

- 기존 `deploy-pages.yml`은 그대로 타입체크·테스트 후 GitHub Pages에 오프라인판을 배포합니다. 저장소 변수 `VITE_API_ORIGIN`을 두면 Pages판도 Worker에 교차 출처로 붙습니다(`ALLOWED_ORIGINS`에 Pages 출처 필요).
- `deploy-cloudflare.yml`은 수동 실행(`workflow_dispatch`)만 합니다. 저장소 비밀 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`가 필요하고, D1 ID가 설정에 기록된 뒤(16.2) 씁니다.

## 17. 작업 분해

설계와 계약(타입·바이트 배치·상수)을 먼저 고정하고, 구현은 아래 작업으로 나눠 작업별 git worktree에서 병렬로 진행했습니다. 모두 구현·병합되었고, 표는 모듈별 소유 경계로도 읽을 수 있습니다.

| 단계 | 작업 | 소유 파일 | 선행 |
| --- | --- | --- | --- |
| 1 | T1 sim: 여러 사람, 봇 대행, 체크포인트 | `packages/sim/src/world.ts`, `bot.ts`, `checkpoint.ts`, 테스트 | - |
| 0 | T2 meta 추출(계약 작업에서 완료) | `packages/meta/src/{profile,rewards}.ts`, `apps/client/src/meta/**` | - |
| 1 | T3 net 코덱·AOI·메시지 | `packages/net/src/{input,snapshot,aoi,messages,constants}.ts`, 테스트 | - |
| 1 | T4 net 예측·보간 | `packages/net/src/{motion,predictor,interp}.ts`, 테스트 | - |
| 2 | T5 Worker·인증·API·D1·Lobby, 닉네임 규칙 | `apps/server/src/{index,http,auth,db,lobby}.ts`, `packages/meta/src/names.ts`, `apps/server/test/{api,lobby}.test.ts` | - |
| 2 | T6 MatchCore·MatchRoom | `apps/server/src/match/{core,room,rewards}.ts`, `apps/server/test/match.test.ts` | T1, T3 |
| 2 | T7 클라이언트 넷 코어 | `apps/client/src/net/**` | T3, T4 |
| 3 | T8 클라이언트 UI 통합 | `apps/client/src/{game,ui,app,main.tsx}`, `vite.config.ts`, `style.css` | T5, T6, T7 |
| 3 | T9 부하 테스트·개발/배포 스크립트·CI | `apps/server/scripts/**`, `scripts/**`, `.github/workflows/**`, README | T5, T6 |

## 18. 이후 확장

- **로비 샤딩**: 빠른 매치 요청이 초당 수백 건을 넘으면 `lobby:{region}:{shard}`로 나눕니다. 지역 선택(`apac-ne`·`wnam`·`weur`)도 같은 이름 체계로 넣습니다.
- **소셜 로그인**: 카카오·구글·애플 OAuth 콜백을 `/api/auth/*`에 두고 게스트 계정에 연결합니다. 가입 남용이 보이면 게스트 생성에 Turnstile을 붙입니다.
- **스냅샷 델타**: 대역폭이 문제면 클라이언트가 확인한 기준 스냅샷 대비 델타로 줄입니다.
- **리플레이**: 시드와 틱별 명령을 R2에 저장해 분쟁·버그 재현에 씁니다.
- **WebTransport**: DO가 지원하지 않으므로, 필요해지면 Containers나 별도 호스팅으로 옮깁니다.
