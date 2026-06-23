# HOWTO — AM5 테니스 경기 관리 시스템

## 1. 신규 배포 (Vercel + Supabase)

### 1.1 Supabase 프로젝트 생성

1. [supabase.com](https://supabase.com)에 접속하여 새 프로젝트를 만듭니다.
2. 프로젝트 생성 후 SQL Editor를 엽니다.
3. `supabase/schema.sql` 파일의 전체 내용을 복사하여 실행합니다.
4. Project Settings > API에서 다음 값을 확인합니다:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (Settings > API > service_role)

### 1.2 환경 변수 설정

`.env.example`을 복사하여 `.env.local`을 만들고 Supabase 프로젝트 값을 채웁니다.

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
```

### 1.3 Vercel 배포

1. GitHub 저장소를 Vercel에 연결합니다.
2. Vercel Project Settings > Environment Variables에 위 3개 값을 등록합니다.
3. 배포합니다.
4. 배포된 URL에 접속하면 기본 관리자 계정(`admin` / `AM5AM5`)이 자동 생성됩니다.
5. 즉시 로그인하여 비밀번호를 변경하세요.

---

## 2. 기본 서비스 운영 가이드

### 2.1 관리자 메뉴
하단 탭 우측의 **관리자** 아이콘(방패)을 누르면 관리자 전용 메뉴가 표시됩니다.

| 메뉴 | 기능 |
|------|------|
| 회원 관리 | 회원 정보 수정, 출석/퇴장, 비밀번호 초기화, 권한 부여, 게스트 추가, 회원 삭제 |
| 테스트 콘솔 | 임시 사용자로 배정 시뮬레이션 |
| 코트 관리 | 3개 코트의 대여 시작/종료 |
| 모니터 | 코트별 진행 상황 및 전체 경기 결과 조회 |

### 2.2 오늘 모임 운영 흐름

1. **코트 준비**: 관리자 > 코트 관리에서 사용할 코트의 `대여 시작`을 누릅니다.
   - 대여 시작과 동시에 현재 출석 중인 대기 인원이 있으면 자동으로 경기가 생성됩니다.
2. **회원 출석**: 회원이 `참석하기`를 누르면 자동으로 경기가 배정됩니다.
3. **경기 진행**: 경기 카드에서 `시작` → `종료` → 점수 입력 순으로 진행합니다.
4. **연속 배정**: 결과 저장 후에도 대기 인원과 가용 코트가 있으면 다음 경기가 자동 생성됩니다.
5. **코트 정리**: 모든 경기가 끝나면 코트 관리에서 `대여 종료`를 누릅니다.

### 2.3 일반 회원 화면

- **오늘 탭**: 내 출석 상태, 배정된 경기, 결과 입력 폼이 표시됩니다.
- **결과 탭**: 오늘 경기 결과 및 이전 모임 결과를 조회할 수 있습니다.
- **랭킹 탭**: 월간 / 연간 / 전체 랭킹 및 개인 전적을 확인할 수 있습니다.
- **내 정보 탭**: 내 정보 수정, 비밀번호 변경, 로그아웃 기능을 제공합니다.

### 2.4 경기 종료 및 결과 입력

- 각 경기 카드의 `종료` 버튼으로 경기를 종료합니다.
- 종료 후 점수 입력 폼이 나타나며, A팀과 B팀 점수를 입력하고 저장합니다.
- 결과가 저장되면 승패와 랭킹에 반영됩니다.
- 경기에 참여한 선수 중 아무나 종료/결과 입력을 할 수 있습니다.

### 2.5 주의사항

- 코트 `대여 시작` 전에는 경기가 생성되지 않습니다.
- 경기 중인 회원은 퇴장할 수 없습니다 (먼저 경기 종료 필요).
- 관리자 권한 부여/삭제, 회원 삭제, 비밀번호 초기화 시 재확인 대화상자가 표시됩니다.

---

## 3. 로컬 개발 환경

### 3.1 사전 요구사항

- Node.js 20+
- npm
- Supabase 프로젝트 (무료 티어로 충분)

### 3.2 설치 및 실행

```bash
# 저장소 클론
git clone <repo-url>
cd am5-tennis-manager

# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env.local
# .env.local을 편집하여 Supabase 값 입력

# 개발 서버 실행
npm run dev
```

브라우저에서 `http://localhost:3000`으로 접속합니다.

### 3.3 테스트 콘솔 사용

관리자 로그인 후 **테스트 콘솔**에서 배정 로직을 시뮬레이션할 수 있습니다.

1. 테스트 콘솔 화면에서 `임시 사용자 8명 추가` 버튼 클릭
2. `전체 입장` 버튼으로 모든 임시 사용자를 입장 처리
3. `경기 배정` 버튼으로 대진 생성 시험
4. 각 코트의 `경기 시작` / `경기 종료`로 전체 플로우 테스트
5. 점수 입력까지 완료하면 승률과 전적이 갱신됨

> 테스트 콘솔의 데이터는 브라우저 메모리에서만 관리되며 Supabase에 저장되지 않습니다.

### 3.4 코드 구조

```
src/
├── app/              # Next.js App Router
│   ├── page.tsx      # 메인 페이지 (Am5App 렌더링)
│   └── api/          # 서버 API 라우트
├── components/
│   └── Am5App.tsx    # 모든 UI와 상태 관리 (단일 컴포넌트)
├── lib/
│   ├── models.ts     # 타입 정의, CourtName, DEFAULT_COURTS 등
│   ├── scheduler.ts  # 경기 배정 및 팀 분배 로직
│   ├── stats.ts      # 전적/랭킹 계산
│   ├── date.ts       # 날짜/시간 유틸
│   └── supabase.ts   # Supabase 클라이언트
└── app/
    └── globals.css   # 전체 스타일
supabase/
└── schema.sql        # DB 스키마 + RLS 정책
```

### 3.5 빌드 확인

```bash
npm run build
```

TypeScript 타입 체크와 Turbopack 빌드가 함께 실행됩니다.
