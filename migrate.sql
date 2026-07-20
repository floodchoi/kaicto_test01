-- ============================================================
-- 통합 마이그레이션 — 어떤 버전의 DB든 최신 스키마로 맞춥니다.
-- Neon SQL Editor에 전체를 붙여넣고 Run. 여러 번 실행해도 안전(멱등).
-- 앱 업데이트 후 스키마 오류가 나면 이 파일을 다시 실행하세요.
-- ============================================================

-- 1) users
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_use_admin_key BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gemini_key_enc    TEXT,
  ADD COLUMN IF NOT EXISTS gemini_key2_enc   TEXT,   -- 유료(예비) 키 — 무료 한도 소진 시 자동 전환
  ADD COLUMN IF NOT EXISTS shared_model      TEXT,   -- 관리자 키 사용자에게 강제할 요약 모델
  ADD COLUMN IF NOT EXISTS shared_stt_model  TEXT,   -- 〃 전사 모델 (비우면 shared_model)
  ADD COLUMN IF NOT EXISTS last_seen_at      TIMESTAMPTZ; -- 마지막 접속(앱 로드) 시각

-- 초기 관리자 지정 (이미 가입돼 있으면 승격, 미가입이면 가입 시 자동 지정)
UPDATE users SET is_admin = true, approved = true WHERE email = 'floodchoi@gmail.com';

-- 2) 초대 코드
CREATE TABLE IF NOT EXISTS invite_codes (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  max_uses   INT NOT NULL DEFAULT 10,
  used_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) 프로젝트
CREATE TABLE IF NOT EXISTS projects (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   INT REFERENCES users(id) ON DELETE CASCADE,
  is_shared  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3-1) 프로젝트 멤버 — 지정된 회원은 프로젝트의 모든 회의록을 열람·수정 가능
CREATE TABLE IF NOT EXISTS project_members (
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- 4) meetings (원본 테이블은 초기 schema.sql로 생성돼 있다고 가정)
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE SET NULL;

-- ============================================================
-- [최초 1회만] 아래는 상황에 따라 선택 실행
-- ============================================================

-- (a) 승인제 도입 전 가입한 기존 회원을 전부 승인 상태로 (최초 1회만 — 이후엔
--     관리자 화면에서 개별 승인하므로 다시 실행하면 대기자까지 승인됩니다)
-- UPDATE users SET approved = true;

-- (b) 계정 기능 도입 전에 만든(소유자 없는) 회의록을 내 계정에 배정
-- UPDATE meetings SET user_id = (SELECT id FROM users WHERE email = '내이메일')
--   WHERE user_id IS NULL;
