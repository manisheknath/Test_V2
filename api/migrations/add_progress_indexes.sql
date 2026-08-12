-- Ensures the completion-tracking table exists and is fast/idempotent.
-- Run once against the live D1:
--   cd api
--   npx wrangler d1 execute lms-pooled --remote --file migrations/add_progress_indexes.sql
CREATE TABLE IF NOT EXISTS progress (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  course_id    TEXT,
  lesson_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'in_progress',
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS progress_uniq ON progress(org_id, account_id, course_id, lesson_id);
CREATE INDEX IF NOT EXISTS progress_lookup ON progress(org_id, account_id, course_id);
