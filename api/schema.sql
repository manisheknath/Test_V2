-- ============================================================
-- LMS platform — D1 (SQLite) schema
-- Source of truth: the architecture doc.
-- IDs are app-generated (crypto.randomUUID() in the Worker).
-- JSON columns are stored as text. Every org-owned table carries
-- org_id — the isolation key the Worker scopes every query by.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---- Control plane (Master) --------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,            -- portal URL / subdomain
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  isolation  TEXT NOT NULL DEFAULT 'pooled',  -- pooled | silo
  region     TEXT,                            -- data residency, e.g. 'eu'
  logo       TEXT,                            -- company logo as a data: URL (shown in org views)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master-set seat limits per role
CREATE TABLE IF NOT EXISTS org_role_limits (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role   TEXT NOT NULL,   -- admin | user_admin | coach | contributor | learner
  seats  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, role)
);

-- ---- Members -----------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES organizations(id) ON DELETE CASCADE, -- NULL only for master
  role          TEXT NOT NULL
                 CHECK (role IN ('master','admin','user_admin','coach','contributor','learner')),
  name          TEXT NOT NULL,
  email         TEXT,        -- staff sign in with this (or SSO)
  login_id      TEXT,        -- learners sign in with this
  password_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- one member per org: identifiers unique within the org
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_email ON accounts(org_id, email)    WHERE email    IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_login ON accounts(org_id, login_id) WHERE login_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS accounts_org_role  ON accounts(org_id, role);

CREATE TABLE IF NOT EXISTS groups (
  id     TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name   TEXT NOT NULL,
  UNIQUE (org_id, name)
);
CREATE TABLE IF NOT EXISTS account_groups (
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  group_id   TEXT REFERENCES groups(id)   ON DELETE CASCADE,
  PRIMARY KEY (account_id, group_id)
);

-- ---- Content: Course is the container (Training folded in) --
CREATE TABLE IF NOT EXISTS courses (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  summary    TEXT,
  category     TEXT,                          -- groups courses into shelves
  content      TEXT,                          -- rich-text body (HTML)
  presentation TEXT NOT NULL DEFAULT 'slideshow', -- slideshow | single_page
  cover_key    TEXT,                          -- -> R2 object
  status     TEXT NOT NULL DEFAULT 'published', -- draft | published | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS courses_org ON courses(org_id);

CREATE TABLE IF NOT EXISTS modules (
  id        TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position  INTEGER,
  title     TEXT
);
CREATE TABLE IF NOT EXISTS lessons (
  id         TEXT PRIMARY KEY,
  module_id  TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  position   INTEGER,
  type       TEXT,   -- video | doc | text | link
  title      TEXT,
  body       TEXT,
  media_key  TEXT    -- -> R2 object
);

CREATE TABLE IF NOT EXISTS assessments (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  course_id          TEXT REFERENCES courses(id) ON DELETE SET NULL, -- standalone or in a course
  title              TEXT NOT NULL,
  time_limit_minutes INTEGER,
  pass_score         REAL,
  status             TEXT NOT NULL DEFAULT 'draft',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS assessments_org ON assessments(org_id);

CREATE TABLE IF NOT EXISTS sections (
  id            TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position      INTEGER,
  type          TEXT,   -- reading | listening | default | coding
  title         TEXT,
  description   TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id         TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  position   INTEGER,
  type       TEXT,       -- mc | short | code | passage
  prompt     TEXT,
  options    TEXT,       -- JSON
  answer_key TEXT,       -- JSON
  points     REAL DEFAULT 1
);

-- ---- Enrollment: who gets what -----------------------------
CREATE TABLE IF NOT EXISTS enrollments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,   -- account | group
  target_id   TEXT NOT NULL,
  item_type   TEXT NOT NULL,   -- course | assessment
  item_id     TEXT NOT NULL,
  due_at      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS enrollments_org ON enrollments(org_id);

-- ---- Progress, attempts, grading, certificates -------------
CREATE TABLE IF NOT EXISTS progress (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  course_id    TEXT,
  lesson_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | complete
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  started_at    TEXT,
  submitted_at  TEXT,
  integrity     TEXT,   -- JSON: tab switches, fullscreen exits, timeline
  UNIQUE (assessment_id, account_id)
);
CREATE INDEX IF NOT EXISTS submissions_org ON submissions(org_id, account_id);

CREATE TABLE IF NOT EXISTS answers (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id   TEXT NOT NULL,
  value         TEXT,       -- JSON
  auto_score    REAL
);
CREATE TABLE IF NOT EXISTS grades (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  final_score   REAL,
  note          TEXT,
  graded_by     TEXT,
  graded_at     TEXT
);

CREATE TABLE IF NOT EXISTS certificates (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL,   -- course | assessment
  item_id    TEXT NOT NULL,
  serial     TEXT UNIQUE,
  file_key   TEXT,            -- -> R2 PDF
  issued_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Role permissions (per-org, editable capability matrix) --
-- A row (org_id, role, capability) means that role HAS that capability
-- within that org. org_id = '' is the platform-default template every
-- org inherits until it sets its own rows. Resolution order:
--   org's own rows  ->  platform template ('')  ->  built-in defaults.
CREATE TABLE IF NOT EXISTS role_permissions (
  org_id     TEXT NOT NULL DEFAULT '',   -- '' = platform template; else an org id
  role       TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (org_id, role, capability)
);

-- ---- Audit: every Master access to an org ------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,            -- who (master/admin) did it
  org_id     TEXT,            -- which org was touched
  action     TEXT NOT NULL,
  detail     TEXT,            -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
