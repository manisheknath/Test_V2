-- Learning tracks: a curriculum is an ordered set of courses, assignable like a course.
-- Run once against the live D1:
--   cd api
--   npx wrangler d1 execute lms-pooled --remote --file migrations/add_curricula.sql
CREATE TABLE IF NOT EXISTS curricula (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT,
  courses    TEXT,                                -- JSON array of course ids, ordered
  status     TEXT NOT NULL DEFAULT 'published',   -- draft | published | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS curricula_org ON curricula(org_id);
