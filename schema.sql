-- Meeting Minutes Summarizer MVP schema
-- Neon(또는 아무 PostgreSQL) SQL 에디터에서 1회 실행

CREATE TABLE meetings (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  raw_text   TEXT NOT NULL,              -- 회의 원문 스크립트
  summary    TEXT[] NOT NULL DEFAULT '{}',  -- 3줄 요약
  agenda     JSONB  NOT NULL DEFAULT '[]',  -- [{"topic": "...", "discussion": "..."}]
  tags       TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
