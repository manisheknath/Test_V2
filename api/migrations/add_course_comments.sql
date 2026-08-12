-- Adds the per-course discussion thread (learner "Comments" panel).
-- Run once against the live D1:
--   cd api
--   npx wrangler d1 execute lms-pooled --remote --file migrations/add_course_comments.sql
CREATE TABLE IF NOT EXISTS course_comments (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  account_id TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS course_comments_thread ON course_comments(org_id, course_id, created_at);
