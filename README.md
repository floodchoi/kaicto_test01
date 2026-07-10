# Meeting Minutes Summarizer (MVP)

회의 스크립트를 붙여넣으면 Google Gemini가 3줄 요약·아젠다·액션 아이템을 추출해 저장하는 웹앱.

Gemini API 키와 모델은 웹앱 설정(⚙️)에서 직접 관리합니다 — 키는 브라우저(localStorage)에 저장되고 서버 DB에는 보관되지 않습니다.

## 구조

```
meeting-minutes/
├── api/                    # Vercel 서버리스 함수 (= 백엔드, Express 불필요)
│   ├── _db.js              # Postgres 클라이언트 (Neon·로컬 공용, 서버리스 최적화)
│   ├── summarize.js        # POST /api/summarize  — Gemini 요약 결과 반환(미저장)
│   ├── meetings.js         # GET  /api/meetings   — 목록/검색(?q=), POST — 저장
│   └── meetings/[id].js    # GET/PATCH /api/meetings/:id — 상세 / 액션아이템 토글
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

## 배포 (GitHub → Vercel)

1. GitHub에 push (이미 연결됨)
2. vercel.com → **Add New Project** → 이 레포 import
   - Framework Preset: **Vite** (자동 감지) / Build: `vite build` / Output: `dist` — 그대로 두면 됨
   - Root Directory: 레포 루트 그대로 (이 폴더가 곧 앱)
3. **Storage → Neon Postgres** 생성/연결 → `DATABASE_URL` 자동 주입
   - ⚠️ 반드시 **풀러(pooled) 연결 문자열**(host에 `-pooler` 포함)을 사용. `?sslmode=require` 유지
4. Neon 콘솔 **SQL Editor**에서 `schema.sql` 1회 실행
5. **Deploy** — 이후 `git push`마다 자동 재배포
6. 접속 후 앱 **⚙️ 설정**에서 Gemini API 키 입력 + 모델 선택

### 필요한 환경변수 (Vercel → Settings → Environment Variables)

| 변수 | 값 | 필수 |
|---|---|---|
| `DATABASE_URL` | Neon 풀러 연결 문자열 (`...-pooler.../db?sslmode=require`) | ✅ (Neon 연동 시 자동 주입) |

Gemini 키는 **서버 환경변수가 아닙니다** — 사용자가 앱 설정에서 직접 입력(브라우저 보관). 서버에 넣을 AI 키는 없습니다.

### 참고

- 서버리스 함수 실행 시간: Hobby 플랜은 최대 60초 (요약 `maxDuration: 60` 설정됨). 더 길게 필요하면 Pro.
- 오디오 업로드·전사는 브라우저 → Gemini 직접 통신이라 서버리스 본문 한도(4.5MB)와 무관.

## 확장 로드맵 (기획서 기준)

- 오디오 STT: 브라우저가 오디오를 Gemini Files API로 **직접 업로드**(서버리스 4.5MB 한도 우회, 최대 100MB) → 전사(generateContent)도 브라우저에서 직접 호출(긴 응답이 서버 fetch 타임아웃에 안 걸리도록) → 결과를 입력란에 채움. aac/m4a/mp3/wav 지원
- 벡터 검색: Neon은 pgvector 지원 → `schema.sql` 하단 주석 참고
- 기업/참석자/권한: 기획서 1단계 범위, 테이블 추가로 확장
