# Meeting Minutes Summarizer (MVP)

회의 스크립트(또는 오디오 전사)를 붙여넣으면 3줄 요약·아젠다·액션 아이템을 추출해 저장하는 웹앱.

- **요약**: Gemini(클라우드) 또는 **로컬 LLM**(Ollama·LM Studio 등 OpenAI 호환) 중 선택
- **오디오 전사**: Gemini (로컬 텍스트 LLM은 오디오 전사 불가)

모든 키·설정은 웹앱 설정(⚙️)에서 관리하며 브라우저(localStorage)에 저장됩니다 — 서버 DB엔 보관되지 않습니다. 요약·전사 호출은 브라우저에서 직접 제공자(Gemini/로컬)로 나갑니다.

## 로컬 LLM으로 요약 (선택)

설정 ⚙️ → **요약 제공자 → 로컬 LLM** 선택 후 서버 주소·모델명 입력.

- 예) Ollama: 주소 `http://localhost:11434/v1`, 모델 `llama3.1` (먼저 `ollama pull llama3.1`)
- 브라우저와 **같은 PC**에서 로컬 서버가 떠 있어야 합니다 (`http://localhost` 은 HTTPS 사이트에서도 접근 허용됨)
- ⚠️ **CORS**: 배포된(Vercel) 사이트에서 로컬 서버를 부르려면 로컬 서버가 그 오리진을 허용해야 합니다.
  - Ollama: `OLLAMA_ORIGINS="*"` (또는 배포 도메인) 설정 후 재시작 —
    예 `OLLAMA_ORIGINS="*" ollama serve`
  - LM Studio: 서버 설정에서 CORS 허용 on
- 전사는 이 설정과 무관하게 항상 Gemini를 사용하므로 Gemini 키는 여전히 필요합니다.

## 구조

```
meeting-minutes/
├── api/                    # Vercel 서버리스 함수 (= 백엔드, Express 불필요)
│   ├── _db.js              # Postgres 클라이언트 (Neon·로컬 공용, 서버리스 최적화)
│   ├── _wrap.js            # 핸들러 예외 → JSON 에러 (원인 진단)
│   ├── meetings.js         # GET  /api/meetings   — 목록/검색(?q=), POST — 저장
│   └── meetings/[id].js    # GET/PATCH /api/meetings/:id — 상세 / 액션아이템 토글
│   # 요약·전사(AI 호출)는 백엔드가 아니라 브라우저에서 직접 제공자로 호출
├── src/
│   ├── App.jsx             # 대시보드 · 작성 · 상세 화면 (view state 전환)
│   ├── main.jsx
│   └── index.css           # Tailwind v4 (@import "tailwindcss")
├── schema.sql              # PostgreSQL DDL (Neon에서 1회 실행)
├── index.html
├── vite.config.js
└── package.json
```

## 로컬 실행

```bash
npm install
cp .env.example .env      # DATABASE_URL 설정 (로컬은 postgresql://localhost:5432/meeting_minutes)
psql -d meeting_minutes -f schema.sql   # 스키마 1회 적용
npm run dev:api           # API  → http://localhost:3001
npm run dev:front         # 프론트 → http://localhost:5173 (/api는 3001로 프록시)
```

Gemini 키는 서버가 아니라 앱 **⚙️ 설정**에서 입력합니다 (브라우저 저장, 본인 키 사용).

## 배포 (GitHub → Vercel + Neon)

### 1) Neon 데이터베이스 만들기

**방법 A — Vercel Storage 연동(가장 쉬움)**
1. Vercel 프로젝트 → **Storage → Create Database → Neon** 연결 → `DATABASE_URL` 자동 주입

**방법 B — Neon에서 직접**
1. [neon.com](https://neon.com) → 프로젝트 생성 (리전 선택)
2. **Dashboard → Connection Details → "Pooled connection"** 문자열 복사
   - ⚠️ 반드시 **풀러(pooled) 문자열** — host에 `-pooler` 포함. `?sslmode=require` 유지
   - 형태: `postgresql://[USER]:[PW]@ep-xxxx-pooler.[REGION].aws.neon.tech/[DB]?sslmode=require`
3. Vercel **Settings → Environment Variables**에 `DATABASE_URL`로 추가

공통: Neon 콘솔 **SQL Editor**에서 `schema.sql` 내용 붙여넣고 **Run** (테이블 1회 생성)

### 2) Vercel 배포
1. GitHub에 push (이미 연결됨)
2. vercel.com → **Add New Project** → 이 레포 import
   - Framework Preset: **Vite** (자동 감지) / Build `vite build` / Output `dist` — 그대로
   - Root Directory: 레포 루트 그대로 (이 폴더가 곧 앱)
3. `DATABASE_URL`이 설정됐는지 확인 (Production 환경). 환경변수 변경 후엔 **재배포** 필요
4. **Deploy** — 이후 `git push`마다 자동 재배포
5. 접속 후 앱 **⚙️ 설정**에서 Gemini API 키 입력 + 모델 선택

### 필요한 환경변수 (Vercel → Settings → Environment Variables)

| 변수 | 값 | 필수 |
|---|---|---|
| `DATABASE_URL` | Neon **풀러(pooled)** 연결 문자열 (host에 `-pooler`) | ✅ (Storage 연동 시 자동) |
| `AUTH_SECRET` | 인증 토큰 서명 키 — `openssl rand -hex 32`로 생성 (미설정 시 모든 API 잠김) | ✅ |
| `INVITE_CODE` | 가입 초대 코드 — 입력 시 즉시 사용, 없이 가입하면 관리자 승인 대기. 미설정이면 전원 승인제 | 권장 |

Gemini 키는 **서버 환경변수가 아닙니다** — 사용자가 앱 설정에서 직접 입력(브라우저 보관). 서버에 넣을 AI 키는 없습니다.

### 참고

- 서버리스 함수 실행 시간: Hobby 플랜은 최대 60초 (요약 `maxDuration: 60` 설정됨). 더 길게 필요하면 Pro.
- 오디오 업로드·전사는 브라우저 → Gemini 직접 통신이라 서버리스 본문 한도(4.5MB)와 무관.

## 보안

- **계정**: 이메일/비밀번호 회원가입·로그인(`POST /api/auth`). 비밀번호는 **scrypt**(랜덤 솔트, Node 내장)로 해시 저장 — 평문·복호화 가능 형태로 저장하지 않음. 로그인 성공 시 `AUTH_SECRET`으로 HMAC 서명한 30일 무상태 토큰 발급.
- **데이터 격리**: 모든 회의록은 `user_id`로 소유자에 묶이며, 목록·검색·상세·액션아이템 토글 전부 본인 데이터만 접근 가능(타인 id 조회 시 404).
- **로그인 보안**: 상수시간 비교(타이밍 공격 방지), 미가입 이메일도 더미 해시 검증(계정 존재 유추 완화), 로그인 실패 메시지는 이메일/비밀번호 구분 없이 동일, 비밀번호 최소 8자.
- **가입 봇 방지**: 허니팟 필드 + 서버 서명 챌린지(폼 표시 후 최소 3초 경과해야 제출 가능, 10분 만료) + 인스턴스 메모리 rate limit(시간당 30회/IP — 강한 보호는 Vercel WAF).
- **공개 범위**: 회의록별 `visibility` — `private`(나만) / `workspace`(가입자 전체 열람). 공개 회의록도 액션아이템 토글은 소유자만.
- **SQL 인젝션**: `postgres` 태그드 템플릿(파라미터 바인딩)만 사용 — 문자열 조립 없음.
- **XSS**: React 기본 이스케이프, `dangerouslySetInnerHTML` 미사용.
- **키 취급**: Gemini 키는 서버에 저장·경유하지 않음(브라우저 → Google 직행). DB 연결 문자열·앱 비밀번호는 서버 환경변수에만 존재, `.env`는 gitignore.
- **입력 제한**: 저장 API에 제목 300자·본문 100만 자·액션아이템 100개 상한.
- **응답 헤더**: `nosniff`, `X-Frame-Options: DENY`(클릭재킹 방지), `Referrer-Policy`, `Permissions-Policy` — 카메라·위치 차단, 마이크는 자기 오리진만(`microphone=(self)`, 회의 녹음용) (vercel.json).
- 남은 항목(필요 시): 로그인 시도 rate limiting(Vercel WAF), 다중 사용자 계정, 엄격한 CSP.

## 확장 로드맵 (기획서 기준)

- 오디오 STT: 브라우저에서 처리(서버 미경유). **긴 파일(약 7.5분 초과)은 5분 조각으로 분할**(Web Audio로 16kHz 모노 WAV 재인코딩) → 조각마다 업로드·전사해 결과가 점진적으로 도착. 짧은 파일은 원본 그대로 통짜 전사(품질 손실 없음), 디코딩 실패 시에도 통짜 폴백. aac/m4a/mp3/wav 지원, 최대 100MB
- 벡터 검색: Neon은 pgvector 지원 → `schema.sql` 하단 주석 참고
- 기업/참석자/권한: 기획서 1단계 범위, 테이블 추가로 확장
