# 멀티플레이 확장 · 프로덕션 인프라 분석

작성 기준: 2026-09, 브랜치 `claude/multiplayer-expansion-analysis-9upwqb`, 커밋 `bc95450` 시점 코드.
측정치는 이 저장소의 `bun run profile` / `bun run build` 결과이고, 요금·리전 정보는 각 서비스의 2026년 공개 자료를 참고했습니다(문서 끝 링크). 요금은 자주 바뀌므로 계약 전 재확인이 필요합니다.

## 요약

- **컴퓨트는 병목이 아닙니다.** `packages/sim`은 12인 매치 한 판을 CPU 0.3~0.45초로 끝냅니다(시뮬레이션 1초당 1.4~2.2 ms). 코어 하나로 수십~백여 개 룸을 동시에 돌릴 수 있어, 인프라 선택은 **지연(리전)·운영 부담·트래픽 비용**으로 결정됩니다.
- **전체 월드를 그대로 보내면 안 됩니다.** `JSON.stringify(world)`는 85~99 KB이므로 20 Hz로 보내면 클라이언트당 2 MB/s입니다. 서버는 **시야 반경(AOI) 35 유닛 안의 엔티티만 바이너리 델타**로 보내야 하고, 이때 클라이언트당 5~8 KB/s(≈50 kbps)로 떨어집니다. 이 AOI 반경은 미니맵이 이미 쓰는 35 유닛(`Hud.ts:490`)과 같아서 **렌더링 컬링·네트워크 관심 관리·맵핵 방지를 한 상수로 묶을 수 있습니다.**
- **클라이언트 최적화의 핵심은 GPU가 아니라 CPU입니다.** three.js는 화면 밖 메시를 이미 그리지 않지만(프러스텀 컬링), 지금 렌더러는 맵 위 몬스터 최대 106마리 전부에 대해 매 프레임 스켈레탈 애니메이션 믹서를 갱신하고 본 행렬을 계산합니다(`Renderer.ts:527-557`). 뷰를 AOI 안(평균 10~12, p95 ≈ 25마리)만 만들도록 바꾸면 이 비용이 5~8배 줄고, 멀티에서는 어차피 서버가 그 범위만 보내므로 **같은 코드 변경이 두 목적을 동시에 해결**합니다.
- **추천 구성(1순위): 서울 리전 VM 1~2대 + Colyseus(Node/Bun) 위에 `packages/sim` 그대로 실행, 정적 파일은 Cloudflare Pages/CDN, 계정·코인·룬은 Supabase(서울)**. 월 20~50달러로 시작하고, 2 vCPU 한 대가 100룸(≈1,200 동접)을 감당합니다. 국내 유저 RTT 10~30 ms를 확실히 확보하고, WebTransport 등 런타임 제어권을 유지합니다.
- **2순위: Cloudflare Workers + Durable Objects 풀스택**. 서버 관리가 전혀 없고 트래픽 요금이 0이며 매치당 약 0.001달러라 가장 쌉니다. 단 배치가 "best effort"라 서울 보장이 없고, 한국 ISP 라우팅 특성과 틱 루프 지터를 **먼저 실측**해야 합니다. 검증을 통과하면 1순위와 바꿔도 됩니다.
- GameLift·PlayFab·Agones·Edgegap 같은 전용 게임 서버 오케스트레이션은 지금 규모에서는 과합니다(고정비 70~100달러/월 이상, JS 서버 SDK 공백, k8s 운영). 다만 서버를 **컨테이너로 만들어 두면** 나중에 그대로 옮길 수 있으므로, 멀티 리전이 필요해지는 시점의 선택지로 남깁니다.

## 1. 현재 코드가 정하는 제약

### 1.1 구조상 이미 갖춰진 것

| 항목 | 근거 | 멀티에서의 의미 |
| --- | --- | --- |
| 결정론적 시뮬레이션 | `step(world, commands)`는 시드·입력이 같으면 결과가 같음(`sim.spec.ts:121`). RNG는 mulberry32, 상태가 uint32 하나(`rng.ts:1`). `Math.random`/`Date` 사용 없음 | 서버가 권위적으로 돌리기에 바로 적합. 리플레이(시드 + 틱별 명령)로 버그·치팅 재현 가능 |
| 봇도 사람과 같은 `Command` | `world.ts:326`: `f.bot ? botCommands() : commands.get(f.id)` | 빈 자리는 봇으로 채워 매치를 15초 안에 시작 가능. 접속이 끊긴 사람에게 `f.bot`을 채워 넣으면 즉시 봇이 대신 조작 |
| World는 순수 데이터 | `types.ts:178` — 배열과 숫자뿐. 유닛 인덱스는 `WeakMap` 캐시로 스냅샷에서 제외(`combat.ts:29`) | 체크포인트 = `JSON.stringify(world)` + `rng.state`. 복원은 `Object.assign(new Rng(0), {state})` 후 `reindex()` |
| 명령 6종만 존재 | `types.ts:23` — move/attack/dash/draft/reroll/exchange. 쿨다운은 sim이 검사(`startDash`, `attackCd`) | 클라이언트가 보낼 수 있는 것이 방향·버튼뿐이라 입력 검증이 거의 공짜. 스킬은 자동 시전이라 입력 대역폭도 작음 |
| 고정 틱 20 Hz + 렌더 보간 | `Game.ts:278-298`의 `prev` 맵 + `alpha` | 서버 스냅샷 2개 사이 보간으로 그대로 이어짐 |
| 튜토리얼은 sandbox | `WorldOptions.sandbox` | 서버 없이 로컬에서 계속 실행. 멀티 서버 장애와 무관 |

### 1.2 지금은 없거나, 멀티에서 바뀌어야 하는 것

- `createWorld`는 사람을 한 명(`playerName`)만 받습니다(`world.ts:61-102`). `humans: {name, runes}[]`를 받도록 확장해야 합니다.
- 코인·점수·룬 장착이 클라이언트 `localStorage`에 있고 보상도 클라이언트가 계산합니다(`Game.ts:190-224`, `meta/profile.ts`). 멀티에서는 서버가 `scoreMatch`를 계산해 DB에 적고, 룬 로드아웃도 DB에서 읽어야 합니다. `meta/rewards.ts`는 DOM 의존이 없는 순수 함수라 공용 패키지로 옮기면 그대로 서버에서 씁니다.
- 서버 코드, Dockerfile, CI(`.github/`)가 없습니다. 프로덕션 배포 파이프라인을 새로 만들어야 합니다.
- 사용하는 수학 함수는 `sin/cos/atan2/hypot/log/sqrt`입니다. 브라우저 엔진(V8·JavaScriptCore) 사이에 마지막 비트가 다를 수 있어 **클라이언트끼리의 락스텝 동기화에는 부적합**합니다. 서버 권위 모델에서는 서버 한 곳만 결정론이면 되므로 문제가 없습니다.

### 1.3 측정치

`bun run profile -- 3 12 11` (Bun 1.3.11, Xeon 2.1 GHz 컨테이너, 12인 전원 봇 매치 3판):

| 지표 | 값 |
| --- | --- |
| 틱 CPU 시간 | 평균 0.08 ms, p99 ≈ 1 ms, 최대 5~11 ms(JIT 워밍업·GC) |
| 매치당 CPU | 0.36~0.44 s (매치 길이 205~253 s) |
| 시뮬레이션 1초당 CPU | 1.4~2.2 ms |
| 몬스터 수 | 최대 106 (링 상한 55+35+16, `monsters.ts:36`), 180초 이후 감소 |
| 투사체 | 최대 4~10 |
| 틱당 이벤트 | 0.5~0.9개 |
| `JSON.stringify(world)` | 시작 85 KB, 최고 99 KB, 후반 36~76 KB |
| 시야 반경 25 안의 유닛 수 | 평균 5~6, p95 10~13 |
| 시야 반경 35 안의 유닛 수 | 평균 9~12, p95 16~25 |

`bun run build` (Vite 8, three 0.184):

| 파일 | 크기 (gzip) |
| --- | --- |
| 메뉴 진입 번들 `index-*.js` | 79.6 KB (30.4 KB) |
| 게임 청크 `Game-*.js` (three.js 포함) | 641.8 KB (169.1 KB) |
| GLTFLoader + meshopt 디코더 | 43.8 + 26.5 KB (13 + 7.3 KB) |
| 모델 `.glb` 10개 | 2.8 MB (캐릭터 8개 각 300~407 KB, 소품 134 KB) |
| dist 전체 | 3.5 MB |

테스트 168개 통과, `typecheck` 통과.

### 1.4 측정치에서 나오는 결론

1. **룸당 서버 비용이 매우 작습니다.** 시뮬레이션 2 ms/s에 인코딩·전송(클라이언트 12명 × 20 Hz × 25개 엔티티)을 더해도 룸당 5~6 ms/s입니다. 이론상 코어당 150룸 이상이고, GC 정지를 공유하는 것을 감안해 **프로세스당 40~60룸, vCPU당 프로세스 1개**로 잡으면 2 vCPU 서버가 100룸(1,200명)입니다. 룸당 메모리는 1~2 MB입니다.
2. **대역폭이 CPU보다 먼저 비용이 됩니다.** 아래 3.3의 추정으로 매치당 서버 송신 25~30 MB, 하루 1,000판이면 월 0.9 TB입니다. 트래픽 요금이 있는 클라우드(AWS 서울 GB당 약 0.126달러)는 월 100달러가 넘고, 트래픽이 포함·무료인 곳(Cloudflare, Vultr·Lightsail 포함량, Gameye)은 0입니다.
3. **지연이 체감을 결정합니다.** 대시 무적 0.18초, 콤보 창 1.1초, 20 Hz 틱인 액션 게임이라 RTT 40 ms(서울)와 80~100 ms(도쿄·싱가포르 경유)는 손맛이 다릅니다. 한국 우선 출시라면 서울 리전이 1순위 조건입니다.
4. **전체 스냅샷은 불가, AOI는 충분히 작습니다.** p95 25개 엔티티 × 12 B면 300 B입니다.

## 2. 인게임(클라이언트) 최적화

### 2.1 "보이지 않는 부분은 렌더링하지 않기"의 실제 의미

three.js는 `Mesh.frustumCulled`(기본 true)로 카메라 밖 메시의 **드로우콜을 이미 생략**합니다. 그래서 지금 남아 있는 비용은 GPU가 아니라 CPU 쪽입니다.

| 프레임마다 전 몬스터(최대 106)에 대해 하는 일 | 위치 |
| --- | --- |
| 스킨드 메시 복제 + 머티리얼 복제 + `AnimationMixer` 생성(첫 등장 시) | `Renderer.ts:404-421`, `AssetLibrary.ts:165-192` |
| `model.update(dt)` → 믹서가 모든 트랙(본 20~30개 × 위치·회전)을 샘플링 | `Renderer.ts:554`, `ModelInstance.ts:97-112` |
| 방향 easing(`Math.exp`), 상태 글로우(이미시브 색 쓰기), 체력바 빌보드 쿼터니언 복사 | `Renderer.ts:531-556` |
| 씬 그래프 `updateMatrixWorld` — 본까지 포함해 리그당 30~60 노드 | three.js 내부, `visible=false`여도 수행 |
| 그림자 패스 캐스터 순회(모든 유닛·소품이 `castShadow`) | `Renderer.ts:352-356`, `lighting.ts` |

즉 "안 보이면 안 그리기"는 **뷰(three.js 객체)의 생명주기를 시야 기준으로 관리**하는 일입니다.

### 2.2 우선순위별 작업

효과가 큰 순서입니다. 1~3번이 체감의 대부분입니다.

1. **뷰 생명주기를 AOI 반경으로 제한** (효과 큼 · 난이도 중)
   - 포커스(플레이어/관전 대상) 기준 거리로 세 단계를 둡니다: 생성 반경 R₁ ≈ 35(화면 대각선 반 + 여유), 숨김 반경 R₂ ≈ 42(히스테리시스), 폐기 반경 R₃ ≈ 60 또는 일정 시간 미표시.
   - 숨길 때 `root.visible = false`와 `root.matrixWorldAutoUpdate = false`를 함께 설정해야 행렬 갱신까지 건너뜁니다. `visible`만 끄면 `updateMatrixWorld`는 여전히 내려갑니다.
   - 숨긴 뷰는 `model.update(dt)`도 호출하지 않습니다. 다시 보이면 믹서 시간을 서버 시각에 맞춰 점프시키면 됩니다(루프 클립이라 어긋남이 눈에 띄지 않음).
   - 기대 효과: 믹서·본 갱신 106 → 10~25(측정치). 프레임당 CPU에서 가장 큰 항목이 5~8배 감소. 씬 노드 수도 그만큼 줄어 three.js 내부 순회 비용이 같이 내려갑니다.
   - 멀티에서는 서버가 AOI 밖 엔티티를 보내지 않으므로 **등장/퇴장 처리가 어차피 필수**입니다. 죽음 연출(`bury`)은 서버의 `death` 이벤트로 트리거되게 유지합니다.

2. **애니메이션 LOD** (효과 중 · 난이도 낮음)
   - 보이는 유닛 중 포커스에서 20유닛 이상 떨어진 것은 믹서를 2~4프레임마다 한 번(누적 dt로) 갱신합니다. 고정 쿼터뷰라 거리별 크기 차이가 작지만, 가장자리 유닛의 15~20 fps 애니메이션은 체감되지 않습니다.
   - 티어1 미니언(최대 55)은 같은 클립 시각을 공유하는 "군중 모드"도 가능합니다.

3. **지형 셰이더 베이크** (효과 큼(모바일) · 난이도 낮음)
   - `terrain.ts:46-75`는 픽셀마다 fbm 4옥타브 ×4 + 노이즈 ×4 ≈ 노이즈 20회, 즉 `sin` 약 80회를 계산합니다. 2× DPR 폰(2400×1080 ≈ 2.6 M픽셀)에서 프레임당 수 ms입니다.
   - 시작 시 한 번 2048² 렌더타깃에 색을 구워 `map`으로 쓰고, 셰이더에는 미세 그레인 노이즈 1회만 남깁니다. 결과는 동일하고 비용은 텍스처 샘플 1회가 됩니다.

4. **그림자 품질 옵션** (효과 중 · 난이도 낮음)
   - `PCFSoftShadowMap` → `PCFShadowMap`(모바일 기본), 티어1 몬스터 `castShadow` 끄기, 저사양에서는 유닛 그림자를 원형 블롭 인스턴스 하나로 대체. `settings.ts`에 그래픽 프리셋(높음/보통/낮음)을 추가하면 됩니다.
   - 그림자 박스가 포커스 주변 80×80으로 이미 제한돼 있어(`lighting.ts:10`) 캐스터 수는 대략 보이는 유닛 수입니다. 1번을 하면 이 비용도 같이 줄어듭니다.

5. **프레임 내 할당 제거** (효과 소~중 · 난이도 낮음)
   - `toThree()`는 호출마다 `new THREE.Vector3`, `lerpPos()`는 엔티티마다 새 객체를 만듭니다(`Renderer.ts:24, 490-493`). 60 fps에 수백 개 할당이라 모바일 GC 정지의 원인입니다. 스크래치 벡터로 `position.set(x, y, -z)`를 쓰면 됩니다.
   - `groundRing()`은 공격 이벤트마다 지오메트리·머티리얼을 새로 만들고 0.16초 뒤 폐기합니다(`Renderer.ts:720-727`). 12명이 계속 싸우면 초당 10~15개 GPU 버퍼 생성·삭제입니다. 링 지오메트리 몇 개를 풀에 두고 스케일·회전으로 재사용합니다.
   - `fireballFx`도 매 프레임 `Vector3` 4개를 만듭니다(`Renderer.ts:682-697`).

6. **해상도 상한과 동적 해상도** (효과 중(고DPR 폰) · 난이도 낮음)
   - `setPixelRatio(min(dpr, 2))` + MSAA(`Renderer.ts:170-171`). 모바일 기본 상한을 1.5로 낮추고, 프레임 시간이 20 ms를 넘으면 1.25까지 내리는 적응형 스케일을 넣습니다.

7. **머티리얼 복제·체력바** (효과 소 · 1번 이후에는 무시 가능)
   - `glow: true`가 인스턴스마다 머티리얼을 복제하고(`AssetLibrary.ts:175-190`) 체력바가 유닛당 메시 3개(`Renderer.ts:325-349`)지만, 뷰가 25개 이하로 제한되면 무시할 수준입니다. 나중에 스킨드 인스턴싱(three.js 코어의 `InstancedMesh`는 스키닝을 지원하지 않아 커뮤니티 확장이나 버텍스 애니메이션 텍스처가 필요)까지 갈 필요는 당장 없습니다.

8. **HUD** — 텍스트 diff, 미니맵 5 Hz(`Hud.ts:444-448`)로 이미 절제돼 있어 손댈 곳이 거의 없습니다.

### 2.3 로딩·배포 관련(프로덕션 체감에 직접 영향)

- `build-characters.ts`는 `textureCompress`를 쓰지 않아 텍스처가 PNG로 남습니다(매니페스트 주석의 `--texture-compress webp`와 다름). `@gltf-transform/functions`의 `textureCompress({ targetFormat: 'webp' })`를 추가하면 캐릭터 8개(2.6 MB)가 대략 절반으로 줄 것으로 예상됩니다. 각 파일이 같은 팩 아틀라스를 따로 품고 있으므로 텍스처를 외부 파일로 공유하는 것도 방법입니다.
- `public/models/*.glb`는 해시 없는 고정 경로라 캐시 무효화 수단이 없습니다. 파일명에 버전을 넣거나 `Cache-Control: immutable` + 배포마다 경로 변경(Cloudflare Pages `_headers`)을 씁니다.
- 게임 청크 642 KB(gzip 169 KB)는 three.js 몫입니다. Brotli가 되는 CDN이면 실제 전송은 140 KB대입니다. 추가 분할보다 모델 최적화가 효과가 큽니다.

## 3. 넷코드 아키텍처 (인프라 선택의 전제)

### 3.1 모델: 서버 권위 + 스냅샷 보간 + 로컬 이동 예측

- 서버가 룸마다 `World`를 20 Hz로 `step` 합니다. 클라이언트는 `Command`만 보냅니다.
- 원격 엔티티는 100 ms(스냅샷 2개) 버퍼로 보간합니다. 지금 `Game.ts`의 `prev`/`alpha` 보간과 같은 구조입니다.
- 내 캐릭터의 **이동·대시만** 로컬 예측합니다. `moveWithCollision`·`updateDash`는 정적 장애물과 내 스탯만 쓰고 RNG를 쓰지 않으므로 클라이언트에서 같은 함수를 돌릴 수 있습니다. 입력에 시퀀스 번호를 붙여 서버 위치와 조정(reconcile)하고, 오차가 0.05유닛을 넘으면 스냅합니다.
- 공격은 스윙 애니메이션·효과음만 즉시 재생하고 피해 숫자는 서버 `hit` 이벤트를 기다립니다(RTT 30~80 ms는 체감 범위 안).
- 락스텝(모든 클라이언트가 전체 월드를 시뮬레이션)은 채택하지 않습니다. 1.2의 엔진 간 부동소수 차이, 12명 입력 대기로 인한 정지, 전체 상태가 클라이언트에 있어 맵핵이 가능해지는 문제 때문입니다.

### 3.2 룸 루프

```
매 틱(50 ms):
  commands = 클라이언트별 큐에서 꺼내기 (틱당 최대 4개로 제한)
  step(world, commands)                       // packages/sim 그대로
  클라이언트마다:
    me = 내 Fighter
    visible = AOI(me.pos, 35) 안의 fighters·monsters·projectiles·pickups
    private = me의 offer/rerolls/items/xp/쿨다운 (바뀐 틱에만)
    events = 위치가 AOI 안인 attack/hit/explode/skill/dash
           + fighter death 전부(킬피드) + 자기 levelUp/synergy/pickup + phase/zone/end
    send(encode(tick, zone, visible 델타, private, events))
  world.over → scoreMatch → DB 기록 → 결과 전송 → 룸 폐기
```

### 3.3 와이어 포맷과 대역폭 추정

| 항목 | 값 |
| --- | --- |
| 엔티티 레코드 | id u16, x·y i16(1/64 유닛, ±120 맵에 충분), facing u8, hp u8(%), flags u8(alive·dash·run·burn·bleed), 상태 u8 ≈ 10 B, 여유 두어 12 B |
| 틱당 페이로드 | 헤더 8 B + 엔티티 평균 12개·p95 25개 × 12 B + 이벤트 ~0.7개 × 12 B ≈ 평균 170 B, p95 330 B |
| 프레이밍 | WebSocket 2~4 B + TCP/IP 약 40 B (20 Hz라 패킷 합치기가 안 됨) |
| 클라이언트당 하향 | 20 Hz: 5~8 KB/s (40~64 kbps). 10 Hz 스냅샷이면 절반 |
| 클라이언트당 상향 | 이동은 변할 때만 전송(지금도 제스처 변화 시에만 `Command`가 생김) → 1 KB/s 미만 |
| 룸당 | 12명 × 6.5 KB/s ≈ 80 KB/s ≈ 0.6 Mbps |
| 매치당 서버 송신 | 330초 × 80 KB/s ≈ 25~30 MB |
| 하루 1,000판 | ≈ 30 GB/일, ≈ 0.9 TB/월 |

인코딩은 직접 `DataView`로 하거나 Colyseus의 `@colyseus/schema`(델타 인코딩 + 0.16의 `StateView`로 클라이언트별 가시성)를 씁니다. 후자는 관심 관리·재접속 동기화 코드를 대부분 대신 써 줍니다.

### 3.4 코드 변경 지점

`packages/sim`
- `createWorld({ seed, fighters, humans: {name, runes}[] })` — 사람 여러 명 스폰, 나머지는 봇.
- `checkpoint(world)` / `restore(json)` — 체크포인트·재접속·서버 재시작 복구용. `Rng` 재수화와 `reindex` 포함.
- `meta/rewards.ts` → `packages/sim`(또는 `packages/meta`)로 이동. 서버가 보상 계산.
- 리플레이 기록: 시드 + 틱별 명령. 12명 × 20 Hz × 330초라도 1 MB 미만.

`packages/net`(신규, DOM·three 의존 없음)
- 스냅샷 타입·인코더·디코더·AOI 필터, 단위 테스트. 서버·클라이언트 공용.

`apps/server`(신규)
- Colyseus `LobbyRoom`(빠른 매치: 12명 모이거나 15초 경과 시 시작, 빈자리 봇) + `MatchRoom`(3.2 루프).
- Node 22 LTS + `@colyseus/uwebsockets-transport`가 가장 검증된 조합입니다. Bun 런타임용 트랜스포트도 있으니 저장소의 Bun 도구 체인과 맞추고 싶으면 그쪽으로 시작해도 됩니다.
- 서버 런타임을 Node(V8)로 하면 Chrome·Android 클라이언트와 부동소수 결과가 같아 예측 오차가 더 작아집니다(JavaScriptCore인 Safari·Bun과는 마지막 비트 차이 가능, 조정으로 흡수).

`apps/client`
- `Game.simulate`의 로컬 `step`을 `NetWorld`(스냅샷 버퍼 + 보간 + 내 캐릭터 예측)로 교체. `Renderer.render(world, prev, alpha)`와 `Hud.update` 시그니처는 그대로 둘 수 있게 `World`와 같은 모양의 "뷰 월드"를 만들어 넘깁니다.
- 2.2의 뷰 생명주기 변경(서버 AOI와 같은 상수).
- 프로필·상점을 API 호출로 전환. `localStorage`는 캐시로만.

### 3.5 재접속 · 봇 대체 · 치팅

- 끊긴 플레이어의 `Fighter.bot`에 `BotBrain`을 넣으면 다음 틱부터 봇이 조작합니다. 60초 안에 재접속하면 `bot = null`로 되돌리고 전체 스냅샷을 다시 보냅니다. 코드 변경 없이 sim이 이미 지원하는 동작입니다.
- 클라이언트 입력은 방향 벡터와 버튼뿐이고 쿨다운·사거리·드래프트 가능 여부는 sim이 검사하므로 스피드핵·쿨다운핵이 구조적으로 불가능합니다. 남는 것은 명령 빈도 제한(틱당 4개)과 이름 검증 정도입니다.
- AOI 밖 엔티티를 보내지 않으므로 맵핵도 원천 차단됩니다.
- 보상·코인·상점은 서버에서만 계산·기록합니다.

### 3.6 트랜스포트

- **WebSocket을 기본**으로 합니다. 모든 후보 호스팅이 지원하고 iOS Safari에서 동작합니다.
- WebTransport(QUIC, 비신뢰 데이터그램)는 2026년 3월 Safari 26.4로 데스크톱 전 브라우저 Baseline이 됐지만 **iOS Safari는 아직 미지원**입니다. 모바일 우선 게임이라 WebSocket 폴백은 계속 필수입니다.
- 그러니 `send(reliable | unreliable)` 두 채널을 가진 트랜스포트 인터페이스 뒤에 WebSocket을 두고, 직접 운영하는 서버(VM·컨테이너)에서는 나중에 WebTransport를 추가합니다. Colyseus 0.16이 실험적 WebTransport 트랜스포트를 제공합니다. Cloudflare Durable Objects는 WebSocket만 지원합니다.
- TCP 헤드오브라인 블로킹은 100 ms 보간 버퍼와 내 캐릭터 예측으로 대부분 가려집니다. 20 Hz·300 B 패킷이라 1~2% 손실에서도 가끔 100~200 ms 멈춤 수준입니다.

## 4. 클라우드 서비스 비교

### 4.1 실시간 게임 서버 호스팅

| 옵션 | 서울 리전 | `packages/sim`(TS) 실행 | 트랜스포트 | 운영 부담 | 소규모 월 비용(추정) | 트래픽 요금 | 확장 경로 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **서울 VM 자체 운영** (Vultr Seoul, AWS Lightsail Seoul, Oracle Cloud Seoul) + Colyseus | ✅ 보장 | ✅ Node/Bun 그대로 | WS, 나중에 WebTransport | 중 (OS·TLS·배포·모니터링 직접) | 6~24달러 | VM 요금에 1~4 TB 포함(OCI Always Free는 10 TB) | VM 추가 + 매치메이커 라우팅. 컨테이너화해 두면 아래 어디로든 이전 |
| **Colyseus Cloud** (관리형 Colyseus) | 32개 리전. 서울 포함 여부는 대시보드에서 확인 필요 | ✅ | WS(+실험적 WebTransport) | 낮음 | 15달러부터(플랜당) | 플랜 포함 | 리전·인스턴스 추가 클릭 |
| **Cloudflare Workers + Durable Objects** | ⚠ best effort. 2026-06 추가된 `apac-ne`(일본·한국) 힌트로 근접 배치. 서울 보장은 없음 | ✅ Workers 런타임(순수 TS라 호환). Colyseus는 못 씀 → 룸 계층 직접 작성 또는 PartyServer | WS만 | 매우 낮음(서버 없음) | 5달러 + 매치당 ≈ 0.001달러 | 무료 | 자동. 매치 = DO 1개 |
| Cloudflare Containers | DO 근처 일부 위치 | ✅ Bun/Node 컨테이너 | WS | 낮음 | 5달러 + 사용량 | 1 TB/월 무료 | DO와 조합 |
| Fly.io Machines | ❌ 도쿄(nrt)가 최근접 | ✅ 컨테이너 | WS/UDP | 낮~중 | 5~10달러 | APAC 유료 | 리전 추가 |
| Edgegap (컨테이너 오케스트레이션) | ✅ 한국 위치 다수 | ✅ 컨테이너 | WS(웹게임 릴레이 지원)/UDP | 낮음 | 상시 1 vCPU ≈ 50달러 + 트래픽 | GB당 0.10달러 | 매치별 배포, 600+ 위치 |
| Gameye (베어메탈 오케스트레이션) | ✅ Asia Northeast(도쿄·서울) | ✅ 컨테이너, SDK 불필요 | WS/UDP | 낮음 | vCPU-시간당 0.07달러 ≈ 상시 1 vCPU 51달러 | 포함 | 리전 확장 |
| AWS GameLift Servers (컨테이너 플릿) | ✅ ap-northeast-2 | ⚠ 서버 SDK가 C++/C#/Go. Node는 Go 사이드카로 래핑 필요 | WS/UDP | 중~높 | 상시 1대 70~100달러(스팟 시 절반 이하) | gen6+ 인스턴스는 2026-06부터 무료 | FlexMatch, 오토스케일, 글로벌 큐 |
| Azure PlayFab Multiplayer Servers | ✅ Korea Central | ⚠ GSDK가 C++/C#/Java/Go. Node 미공식 | WS/UDP | 중 | VM 시간 과금 ≈ 70달러 + PlayFab 플랜 | 별도 | PlayFab 계정·경제·매치메이킹과 통합 |
| Agones on GKE/EKS (서울) | ✅ | ✅ Node SDK 있음 | WS/UDP | 높음(k8s) | 클러스터+노드 80~150달러 | 클라우드 요금 | 무한 |
| 일반 컨테이너 PaaS (Cloud Run·App Runner) | ✅ 서울 | ✅ | WS | 낮음 | 25~50달러 | 유료 | ⚠ 특정 인스턴스로 플레이어를 붙일 수 없어 룸 모델과 맞지 않음. Fargate 고정 태스크는 가능하나 VM과 다를 것 없음 |

Hathora는 2026-03 인수 후 2026-05에 서비스를 종료했습니다. 특정 관리형 게임 호스팅에 깊게 묶이면 이런 위험이 있으니, **서버는 표준 컨테이너로 만들고 호스팅은 갈아끼울 수 있게** 두는 것이 이 표 전체에 걸친 원칙입니다.

### 4.2 옵션별 상세

**서울 VM + Colyseus (1순위)**
- 장점: 국내 RTT 10~30 ms 확실. 런타임 완전 제어(Bun·worker_threads·WebTransport·프로파일링). 고정비 예측 가능. 2 vCPU 한 대로 100룸.
- 단점: 패치·TLS·배포·모니터링을 직접. 단일 장애점(두 대 + 로비 라우팅으로 완화. 매치가 5.5분이라 배포 시 "새 룸 안 받고 기다렸다 재시작"하는 드레인이 쉬움).
- 후보: Vultr Seoul(2 vCPU/4 GB 24달러, 3 TB 포함), AWS Lightsail Seoul(2 GB 약 10~12달러 / 4 GB 약 20~24달러, 2~4 TB 포함), Oracle Cloud Seoul Always Free(ARM 4 OCPU/24 GB, 10 TB 송신 무료 — 용량 확보가 어려울 때가 있음). GCP·Azure VM은 서울에 있지만 송신 GB당 0.12달러 수준이라 트래픽에서 불리합니다.
- Cloudflare를 앞에 두는 문제: Cloudflare 프록시를 거치면 DDoS 방어와 TLS를 얻지만, 국내 ISP 피어링 비용 때문에 비-Enterprise 플랜 트래픽이 도쿄·홍콩 PoP로 우회된다는 보고가 오래 있었습니다. 게임 WSS는 VM에 직접(Caddy로 TLS 자동 발급) 붙이고, Cloudflare는 정적 파일·DNS·API에만 쓰는 것을 기본으로 하되, `cdn-cgi/trace`의 `colo` 값을 KT·SKT·LGU+ 회선에서 확인해 프록시 여부를 정하면 됩니다.

**Colyseus Cloud**
- 위 구성의 운영 부담을 15달러/월부터 대신해 줍니다. 서울 리전이 있으면 가장 빠른 출시 경로입니다. 없으면 도쿄가 되므로 1순위 VM으로 갑니다. 규모가 커지면 컨테이너 그대로 VM이나 오케스트레이션으로 옮길 수 있습니다.

**Cloudflare Workers + Durable Objects (2순위, 검증 조건부)**
- 장점: 서버·OS·스케일링이 없음. 트래픽 무료. 요금이 매치 단위(128 MB × 330초 ≈ 41 GB-s → 0.0005달러, 수신 메시지 20:1 과금 → 0.0003달러, 합쳐 매치당 ≈ 0.001달러). 월 3만 판이어도 35달러. 전 세계 배치가 자동(첫 접속자 근처).
- 조건·리스크:
  - 배치가 best effort입니다. `locationHint: 'apac-ne'`로 일본·한국 근처를 요청할 수 있지만 서울 보장은 없습니다(도쿄·오사카가 될 수 있음). 위의 KR 라우팅 특성과 겹치면 RTT 50~80 ms가 될 수 있습니다.
  - 틱 루프: `setInterval`은 DO의 하이버네이션을 막고, DO는 배포·유지보수 시 퇴거(evict)될 수 있습니다. 진행 중 매치를 잃지 않으려면 5초마다 체크포인트(SQLite 쓰기 백만 건당 1달러라 무시할 수준)를 저장하고 재접속 시 복원해야 합니다. `World`가 순수 데이터라 구현은 쉽습니다.
  - Colyseus를 못 쓰므로 룸·재접속·스냅샷 계층을 직접 씁니다(PartyServer가 룸 추상화를 일부 제공). 3.4의 `packages/net`을 공용으로 만들면 이 계층은 500~800줄 수준입니다.
  - WebSocket만 지원. 관측성·디버깅은 VM보다 불편.
- 결정 기준(6절 스파이크): 국내 모바일 회선 RTT 중앙값 40 ms 미만, p95 80 ms 미만, 12명 접속 상태에서 틱 간격 p99 70 ms 미만이면 채택 가능.

**Edgegap · Gameye**
- 매치마다 컨테이너를 띄우는 모델이 강점이지만, 이 게임은 룸당 CPU가 워낙 작아 프로세스 하나에 룸 수십 개를 넣는 편이 낫습니다. 그러면 "관리형 컨테이너 호스팅" 이상의 가치가 없고 상시 비용이 VM의 2~4배입니다. 멀티 리전(일본·동남아·북미)이 필요해지면 그때 검토하는 게 맞습니다.

**GameLift · PlayFab · Agones**
- 오토스케일·매치메이킹·플릿 관리가 강하지만 최소 고정비 70~100달러/월이고, Node 서버를 위한 공식 SDK 공백(GameLift·PlayFab)이나 k8s 운영(Agones)이 붙습니다. PlayFab은 계정·경제·리더보드까지 한 번에 주는 점이 매력이지만 데이터가 주로 미국 리전에 있어 국내 개인정보 처리 관점에서 확인이 필요합니다. 동접 수천 명 이상, 글로벌 출시 단계의 선택지로 둡니다.

### 4.3 메타 백엔드 (계정 · 코인 · 룬 · 리더보드)

| 옵션 | 서울 | 특징 | 추천 상황 |
| --- | --- | --- | --- |
| **Supabase** (Postgres + Auth + Edge Functions) | ✅ Northeast Asia (Seoul) | 무료 티어, Pro 25달러. Auth에 카카오·구글·애플 제공자 포함. RLS로 클라이언트 직접 읽기 가능, 쓰기는 서버 키로 | VM/Colyseus 트랙의 기본값 |
| Firebase (Auth + Firestore) | ✅ asia-northeast3 | 종량제, Auth 무료. 카카오 로그인은 커스텀 토큰 필요 | 기존 Firebase 경험이 있을 때 |
| Cloudflare D1 (+ Workers API) | 생성 시 근접 배치(힌트) | Workers Paid에 포함. SQLite | Cloudflare 트랙 |
| PlayFab | ❌(미국 중심) | 경제·리더보드·매치메이킹 내장 | 글로벌 단계 |
| Nakama (자체 호스팅/Heroic Cloud) | 자체 호스팅이면 ✅ | Go 서버. 권위 매치 로직은 Go/Lua/TS(인터프리터)라 `packages/sim`을 그대로 옮기기 어려움 | 메타만 쓰려면 과함 |

서버 게임 서버 → DB 쓰기(보상·구매)는 서비스 키로, 클라이언트는 자기 프로필 읽기만. 매치 종료 시 `scoreMatch` 결과와 리플레이 키를 함께 기록하면 분쟁·치팅 검토에 그대로 씁니다.

### 4.4 정적 호스팅 · CDN

- Vite 산출물 3.5 MB는 어느 정적 호스팅에나 올라갑니다. **Cloudflare Pages(무료, 글로벌 CDN, Brotli, `_headers`로 캐시 제어)**를 기본으로 하고, Vercel·Netlify·S3+CloudFront도 동등합니다.
- 모델 `.glb`는 `Cache-Control: public, max-age=31536000, immutable` + 경로 버전. 서버 프로토콜 버전과 클라이언트 버전을 핸드셰이크에서 비교해 구버전 클라이언트에 새로고침을 요구합니다.

### 4.5 한국 시장 특이사항

- 개인정보(계정·닉네임·결제): 개인정보보호법의 국외 이전 고지·동의 요건이 있으니 DB는 서울 리전에 두는 편이 단순합니다(Supabase Seoul, Firestore Seoul).
- 로그인: 게스트(기기 토큰) → 카카오·구글·애플 연동. Supabase Auth가 카카오를 기본 제공합니다.
- 회선: Cloudflare 경유 시 국내 라우팅 확인(4.2). 모바일 캐리어 NAT는 WebSocket에 문제없습니다.

## 5. 추천안

### 5.1 1순위: 서울 VM + Colyseus + Cloudflare Pages + Supabase(Seoul)

```
브라우저 (Vite · three · Preact)
 ├─ HTTPS  정적 파일 ─────────► Cloudflare Pages / CDN (무료)
 ├─ HTTPS  메타 API ─────────► apps/server(Node) 또는 Supabase Edge Functions
 └─ WSS    게임 ─────────────► 서울 VM (Caddy TLS) → Colyseus
                                  ├─ LobbyRoom: 빠른 매치, 15초 또는 12명, 봇 채움
                                  └─ MatchRoom ×N: packages/sim 20 Hz, AOI 35 스냅샷
                                        └─ 종료 → scoreMatch → Supabase(Seoul) 기록
Supabase(Seoul): Postgres(프로필·코인·룬·리더보드) + Auth(게스트·카카오·구글·애플)
R2 / S3: 리플레이(seed + commands), 모델 에셋 백업
```

- 시작 비용: VM 12~24달러 + Supabase 0~25달러 + Pages 0 = **월 20~50달러**.
- 용량: 2 vCPU 한 대 ≈ 100룸 ≈ 1,200 동접. 트래픽 월 1~3 TB 포함.
- Colyseus Cloud에 서울이 있으면 VM 대신 15달러/월로 시작해 운영 부담을 더 줄일 수 있습니다.

### 5.2 2순위: Cloudflare 풀스택 (검증 통과 시 1순위와 교체 가능)

- Pages(정적) + Workers(API) + Durable Objects(로비·매치, `apac-ne`) + D1(메타) + R2(리플레이). 월 5달러 + 매치당 0.001달러.
- 조건: 6절의 지연·틱 지터 스파이크 통과, 5초 체크포인트 구현, 룸 계층 직접 작성 감수.
- 이 트랙의 큰 장점은 나중에 글로벌로 갈 때 아무것도 안 해도 된다는 점입니다. 1순위로 시작해도 `packages/net`을 공용으로 두면 DO 어댑터만 추가해 옮길 수 있습니다.

### 5.3 예상 월 비용

| 규모 | 1순위(서울 VM) | 2순위(Cloudflare) | 참고: GameLift/PlayFab |
| --- | --- | --- | --- |
| 출시 초 (DAU 1천, 동접 100~200, 1천 판/일) | 20~50달러 | 5~40달러 | 100~200달러 |
| 성장 (DAU 1만, 동접 1~2천, 1만 판/일, 월 9 TB) | VM 2~3대 60~100달러 + Supabase Pro 25 (트래픽은 VM 포함량 초과분만) | 5달러 + 300달러(매치) ≈ 300달러, 트래픽 0 | 500달러 이상 + 트래픽(gen6+ 무료) |

## 6. 단계별 로드맵과 결정 전 실험

### 결정 전 스파이크 (각 하루 이내)

1. **지연 측정**: Vultr/Lightsail 서울 VM에 WebSocket 에코, Cloudflare DO 에코(`apac-ne`)를 각각 띄우고 KT·SKT·LGU+ 모바일과 유선에서 RTT 중앙값·p95, `colo`를 기록. 기준: 중앙값 40 ms, p95 80 ms.
2. **틱 지터**: DO 안에서 `packages/sim`을 50 ms 루프로 6분 돌리며 봇 클라이언트 12개 접속. 틱 간격 p99 70 ms 미만, CPU 시간 과금 확인. VM에서는 `bun run profile` 수치가 곧 기준입니다.
3. **모바일 렌더 프로파일**: 중급 안드로이드(Galaxy A급)에서 2.2의 1·3번 적용 전후 프레임 시간 비교. 기준: 후반 난전 구간 16.7 ms 미만.

### Phase 0 — 싱글을 유지하며 준비 (2~3주)

- 2.2의 1~6번 클라이언트 최적화(뷰 생명주기·애니 LOD·지형 베이크·그림자 옵션·할당 제거·해상도).
- `createWorld` 다중 사람, `checkpoint/restore`, `rewards` 공용화, 리플레이 기록(싱글에서도 버그 재현용으로 바로 유용).
- `packages/net` 스냅샷 포맷 + 테스트. 싱글 모드에서 "로컬 서버" 모드(같은 프로세스 안에서 스냅샷을 거쳐 렌더)로 먼저 검증하면 서버 없이 넷코드 대부분을 테스트할 수 있습니다.
- CI(GitHub Actions: typecheck·test·build), Dockerfile.

### Phase 1 — 멀티 MVP, 서울 단일 리전 (3~4주)

- `apps/server` Colyseus 로비·매치 룸, 게스트 계정, WebSocket.
- Cloudflare Pages 배포, Supabase Seoul, 서버 보상 기록·상점 API.
- 모니터링: Colyseus 모니터, `/health`, UptimeRobot, Sentry(클라이언트 오류).

### Phase 2 — 안정화

- 재접속 + 봇 대체, 명령 빈도 제한, 헤드리스 봇 클라이언트로 부하 테스트(룸 100개), 스냅샷 10/20 Hz 비교, 그래픽 프리셋 자동 선택.

### Phase 3 — 글로벌 · 스케일

- 로비에서 리전 선택(서울·도쿄·싱가포르·북미). VM 추가 또는 Edgegap/Gameye/Cloudflare DO로 룸 호스팅 이전. 데스크톱 WebTransport. 랭크 매치메이킹.

## 7. 참고 자료

- Cloudflare Durable Objects 요금·WebSocket 과금: https://developers.cloudflare.com/durable-objects/platform/pricing
- Durable Objects 데이터 위치·`apac-ne` 힌트(2026-06-19): https://developers.cloudflare.com/durable-objects/reference/data-location/ , https://developers.cloudflare.com/changelog/post/2026-06-19-apac-ne-apac-se-location-hints/
- Durable Objects WebSocket 하이버네이션·타이머 규칙: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Cloudflare Workers/Containers 요금: https://developers.cloudflare.com/workers/platform/pricing/
- Safari 26.4 WebTransport(데스크톱 Baseline): https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ , https://developer.mozilla.org/en-US/docs/Web/API/WebTransport
- Colyseus 0.16 (StateView·WebTransport): https://colyseus.io/blog/colyseus-016-is-here/ , https://docs.colyseus.io/state/view
- Colyseus Cloud 요금: https://colyseus.io/pricing/ , https://docs.colyseus.io/cloud/pricing-billing
- Fly.io 리전(서울 없음): https://fly.io/docs/reference/regions/
- Amazon GameLift Servers 요금(gen6+ 송신 무료): https://aws.amazon.com/gamelift/servers/pricing/ , Node.js 10 지원 종료: https://aws.amazon.com/gamelift/faq/nodejs10/
- Azure PlayFab 요금·MPS: https://learn.microsoft.com/en-us/gaming/playfab/pricing/pricing-overview , https://learn.microsoft.com/en-us/gaming/playfab/multiplayer/servers/billing-for-thunderhead
- Edgegap 요금: https://edgegap.com/resources/pricing , 웹게임 지원: https://edgegap.com/gaming/webGL-html5
- Gameye 리전(Asia Northeast: 도쿄·서울): https://docs.gameye.com/regions-and-locations
- Hathora 종료(2026-05) 경위: https://gameye.com/gameye-vs-hathora/
- three.js 스킨드 인스턴싱 관련 논의: https://discourse.threejs.org/t/instance-animated-skinned-mesh/48489
