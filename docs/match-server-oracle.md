# 매치 서버 이전 설계: Oracle Cloud 서울 (Always Free)

작성 기준: 2026-10. `docs/multiplayer-server-design.md`(이하 "기존 설계")의 Cloudflare 구성에서 **실시간 매치만** Oracle Cloud 서울 리전의 VM으로 옮기는 설계입니다. 계정·상점·로비·D1·정적 사이트는 Cloudflare에 그대로 둡니다.

## 1. 왜 옮기는가

- 2026-10-01 첫 배포 후 실측: 한국 회선에서 Worker 연결이 **SJC(샌프란시스코) 거점**으로 들어가 RTT p50 241 ms가 나왔습니다. 기준(기존 설계 §14)은 p50 40 ms 미만입니다.
- 원인은 코드가 아니라 Cloudflare의 한국 경로 정책입니다. 한국 통신사 접속 비용 때문에 ICN 거점은 사실상 Enterprise 플랜에서만 안정적으로 잡힙니다. Workers Paid, Pro, Business로 올려도 해결이 보장되지 않습니다.
- 서울 리전이 있으면서 계속 무료인 선택지는 **Oracle Cloud Always Free**뿐입니다. Render, Railway, Fly.io, Koyeb, Zeabur에는 서울 리전이 없고, 아시아에서 상시 켜 둘 수 있는 무료 플랜도 없습니다.
- 부수 효과로, Cloudflare 무료 한도를 가장 많이 쓰던 WebSocket 메시지(20개 = DO 요청 1건)가 Cloudflare에서 빠집니다. 그래서 Workers Paid 없이 무료 플랜으로 운영할 수 있습니다.

## 2. 목표와 범위

- 한국 사용자 RTT p50 40 ms 미만, p95 80 ms 미만, 12명 매치의 틱 간격 p99 70 ms 미만(기존 설계 §14와 같은 기준).
- 월 비용 0원. Oracle Always Free 한도 안에서 운영합니다. 도메인은 선택이고 연 1만~2만 원입니다.
- 클라이언트 프로토콜(기존 설계 §10)과 `MatchCore`(`apps/server/src/match/core.ts`)는 바꾸지 않습니다.
- **기존 Durable Object 경로를 대체 수단으로 남깁니다.** 운영 스위치 하나로 매치 백엔드를 `server`(독립 매치 서버)와 `do` 사이에서 바꿀 수 있어야 합니다.

범위 밖:
- 매치 서버 여러 대와 지역 분산. 확장 경로는 §13에 둡니다.
- UDP/WebTransport.
- 계정 시스템 이전.

## 3. 전체 구조

```
브라우저 (https://one-finger-royale.akswnd55.workers.dev)
 ├─ HTTPS  정적 파일, /api/guest·profile·shop ─► Cloudflare Worker ──► D1
 ├─ HTTPS  /api/quickplay ─────────────────────► Worker ─► Lobby DO (매치 ID 배정)
 │                                                 └─ 응답: { matchId, ticket, server: "wss://match.<도메인>" }
 └─ WSS    server + /match/<id>/ws?ticket=… ──► Oracle 서울 VM
                                                 Caddy(TLS, :443) ─► Bun 매치 서버(127.0.0.1:8080)
                                                   ├─ MatchCore × N (packages/match, 그대로)
                                                   ├─ 체크포인트: bun:sqlite (로컬 디스크)
                                                   └─ 매치 종료 ─► POST Worker /api/internal/grant·match (HMAC 서명) ─► D1
```

| 구성 | 위치 | 바뀌는 점 |
| --- | --- | --- |
| 정적 사이트, 게스트, 프로필, 상점, 운영 스위치 | Worker | 없음 |
| 빠른 대전(`/api/quickplay`), Lobby DO | Worker | 백엔드가 `server`이면 매치 ID를 직접 만들고 응답에 `server`를 넣음 |
| 입장 티켓 서명 | Worker | 전용 키 `TICKET_SECRET`으로 분리(§7) |
| 매치 실행 | **Oracle VM** | 새 앱 `apps/match-server`(Bun) |
| 보상 지급, 매치 기록 | Worker → D1 | 매치 서버가 Worker 내부 API를 호출 |
| `MatchRoom` DO | Worker | 대체 경로로 유지 |

## 4. Oracle 인프라

### 4.1 계정과 인스턴스

| 항목 | 값 |
| --- | --- |
| 홈 리전 | **`ap-chuncheon-1`(춘천)**. 이 계정의 홈 리전이고, 홈 리전은 바꿀 수 없습니다. Always Free 컴퓨트는 홈 리전에서만 무료입니다. 춘천과 서울의 RTT 차이는 국내 기준 1~3 ms입니다 |
| 형태 | `VM.Standard.A1.Flex` (Ampere ARM) **2 OCPU / 12 GB**, 인스턴스 `ofa-match-a1`(2026-10-01). 2026-06부터 무료 한도가 4/24에서 2/12로 줄었고, 이 크기가 상시 가동 기준 무료 한도(월 1,500 OCPU시간, 9,000 GB시간)에 딱 맞습니다. 무료 계정일 때는 A1 한도가 0이었고, 종량제 전환 후 250코어로 올라갔습니다. **한도는 유료 기준이라 이보다 크게 만들거나 A1을 한 대 더 만들면 과금됩니다.** 테넌시에 월 1달러 예산(`ofa-free-tier-guard`)과 실제·예상 초과 메일 알림을 걸어 두었습니다 |
| OS | Ubuntu 24.04 (aarch64). Bun은 linux-arm64를 지원합니다 |
| 디스크 | 부트 볼륨 50 GB (무료 블록 스토리지 200 GB 안) |
| 공인 IP | 예약 공인 IP 1개(무료). 인스턴스를 다시 만들어도 DNS를 바꾸지 않아도 됩니다 |
| 송신 | 월 10 TB 무료. 하루 1,000판이어도 월 약 0.6 TB(§11) |

**계정은 종량제(Pay As You Go)로 전환합니다.** 카드를 등록해도 Always Free 한도 안에서는 요금이 0원입니다. 전환하는 이유는 무료 계정의 **유휴 회수 정책** 때문입니다. 7일 동안 CPU p95·네트워크·메모리가 모두 20% 미만이면 무료 계정의 인스턴스를 회수합니다. 출시 초반 사람이 적을 때 해당되기 쉽습니다. 종량제 계정은 회수 대상이 아닙니다.

**요금 사고 방지**: 예산(Budget)을 월 1달러로 만들고 초과 알림을 메일로 받습니다. 인스턴스 형태를 무료 한도 밖으로 바꾸지 않습니다.

### 4.2 네트워크

- VCN 보안 목록(Security List)의 인바운드는 TCP 22(관리용, 가능하면 자기 IP만), 80(ACME 인증서 발급), 443만 엽니다.
- **Oracle Ubuntu 이미지는 OS 안의 iptables가 22번 외에는 막혀 있습니다.** 보안 목록만 열면 접속되지 않으므로 80·443도 iptables에서 열고 `netfilter-persistent save`로 저장합니다. Oracle에서 가장 흔히 막히는 지점입니다.
- Bun 매치 서버는 `127.0.0.1:8080`에만 바인드합니다. 외부에 노출되는 건 Caddy뿐입니다.

### 4.3 도메인과 TLS

페이지가 HTTPS라서 WebSocket도 `wss://`여야 하고, 그래서 인증서가 필요합니다.

| 방법 | 비용 | 비고 |
| --- | --- | --- |
| **자기 도메인의 `match.<도메인>` A 레코드 → 예약 IP** (권장) | 도메인 연 1만~2만 원 | Caddy가 Let's Encrypt 인증서를 자동으로 발급·갱신합니다 |
| `<IP>.sslip.io` 같은 와일드카드 DNS | 0원 | Let's Encrypt가 자주 쓰는 도메인이라 발급 한도에 걸릴 수 있습니다. 스파이크(§12의 0단계)용 |

**도메인 DNS를 Cloudflare에서 관리한다면 `match` 레코드는 반드시 "DNS only"(회색 구름)로 둡니다.** 프록시(주황 구름)로 두면 WebSocket이 다시 Cloudflare SJC를 거쳐 이 이전의 의미가 없어집니다.

### 4.4 서버 구성

```
/opt/ofa-match/
  current -> releases/<git sha>/   # 배포 단위 (번들된 server.js 하나)
  data/match.sqlite                # 체크포인트 (WAL)
/etc/ofa-match.env                 # TICKET_SECRET, INTERNAL_SECRET, WORKER_ORIGIN, ALLOWED_ORIGINS (root:ofa 0640)
/etc/caddy/Caddyfile
/etc/systemd/system/ofa-match.service
```

- **Caddy 설치**: Caddy 공식 apt 저장소(cloudsmith)는 2026-10-01 기준 서명 키가 만료되어 설치가 실패합니다. Ubuntu 기본 저장소의 `caddy` 패키지(2.6.2)를 씁니다.
- **Caddyfile**: `match.<도메인> { reverse_proxy 127.0.0.1:8080 }`. WebSocket 업그레이드는 Caddy가 자동으로 넘깁니다.
- **systemd**:
  - `User=ofa`(전용 계정), `Restart=always`, `EnvironmentFile=/etc/ofa-match.env`.
  - `ExecStart=/usr/local/bin/bun /opt/ofa-match/current/server.js`.
  - `KillSignal=SIGTERM`, `TimeoutStopSec=10`. 재시작 처리 절차는 §6.4에 있습니다.
- **보안 기본값**:
  - SSH는 키 인증만 허용하고 비밀번호 로그인은 끕니다.
  - `unattended-upgrades`로 보안 패치를 자동 적용합니다.
  - Bun 버전은 저장소의 CI 버전(`1.3.12`)과 같게 고정합니다.
- **로그**: 매치 서버는 기존과 같은 구조화 JSON(`match_end` 등)을 stdout에 씁니다. journald에서 `journalctl -u ofa-match -o cat | jq`로 조회합니다.

### 4.5 0단계 측정 결과 (2026-10-01)

| 항목 | 값 |
| --- | --- |
| 인스턴스 | `ofa-match-spike`, E2.1.Micro, Ubuntu 24.04, 컴파트먼트 `ofa-match`, 공인 IP 138.2.124.85 |
| 구성 | Caddy(`138.2.124.85.sslip.io`, Let's Encrypt) → Bun 핑 서버 |
| 집 유선(KT 계열 추정) → 춘천 | TCP 연결 9 ms, WebSocket RTT p50 4.1 / p95 4.7 / p99 10.5 ms |
| 같은 회선 → Cloudflare Worker | SJC 거점, TCP 연결 140 ms, WebSocket RTT p50 241 ms |
| SKT LTE → 춘천 | WebSocket RTT p50 42.0 / p95 51.0 ms |
| SKT LTE → Cloudflare Worker | NRT(도쿄) 거점, HTTP p50 84.5 / p95 95.4 ms (Worker 실행 포함이라 WebSocket과 직접 비교는 안 됨) |

- LTE는 무선 구간에서만 25~35 ms가 걸려서 p50 40 ms 기준은 사실상 하한선입니다. 그래서 기준을 회선별로 나눕니다: **유선·5G p50 40 ms 미만, LTE p50 50 ms 미만, 모두 p95 80 ms 미만**. SKT LTE는 통과입니다.
- Cloudflare의 한국 경로는 통신사마다 다릅니다(집 유선은 SJC, SKT는 NRT).
- KT·LGU+·5G 측정은 남아 있습니다. 측정 페이지가 있던 스파이크 VM은 정리했으므로, 이제는 `https://one-finger-royale.akswnd55.workers.dev/?net=1`에서 온라인 매치를 시작해 화면의 네트워크 표시(RTT)를 읽습니다.

## 5. 코드 구조 변경

### 5.1 새 패키지 `packages/match`

Worker(대체 경로 DO)와 매치 서버가 같은 코드를 쓰도록, 런타임에 의존하지 않는 부분을 패키지로 옮깁니다.

| 옮길 파일 (`apps/server/src/match/` → `packages/match/src/`) | 이유 |
| --- | --- |
| `core.ts`, `core.spec.ts` | `MatchHost` 뒤의 순수 상태 기계. Cloudflare API를 쓰지 않습니다 |
| `types.ts` | 타이밍 상수, `Seat`·`MatchMeta`·`MatchHost` 계약 |
| (신규) `loop.ts` | `room.ts`의 드리프트 보정 틱 루프(`sync`/`onTimer`, `MAX_CATCHUP_TICKS`)를 떼어 낸 것 |
| (신규) `budget.ts` | `room.ts`의 연결별 메시지 예산(초당 40개, 순간 100개, `Close.Flood`) |
| `auth.ts`의 `verifyTicket`과 서명 유틸 | 매치 서버도 티켓을 검증해야 합니다. Web Crypto라 Bun에서도 그대로 동작합니다 |

`apps/server/src/match/room.ts`는 `loop.ts`·`budget.ts`를 가져다 쓰는 얇은 DO 껍데기가 됩니다. `rewards.ts`(D1)는 Worker에 남습니다.

### 5.2 새 앱 `apps/match-server` (Bun)

```
apps/match-server/src/
  main.ts       Bun.serve: GET /health, GET /match/:id/ws (업그레이드), SIGTERM 처리
  rooms.ts      matchId → Room 레지스트리. 첫 접속 때 만들고, destroy()하면 지움
  room.ts       Room = MatchCore + MatchHost 구현 + loop + budget
  store.ts      bun:sqlite 체크포인트 저장소
  worker.ts     Worker 내부 API 클라이언트 (보상·기록, HMAC 서명, 재시도는 core가 함)
  config.ts     환경변수 검증 (없으면 시작하지 않음)
```

`MatchHost` 구현 (`apps/server/src/match/room.ts`의 DO 구현과 일대일 대응):

| `MatchHost` | DO 구현 (지금) | Bun 구현 |
| --- | --- | --- |
| `now()` | `Date.now()` | 같음 |
| `send(conn, data)` | 하이버네이션 소켓 `send` | `ServerWebSocket.send`. 송신 버퍼가 1 MB를 넘으면(`getBufferedAmount`) 그 연결의 스냅샷을 건너뜁니다 |
| `close(conn, code, reason)` | `ws.close` | 같음 |
| `save(meta, checkpoint)` | `storage.put(…, { allowUnconfirmed })` | 메모리에 둔 뒤 SQLite에 동기 기록(`INSERT OR REPLACE`). 40틱(2초)마다 약 100 KB이고, WAL 모드라 1 ms 안팎입니다 |
| `setAlarm(at)` | DO 알람 | 방마다 `setTimeout` 1개. 프로세스가 재시작해도 meta의 상태로 다시 계산합니다(§6.4) |
| `grant(g)` | `grantReward(env.DB, …)` | `POST {WORKER_ORIGIN}/api/internal/grant` |
| `recordMatch(s)` | `recordMatch(env.DB, …)` | `POST {WORKER_ORIGIN}/api/internal/match` |
| `destroy()` | 소켓 닫기 + `deleteAll` | 소켓 닫기, SQLite 행 삭제, 레지스트리에서 제거 |
| `log(fields)` | `console.log(JSON)` | 같음 |
| `random32()` | Web Crypto | 같음 |

DO에만 있던 것은 다음처럼 바꿉니다.
- `ctx.abort`로 하던 틱 크래시 복구: 그 방만 메모리에서 버리고 SQLite 체크포인트로 새 `MatchCore`를 만듭니다. `crashes`와 `MAX_TICK_CRASHES` 규칙은 그대로 둡니다.
- `match_colo` 로그: 고정 위치라 필요 없어 뺍니다.

## 6. 매치 서버 동작

### 6.1 연결 (`GET /match/:id/ws?ticket=…&v=…&h=…`)

Worker의 `matchWs`(`apps/server/src/index.ts`)가 하던 검사를 매치 서버가 직접 합니다. 순서도 같습니다.

1. `Upgrade: websocket`이 아니면 426.
2. `id`가 `MATCH_ID_PATTERN`(64 hex)에 맞지 않으면 404.
3. `Origin`이 `ALLOWED_ORIGINS`에 없으면 403. 운영값은 `https://one-finger-royale.akswnd55.workers.dev`입니다.
4. `v`가 `PROTOCOL_VERSION`과, `h`가 `DATA_HASH`와 다르면 409. 매치 서버와 Worker를 같은 커밋으로 배포해야 하는 이유입니다(§10).
5. `verifyTicket(TICKET_SECRET, …)`이 실패하거나 `mid !== id`이면 401.
6. IP당 동시 연결이 8개를 넘으면 429. 통신사 공유 IP를 고려해 넉넉히 잡습니다.
7. 업그레이드한 뒤 `core.join(conn, { uid, name, runes, iat })`. 이후 거절(가득 참, 이미 시작함 등)은 기존 종료 코드로 닫습니다.

방은 첫 유효 접속 때 만듭니다. Lobby가 만든 ID에 Worker가 서명한 티켓이 있어야만 방이 생기므로, 아무 ID로 방을 만들 수는 없습니다.

### 6.2 메시지

- 바이너리 입력과 JSON 제어 메시지는 `core.message`로 넘깁니다. 그 앞에서 `budget.ts`(§5.1) 검사를 합니다.
- 핑: DO에서는 런타임이 `"ping"`에 `"pong"`으로 자동 응답했습니다. Bun에서는 핸들러 첫 줄에서 `"ping"`이면 바로 `"pong"`을 보냅니다. 예산에는 넣지 않습니다.
- `Bun.serve`의 `maxPayloadLength`는 4 KB로 둡니다. 입력 프레임은 12바이트, 제어 메시지는 512바이트 이하입니다.

### 6.3 틱 루프

- 방마다 `loop.ts`의 `setTimeout` 드리프트 보정 루프를 돌립니다. DO와 같은 코드입니다.
- 한 프로세스, 한 이벤트 루프에서 모든 방이 돕니다. 기존 벤치마크로는 매치 한 판 전체를 빨리 감는 데 100~160 ms가 걸리므로, 한 틱은 수십 µs 수준입니다. 코어 1개로 방 수십 개를 감당할 수 있다고 보지만, **§12의 4단계 부하 테스트로 확인**합니다.
- 기준: 방 20개(사람 240명)에서 틱 간격 p99 70 ms 미만.
- 2 OCPU 중 두 번째 코어는 Caddy와 OS가 씁니다. 프로세스를 여러 개로 나누는 건 §13으로 미룹니다.

### 6.4 재시작과 복구 (배포, 크래시, VM 재부팅)

DO의 "배포하면 소켓이 끊기고 체크포인트에서 이어짐"(기존 설계 §5.7)과 같은 동작을 만듭니다.

1. **SIGTERM을 받으면**:
   - 새 연결을 받지 않습니다.
   - 진행 중인 방마다 즉시 체크포인트를 SQLite에 씁니다.
   - 모든 소켓을 **1012(Service Restart)**로 닫고 종료합니다.
   - 1012는 4xxx가 아니므로 클라이언트(`connection.ts`)가 500 ms, 1 s, 2 s … 간격으로 30초 동안 재접속을 시도합니다.
2. **시작할 때**:
   - SQLite의 모든 방을 읽어 `new MatchCore(host, id, { meta, checkpoint })`로 되살립니다.
   - `running`인 방은 체크포인트에서 이어지고, 알람 시각은 meta에서 다시 계산합니다.
   - 아무도 돌아오지 않는 좌석은 기존 규칙대로 봇이 대신합니다(`DISCONNECT_GRACE_MS`, `ABANDON_MS`).
3. **재접속**: 같은 티켓(유효 15분)으로 들어옵니다. `JOIN_TICKET_MAX_AGE_MS`(30초) 제한은 새 좌석에만 적용되므로 기존 좌석 복귀는 막히지 않습니다.
4. **크래시(SIGKILL, 정전)**: 마지막 체크포인트(최대 2초 전)부터 이어집니다. systemd가 즉시 다시 띄웁니다.

재시작 동안 끊기는 시간은 프로세스 기동 시간(1초 미만)에 재접속 대기 0.5~1초를 더한 정도입니다.

### 6.5 정리

- `ended`된 방은 `CLEANUP_AFTER_END_MS` 뒤에, 빈 방은 `EMPTY_ROOM_TTL_MS` 뒤에 `destroy()`합니다. 메모리와 SQLite에서 지웁니다(기존 core 규칙 그대로).
- 시작할 때 `createdAt`이 `MAX_MATCH_SECONDS`의 2배보다 오래된 행은 버립니다. 고아 행이 쌓이지 않게 하기 위해서입니다.

## 7. 보안: 비밀 키 분리

| 키 | 보관 위치 | 용도 |
| --- | --- | --- |
| `AUTH_SECRET` (기존) | Worker만 | 게스트 토큰 서명. **VM에 두지 않습니다** |
| `TICKET_SECRET` (신규) | Worker, VM | 입장 티켓 서명·검증 |
| `INTERNAL_SECRET` (신규) | Worker, VM | 매치 서버 → Worker 내부 API 서명 |

- 지금은 한 키(`AUTH_SECRET`)로 게스트 토큰과 티켓을 모두 서명합니다. 이 키를 VM에 두면, VM이 뚫렸을 때 공격자가 **아무 계정의 게스트 토큰이나 만들 수 있습니다**(계정 탈취). 그래서 티켓 키를 분리합니다.
- `TICKET_SECRET`이 유출돼도 피해는 "아무 매치에 아무 이름으로 들어가기"에 그칩니다. 매치 ID가 64 hex라 추측할 수 없으므로 실제 피해는 더 작습니다.
- 내부 API 요청은 헤더 `X-OFA-Sig: <ts>.<base64url(HMAC-SHA256(INTERNAL_SECRET, ts + "." + body))>`로 서명합니다.
  - Worker는 `|now - ts| ≤ 5분`과 서명을 확인합니다.
  - 재전송은 기존 멱등성(`match_results`의 `(match_id, player_id)` 기본 키)이 막습니다.
- `TICKET_SECRET`으로 바꾸는 시점에 발급되어 있던 티켓(최대 15분)은 무효가 됩니다. 이 전환은 백엔드를 바꾸기 전에 배포합니다(§12의 2단계).
- 운영자 키(SSH 개인키, 위 비밀 값들)는 비밀번호 관리자에 보관합니다. 저장소에는 `apps/match-server/.env.example`만 둡니다.

## 8. Worker 변경

1. **`TICKET_SECRET` 도입**:
   - `signToken`/`verifyTicket`이 티켓에는 `TICKET_SECRET`을 씁니다.
   - `wrangler.jsonc`의 `secrets.required`에 추가합니다.
   - DO 경로의 `matchWs`도 같은 키로 검증합니다.
2. **백엔드 스위치**:
   - `settings` 테이블에 `match_backend` 행(`do` | `server`)을 둡니다. 값 이름은 공급자가 바뀌어도 그대로 쓰도록 `server`로 했습니다. `settings.ts`의 캐시(10초)를 함께 씁니다.
   - `bun run multiplayer -- backend server|do`를 추가합니다.
   - 매치 서버 주소는 `wrangler.jsonc`의 변수 `MATCH_SERVER_ORIGIN`(예: `wss://match.<도메인>`)입니다. 비어 있으면 `server`여도 `do`로 동작합니다.
3. **`/api/quickplay`**:
   - `server`이면 Lobby에 `assign(uid, 'server')`를 요청합니다. Lobby는 매치 ID를 `env.MATCH.newUniqueId()` 대신 무작위 32바이트 hex로 만듭니다(`MATCH_ID_PATTERN` 그대로).
   - 응답에 `server: MATCH_SERVER_ORIGIN`을 넣습니다.
   - 열려 있는 방의 백엔드가 지금 스위치와 다르면 그 방은 닫고 새 방을 엽니다. 백엔드 정보는 Lobby의 `OpenMatch`에 둡니다.
4. **내부 API**(`/api/internal/grant`, `/api/internal/match`):
   - `INTERNAL_SECRET` 서명을 검증한 뒤 기존 `grantReward`·`recordMatch`를 호출합니다.
   - CORS 헤더를 붙이지 않고, 브라우저 Origin이 있으면 거절합니다.
   - 응답은 `RewardOutcome` JSON입니다.
5. **`/api/health`**: 응답에 `matchBackend`를 추가합니다(진단용).

## 9. 클라이언트와 프로토콜 변경

- `packages/net`의 `QuickplayResponse`에 `server?: string`을 추가합니다. 없으면 지금처럼 API 출처를 씁니다.
- `ApiClient.wsUrl(matchId, ticket, server?)`:
  - `server`가 있으면 `${server}/match/${id}/ws?…`를 씁니다.
  - 없으면 기존 `/api/match/${id}/ws`를 씁니다.
- `PROTOCOL_VERSION`은 올리지 않습니다. 필드 추가는 하위 호환이고, 옛 클라이언트는 `server`를 무시해서 DO 경로로 가려다 매치 서버의 방을 못 찾습니다. 이 문제는 클라이언트와 Worker를 한 번에 배포해서 피합니다(같은 Worker가 정적 파일도 서비스하므로 원래 함께 배포됩니다). 이미 열려 있던 탭은 다음 새로고침까지 실패할 수 있으니, 전환은 사람이 적은 시간에 합니다.
- 재접속 로직(`connection.ts`), 예측, 보간은 바꾸지 않습니다.
- `apps/server/scripts/loadtest.ts`도 `server` 필드를 따라가게 고칩니다.

## 10. 배포

- **CI**: `.github/workflows/deploy-match.yml`(수동 실행).
  1. 타입체크와 테스트.
  2. `bun build apps/match-server/src/main.ts --target=bun --outfile dist/server.js`. 의존 패키지까지 파일 하나로 묶으므로 VM에 `bun install`이 필요 없습니다.
  3. SSH(저장소 비밀 `MATCH_SSH_KEY`, `MATCH_HOST`)로 `releases/<sha>/`에 업로드하고, `current` 링크를 바꾼 뒤 `systemctl restart ofa-match`.
  4. `/health`가 같은 커밋 sha를 돌려주는지 확인. 실패하면 이전 링크로 되돌립니다.
- **배포 순서**: 프로토콜이나 `DATA_HASH`가 바뀌는 변경은 **매치 서버를 먼저**, 그다음 Worker(클라이언트 포함)를 배포합니다.
  - 매치 서버는 `v`/`h`가 다르면 409를 냅니다. 그래서 둘 사이 수십 초 동안 새 매치 입장이 실패할 수 있습니다.
  - 이 시간을 없애려면 매치 서버가 바로 전 `DATA_HASH`도 받게 할 수 있지만, sim 규칙이 다르면 결과가 어긋나므로 받지 않습니다.
  - 대신 배포 전에 운영 스위치로 `multiplayer off`를 하고, 끝나면 `on`으로 되돌립니다.
- **첫 배포는 로컬에서**: 서버 준비 절차를 `scripts/provision-match.sh`(멱등)로 둡니다. Bun 설치, 사용자 생성, Caddy, systemd, iptables를 처리합니다.

## 11. 비용

| 항목 | 하루 100판 | 하루 1,000판 | 비고 |
| --- | --- | --- | --- |
| Oracle VM (2 OCPU / 12 GB) | 0원 | 0원 | Always Free |
| Oracle 송신 | 월 약 60 GB → 0원 | 월 약 600 GB → 0원 | 10 TB 무료. 실측: 사람 1명당 초당 약 5 KB, 꽉 찬 매치 한 판에 약 20 MB |
| Cloudflare Worker·D1 | 무료 플랜 | 무료 플랜 | 실시간 메시지가 빠져 요청은 API 호출(빠른 대전, 상점, 보상 지급 2건 × 사람 수)뿐입니다 |
| 도메인 | 연 1만~2만 원 | 같음 | 선택 |

Oracle 무료 한도를 넘어서는 것은 동접이 수백 명을 넘어 코어가 부족해질 때입니다. 그때는 종량제 A1 코어를 시간당 약 0.01달러에 추가하는 것이 가장 쌉니다(§13).

## 12. 작업 단계

각 단계는 별도 브랜치와 PR로 진행합니다. 0단계와 1단계의 결과가 기준을 통과해야 다음 단계로 갑니다.

| 단계 | 작업 | 통과 기준 |
| --- | --- | --- |
| 0 | **지연 스파이크**: Oracle 계정·VM 생성, Caddy + 20줄짜리 Bun 핑 서버(`sslip.io`로 TLS). SKT·KT·LGU+ 모바일과 집 와이파이에서 브라우저 RTT 측정 | 통신사별 RTT p50 40 ms 미만. 넘으면 이 설계를 멈추고 다시 검토 |
| 1 | `packages/match` 추출(`core`, `types`, `loop`, `budget`, 티켓 검증). DO는 이 패키지를 쓰도록 바꾸고 동작은 그대로 | 기존 테스트 467개 통과 |
| 2 | Worker: `TICKET_SECRET` 분리, 내부 API, `match_backend` 스위치(기본 `do`), `QuickplayResponse.server`, 클라이언트 `wsUrl` | 새 테스트 통과. 배포 후에도 백엔드는 `do`라 사용자 영향 없음 |
| 3 | `apps/match-server`: 연결 검증, Room/Host, SQLite 체크포인트, SIGTERM 처리, `/health`. 테스트: 티켓·Origin 거절, Flood, 재시작 후 복구, 내부 API 서명 | Bun에서 매치 한 판 완주. 재시작 복구 테스트 통과 |
| 4 | 인프라: 준비 스크립트, 배포 워크플로, 도메인. `loadtest`로 VM에 방 1개(12명)와 방 20개를 걸어 측정 | 틱 간격 p99 70 ms 미만, CPU 여유 확인 |
| 5 | 전환: `bun run multiplayer -- backend server`. 한 주 동안 `match_end` 로그(틱 지터, RTT) 관찰 | 문제가 있으면 `backend do`로 즉시 되돌림(10초 안에 반영) |
| 6 | 정리: README, 기존 설계 문서의 배포·관측 절 갱신. DO 경로는 대체 수단으로 유지 | - |

### 12.1 진행 상황 (2026-10-01)

| 단계 | 상태 | 결과 |
| --- | --- | --- |
| 0 | 완료(집 유선, SKT LTE). KT·LGU+·5G 남음 | 유선 p50 4.1 ms, SKT LTE p50 42.0 / p95 51.0 ms |
| 1~3 | 구현 완료(PR) | 테스트 491개 통과. 로컬 wrangler dev + 매치 서버로 12명 매치, 강제 종료 후 SQLite 복구, `/api/internal/grant` 보상 기록 확인 |
| 4 | 완료(CI 배포 워크플로 제외) | Micro(1/8 OCPU)에서는 12명 방 하나가 코어의 약 8%를 써서 방 1~2개가 한계였고 틱 간격 p99가 95.7 ms까지 올랐습니다. 종량제 전환 후 **A1 2 OCPU / 12 GB(`168.107.48.33.sslip.io`)**로 옮겼습니다. 운영 Worker 경유 24명(방 2개): RTT p50 5.0 / p95 7.6 ms, 틱 간격 p99 53.2 ms, 매치 서버 CPU는 코어 하나의 7.5%(방 하나당 약 3.8%). 한 프로세스(코어 1개)로 방 약 20개를 감당할 것으로 추정합니다. Micro는 삭제했습니다 |
| 5 | 전환함 | 운영 `match_backend = server`. 브라우저로 매치 중 `systemctl restart` → 자동 재접속, 체크포인트에서 재개 확인 |

## 13. 이후 확장

- **코어 2개 사용**: 매치 서버 프로세스를 2개(포트 8080, 8081) 띄우고, Lobby가 `server`를 `wss://match.<도메인>/p0`·`/p1`로 나눠 배정합니다. Caddy가 경로로 분기합니다. 티켓에 `srv` 클레임을 넣어 다른 프로세스로 들어오지 못하게 합니다.
- **VM 추가**: 종량제 A1, 또는 다른 서울 VM(Vultr, Lightsail)을 `match2.<도메인>`으로 둡니다. Lobby가 `/health`의 방 수를 보고 배정합니다.
- **Oracle 용량·정책 변경 대비**: 같은 번들과 준비 스크립트를 쓰면 Vultr·Lightsail 서울 VM(월 5~6달러)으로 옮기는 데 DNS 변경만 필요합니다. 어떤 경우에도 `backend do`가 최후의 대체 수단입니다.

## 14. 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 서울 A1 용량 부족으로 인스턴스를 못 만듦 | 춘천 리전. 둘 다 안 되면 콘솔·CLI로 시간을 두고 재시도. 끝내 안 되면 서울 유료 VM(§13) |
| Oracle이 무료 한도를 또 줄임 | §13 이전 경로와 DO 대체 경로. 현재 부하는 1 OCPU 안에 들어올 것으로 봅니다 |
| VM 단일 장애점 | systemd 자동 재시작, 체크포인트 복구, 외부 가동 감시(UptimeRobot 무료, `/health` 1분 간격, 메일 알림). 길어지면 `backend do` |
| 모바일 통신사 경로가 Oracle에도 나쁨 | 0단계 스파이크에서 먼저 확인 |
| VM 침해 | `AUTH_SECRET`은 VM에 없음(§7). 비밀 회전 절차를 문서화. 최소 포트만 개방, 자동 보안 패치 |
| 매치 서버와 Worker의 버전 어긋남 | 배포 순서(§10), `/health`의 커밋 sha 비교 |
