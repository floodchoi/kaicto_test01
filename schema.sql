-- Meeting Minutes Summarizer MVP schema
-- Neon(또는 아무 PostgreSQL) SQL 에디터에서 1회 실행

CREATE TABLE users (
  id                SERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,   -- 소문자 정규화해 저장
  password_hash     TEXT NOT NULL,          -- scrypt "salt:hash"
  is_admin          BOOLEAN NOT NULL DEFAULT false,
  approved          BOOLEAN NOT NULL DEFAULT false, -- 초대 코드 가입 or 관리자 승인 시 true
  can_use_admin_key BOOLEAN NOT NULL DEFAULT false, -- 관리자 API 키 사용 허용
  gemini_key_enc    TEXT,                   -- 사용자별 Gemini 키 (AES-GCM 암호화)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 초기 관리자는 floodchoi@gmail.com — 가입 시 코드에서 자동 지정.
-- 이미 가입돼 있다면: UPDATE users SET is_admin = true WHERE email = 'floodchoi@gmail.com';

CREATE TABLE projects (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   INT REFERENCES users(id) ON DELETE CASCADE, -- 개인 프로젝트 소유자
  is_shared  BOOLEAN NOT NULL DEFAULT false,             -- 관리자가 만든 공유 프로젝트 (전체 사용 가능)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id         SERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  project_id INT REFERENCES projects(id) ON DELETE SET NULL, -- 프로젝트 분류 (없으면 NULL)
  visibility TEXT NOT NULL DEFAULT 'private',  -- 'private'(나만) | 'workspace'(가입자 전체)
  title      TEXT NOT NULL,
  raw_text   TEXT NOT NULL,              -- 회의 원문 스크립트
  summary    TEXT[] NOT NULL DEFAULT '{}',  -- 3줄 요약
  agenda     JSONB  NOT NULL DEFAULT '[]',  -- [{"topic": "...", "discussion": "..."}]
  tags       TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,                        -- 최종 수정 시각 (수정된 적 없으면 NULL)
  updated_by INT REFERENCES users(id)            -- 최종 수정 계정
);

CREATE TABLE action_items (
  id         SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  task       TEXT NOT NULL,
  assignee   TEXT,                       -- 담당자 (원문에 없으면 NULL)
  due_date   TEXT,                       -- "2026-07-15" 또는 "다음 주 중" 같은 자연어 허용
  done       BOOLEAN NOT NULL DEFAULT false
);

-- ponytail: 검색은 ILIKE로 시작. 회의록 수천 건 넘어가면 pg_trgm 인덱스 추가.
-- 벡터 검색 확장 시: CREATE EXTENSION vector; ALTER TABLE meetings ADD COLUMN embedding vector(1024);

-- [기존 DB 마이그레이션] 이미 meetings 테이블이 있는 DB는 위 CREATE 대신 아래만 실행:
-- CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE,
--   password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
--   ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id);
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false,
--   ADD COLUMN IF NOT EXISTS can_use_admin_key BOOLEAN NOT NULL DEFAULT false,
--   ADD COLUMN IF NOT EXISTS gemini_key_enc TEXT;
-- UPDATE users SET is_admin = true WHERE email = 'floodchoi@gmail.com';
-- CREATE TABLE IF NOT EXISTS projects ( id SERIAL PRIMARY KEY, name TEXT NOT NULL,
--   owner_id INT REFERENCES users(id) ON DELETE CASCADE, is_shared BOOLEAN NOT NULL DEFAULT false,
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now() );
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE SET NULL;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
-- UPDATE users SET approved = true;  -- 기존 회원은 승인 상태 유지
-- (기존 회의록은 user_id가 NULL이라 목록에 안 보임 — 계정 생성 후 원하는 계정에 배정:
--  UPDATE meetings SET user_id = <내 user id> WHERE user_id IS NULL;)
