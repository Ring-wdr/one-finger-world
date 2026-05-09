# 메인 화면 프로덕션화 디자인

Date: 2026-05-09

## 목적

현재 `src/routes/+page.svelte`의 메인 화면은 `Svelte + Three.js Prototype` 문구와 상시 노출된 입력 옵션 패널 때문에 개발 중인 도구 화면처럼 보인다. 이 문서는 메인 화면을 시즌 1 아트 방향에 맞는 프로덕션 타이틀 화면으로 바꾸고, 입력 임계값 환경설정은 메인 화면 위 설정 패널로 옮기는 디자인을 잠근다.

이 문서는 구현 계획이 아니다. 구현 단계에서는 별도 계획 문서에서 작업 순서와 테스트를 분해한다.

참조:

- 현재 메인 화면: `src/routes/+page.svelte`
- 현재 공용 스타일: `src/routes/layout.css`
- 입력 임계값 옵션 스펙: `docs/superpowers/specs/2026-05-07-input-threshold-options-spec.md`
- 서사·진행 토대: `docs/superpowers/specs/2026-05-07-narrative-and-progression-foundation-design.md`
- 시즌 1 아트 디렉션: `docs/superpowers/specs/2026-05-07-illustration-art-direction-guide.md`
- 챕터 1 일러스트 의뢰서: `docs/superpowers/specs/2026-05-07-chapter-1-illustration-brief.md`
- Stitch DESIGN.md 참고: `https://stitch.withgoogle.com/docs/design-md/overview`, `https://stitch.withgoogle.com/docs/design-md/specification/`, `https://stitch.withgoogle.com/docs/design-md/cli/`

## 결정 요약

- 타이틀 텍스트는 기존 `One Finger Act`를 유지한다.
- 메인 화면은 풀스크린 키 비주얼 배경 위에 `One Finger Act`, `게임 시작`, `환경설정`만 노출한다.
- 기존 입력 임계값 UI는 메인 화면에서 제거하고, `환경설정` 버튼으로 여는 오버레이 설정 패널 안으로 옮긴다.
- 설정 패널은 별도 라우트가 아니라 현재 메인 화면 위에 열린다.
- 배경 에셋은 구현 단계에서 `$imagegen` 기본 내장 모드로 생성하고, 최종 파일은 `static/assets/main-menu/` 아래에 저장한다.
- 구름은 이미지에 고정하지 않고 CSS 레이어로 좌에서 우로 무한 이동한다.
- 프로젝트 UI 기준을 흩어지지 않게 하기 위해 repo root에 `DESIGN.md`를 추가한다.
- `DESIGN.md`는 `npx @google/design.md lint DESIGN.md`로 구조 검증한다.
- 프로젝트는 Bun을 사용하므로 앱 검증 명령은 `bun run check`, `bun run test`, `bun run build`, `bun run verify:browser`를 기준으로 한다.

## 사용자 경험

첫 화면은 큰 폐허 사원/성당 실루엣과 하늘을 먼저 보여준다. 화면 중앙에는 `One Finger Act`가 있고, 그 아래에 `게임 시작`과 `환경설정` 버튼이 세로로 쌓인다. 기존 프로토타입 표식 문구는 제거한다.

`게임 시작`을 누르면 기존처럼 `/play`로 이동한다.

`환경설정`을 누르면 같은 화면 위에 설정 패널이 열린다. 배경 키 비주얼은 어둡게 눌린 상태로 남고, 사용자는 입력 임계값 프리셋·슬라이더·테스트 패드를 조정한 뒤 패널을 닫아 메인 화면으로 돌아온다.

## 아트 방향

배경은 시즌 1 외곽 사원 키트를 따른다.

- 큰 폐허 사원 또는 성당 실루엣.
- 넓은 하늘과 회청 안개.
- 깨진 스테인드글라스 또는 하늘 틈에서 떨어지는 따뜻한 황금 한 줄기.
- 차가운 회청이 화면 대부분을 차지하고 황금은 작은 액센트로만 사용.
- 붉은 광원, 강한 녹색, 보라, 핫 핑크, 현대물, 로고, 워터마크, 이미지 안 텍스트 금지.

배경은 UI 텍스트가 올라갈 것을 전제로 생성한다. 중앙 타이틀과 하단 버튼 영역에는 과도한 대비 텍스처를 두지 않는다. 건축물은 첫인상에서 충분히 크게 보이되, 화면 전체를 막아 하늘이 사라지지 않게 한다.

이미지 생성 프롬프트의 기본 형태:

```text
Use case: stylized-concept
Asset type: full-screen game main menu background
Primary request: a melancholic dark-fantasy ruined outer temple with a large sacred cathedral-like stone structure and open sky
Scene/backdrop: cold blue-gray ruined temple courtyard, broken stone arches, distant larger cathedral silhouette, mist, wide sky
Style/medium: polished painterly game key visual, no text
Composition/framing: vertical-safe composition that also crops well on desktop, large architecture visible behind the title area, readable negative space at center and lower center for UI
Lighting/mood: quiet sadness with one narrow warm golden beam through broken glass or cloud, not heroic
Color palette: cold blue-gray dominant, muted gray stone, one warm golden accent only
Constraints: no characters, no logos, no watermark, no readable text, no modern objects, no red lighting, no strong green, no purple, no hot pink
```

## 구름 모션

구름은 CSS 레이어 2~3개로 처리한다. 각 레이어는 반투명하고 부드러운 구름 밴드이며, 서로 다른 속도로 좌에서 우로 반복 이동한다.

모션 원칙:

- 구름은 하늘과 중상단에 집중한다.
- 타이틀과 버튼 가독성을 방해하지 않는다.
- `prefers-reduced-motion: reduce`에서는 애니메이션을 중지한다.
- 애니메이션은 시각 분위기만 담당하고 게임 상태나 입력 로직에는 영향을 주지 않는다.

## 컴포넌트 구조

기존 메인 화면의 라우트는 유지한다.

- `src/routes/+page.svelte`: 메인 화면 상태와 라우팅 액션을 소유한다.
- `settingsOpen`: 설정 패널 열림 여부를 나타내는 로컬 상태.
- 입력 옵션 상태(`options`)와 테스트 패드 상태(`testPointer`, `testFeedback`, `testDetail`)는 현재처럼 메인 화면 쪽에서 소유한다.
- 구현이 커지면 설정 패널은 `src/lib` 아래 Svelte 컴포넌트로 분리할 수 있지만, 첫 구현에서는 현재 파일 크기와 변경 범위를 기준으로 결정한다.

메인 화면 마크업은 다음 계층으로 정리한다.

1. 풀스크린 배경 이미지.
2. 구름 애니메이션 레이어.
3. 가독성용 어두운/밝은 오버레이.
4. 타이틀과 버튼 스택.
5. 설정 패널 오버레이.

## 설정 패널

설정 패널은 현재 메인 화면에 있던 입력 임계값 UI를 옮긴다.

포함 항목:

- 프리셋 버튼 `편안`, `표준`, `빠름`.
- 슬라이더 3개: `탭 인식 시간`, `드래그 시작 거리`, `대시 빠르기`.
- 현재 값 표시.
- `기본값으로 되돌리기`.
- 입력 테스트 패드.
- 닫기 버튼.

동작:

- 패널 열림 중에도 옵션 변경은 즉시 `localStorage`에 저장한다.
- 패널 닫기는 닫기 버튼, `Escape`, 패널 바깥 클릭을 지원한다.
- 바깥 클릭은 패널 내부 클릭과 충돌하지 않는다.
- 패널이 열려 있을 때 배경 메인 화면은 포인터 입력을 받지 않는다.
- 모바일에서는 하단 시트처럼, 데스크톱에서는 중앙 패널처럼 보인다.
- 패널 내부 콘텐츠가 작은 화면에 넘치면 패널 내부만 스크롤한다.

접근성:

- 설정 패널은 `role="dialog"`와 접근 가능한 이름을 가진다.
- 패널이 열리면 닫기 버튼 또는 패널 제목 영역으로 초점이 이동한다.
- `Escape`로 닫을 수 있다.
- 버튼과 슬라이더는 키보드 조작이 가능해야 한다.

## 데이터 흐름

메인 화면 진입 시 `loadInputThresholdOptions(getStorage())`로 저장된 입력 옵션을 읽는다.

사용자가 프리셋 또는 슬라이더를 변경하면 `setOptions()`가 값을 클램프하고 `saveInputThresholdOptions(getStorage(), options)`로 저장한다. 이 흐름은 기존 동작을 유지한다.

`게임 시작`은 `/play`로 이동한다. `/play`는 기존처럼 다시 저장 값을 로드해 `GameCanvas`에 전달한다. 따라서 메인 화면 설정 패널에서 바꾼 값은 다음 플레이 런타임 생성 시점에 반영된다.

## 스타일 기준

repo root의 `DESIGN.md`는 이후 UI 작업의 기준 문서로 둔다. 이 문서는 Stitch DESIGN.md 참고 링크의 취지처럼, AI와 사람이 공통으로 읽는 디자인 시스템 문서 역할을 한다.

`DESIGN.md`에 잠글 항목:

- 톤: 멜랑꼴리한 다크판타지, 차가운 회청, 한 줄기 황금.
- 버튼: 주 버튼과 보조 버튼의 색, 높이, 반경, 포커스 상태.
- 패널: 최대 너비, 반경 8px 이하, 배경 블러/스크림 규칙.
- 모션: 구름과 오버레이 전환, reduced motion 대응.
- 금지 요소: 프로토타입 문구, 과한 카드 중첩, 강한 보라/녹색/붉은 광원, 장식용 그라디언트 덩어리.

`DESIGN.md` 작성 후에는 다음 명령이 오류 없이 통과해야 한다.

```bash
npx @google/design.md lint DESIGN.md
```

린트 결과는 `errors: 0`이어야 한다. 경고가 나오면 토큰 참조 또는 섹션 구조를 보강해 `warnings: 0`까지 맞춘다. 이 검증은 패키지를 프로젝트 의존성으로 추가하지 않는 일회성 `npx` 실행으로 처리한다.

## 오류와 폴백

배경 이미지가 로드되지 않아도 화면은 깨지지 않아야 한다. CSS 배경색과 그라디언트 폴백을 둔다.

`localStorage` 접근이 실패하면 기존 `getStorage()` 흐름처럼 기본 옵션으로 동작한다. 설정 패널은 열리되, 저장 불가 상태를 별도 오류로 크게 노출하지 않는다.

이미지 생성 결과가 스펙 톤에 맞지 않으면 구현 단계에서 1회 재생성한다. 재생성 기준은 다음 중 하나다.

- 건축물이 충분히 크지 않음.
- 하늘이 거의 보이지 않음.
- 이미지 안에 글자, 로고, 워터마크가 있음.
- 붉은색, 강한 녹색, 보라가 주조로 보임.
- UI 중앙 영역의 가독성이 크게 떨어짐.

## 테스트와 검증

프로젝트는 Bun을 기준으로 검증한다.

- `npx @google/design.md lint DESIGN.md`: `DESIGN.md` 구조 검사. `errors: 0`, `warnings: 0`이어야 한다.
- `bun run check`: Svelte/TypeScript 검사.
- `bun run test`: 단위 테스트.
- `bun run build`: 프로덕션 빌드.
- `bun run verify:browser`: 브라우저 검증 스크립트.

화면 검증 포인트:

- 데스크톱과 모바일에서 배경 이미지가 빈 화면으로 보이지 않는다.
- 제목과 두 버튼이 첫 화면 안에 들어오고 겹치지 않는다.
- `게임 시작`은 `/play`로 이동한다.
- `환경설정`은 같은 화면 위 패널을 연다.
- 패널 닫기 버튼, `Escape`, 바깥 클릭이 동작한다.
- 프리셋·슬라이더·테스트 패드 기존 기능이 유지된다.
- `prefers-reduced-motion`에서 구름 애니메이션이 멈춘다.
- 패널 내부 스크롤이 모바일에서 동작한다.

## 범위 외

- `/settings` 라우트 추가.
- 세이브/진행 모델 UI 추가.
- 지도 화면, 챕터 선택 화면, 스킬 트리 화면 구현.
- 플레이 화면 3D 아트 변경.
- 햅틱, 사운드, 카메라 사용자 옵션 추가.
- 네이티브 앱 패키징.

## 자체 검토

- Placeholder 없음.
- 타이틀 유지 결정 반영됨.
- 설정 패널은 별도 라우트가 아니라 메인 화면 위 오버레이로 명시됨.
- `$imagegen` 사용은 구현 단계 산출물로 분리됨.
- Bun 검증 명령 반영됨.
- 시즌 1 외곽 사원 아트 방향과 금지 색역 반영됨.
- 접근성, 오류 폴백, reduced motion, 모바일 패널 동작 포함됨.
