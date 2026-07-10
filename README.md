# Meeting Minutes Summarizer (MVP)

회의 스크립트를 붙여넣으면 Google Gemini가 3줄 요약·아젠다·액션 아이템을 추출해 저장하는 웹앱.

Gemini API 키와 모델은 웹앱 설정(⚙️)에서 직접 관리합니다 — 키는 브라우저(localStorage)에 저장되고 서버 DB에는 보관되지 않습니다.

## 구조

```
meeting-minutes/
├── api/                    # Vercel 서버리스 함수 (= 백엔드, Express 불필요)
│   ├── _db.js              # Neon Postgres 클라이언트
│   ├── summarize.js        # POST /api/summarize  — Claude 호출 + DB 저장
│   ├── meetings.js         # GET  /api/meetings   — 목록 + 검색(?q=)
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
npm i -g vercel          # 최초 1회
cp .env.example .env     # 키 입력
# schema.sql을 Neon SQL Editor에서 실행
vercel dev               # 프론트 + API 함께 http://localhost:3000
```

## 배포 (GitHub → Vercel)

1. `git init && git add -A && git commit -m "MVP"` 후 GitHub에 push
2. vercel.com → **Add New Project** → 해당 레포 import (Vite 자동 감지)
3. **Storage 탭 → Neon Postgres 생성/연결** → `DATABASE_URL` 자동 주입
4. Neon 콘솔 SQL Editor에서 `schema.sql` 실행
5. Deploy — 끝. 이후 `git push`마다 자동 배포
6. 접속 후 앱 **⚙️ 설정**에서 Gemini API 키 입력 + 모델 선택 (서버 환경변수 불필요)

## 확장 로드맵 (기획서 기준)

- 오디오 STT: 브라우저가 오디오를 Gemini Files API로 **직접 업로드**(서버리스 4.5MB 한도 우회, 최대 100MB) → 전사(generateContent)도 브라우저에서 직접 호출(긴 응답이 서버 fetch 타임아웃에 안 걸리도록) → 결과를 입력란에 채움. aac/m4a/mp3/wav 지원
- 벡터 검색: Neon은 pgvector 지원 → `schema.sql` 하단 주석 참고
- 기업/참석자/권한: 기획서 1단계 범위, 테이블 추가로 확장
