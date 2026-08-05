# LMS platform API (Cloudflare Worker + D1 + R2)

The backend trust boundary. Static apps (Pages) never touch data directly —
they call this Worker, which scopes every query by `org_id` from the session.
See the architecture doc for the full model.

## One-time setup

Run these from **this `api/` folder** (`cd api`). You'll need the Cloudflare
CLI (`npx wrangler`) logged in (`npx wrangler login`).

```bash
# 1. Create the pooled D1 database
npx wrangler d1 create lms-pooled
#    → copy the printed database_id into wrangler.toml (database_id = "…")

# 2. Load the schema (remote = the real D1, not local)
npx wrangler d1 execute lms-pooled --file=./schema.sql --remote

# 3. Create the media bucket
npx wrangler r2 bucket create lms-media

# 4. Set secrets (never commit these)
npx wrangler secret put SESSION_SECRET   # any long random string — signs sessions
npx wrangler secret put MASTER_KEY       # bootstraps the Master

# 5. Deploy
npx wrangler deploy
```

Then `GET https://lms-api.<your-subdomain>.workers.dev/health` should return
`{ ok: true }`.

## What's here now

- `schema.sql` — the full D1 schema (organizations, accounts+roles,
  org_role_limits, courses→modules→lessons, assessments, enrollments,
  progress, submissions/grades, certificates, audit_log).
- `wrangler.toml` — Worker config with the `DB` (D1) and `MEDIA` (R2) bindings.
- `src/index.js` — the Worker skeleton: `/health`, plus the `withTenant`
  middleware and one example org-scoped route (`GET /api/courses`) showing the
  isolation + role + quota pattern.

## Next (not built yet)

- `POST /api/auth/login` — verify credentials, mint the signed `sid` session.
- The Master control-plane routes (create org, set quotas, provision admin).
- The tenant routes (members, groups, courses, assessments, enrollments,
  submissions, certificates) — porting the admin/portal/engine data calls off
  Apps Script.
- Silo routing (`DB_<slug>` bindings) for promoted orgs.

## Note on Pages

The static site deploys from the repo root via Pages; this `api/` folder is a
separate Worker deploy. If you'd rather Pages not serve these files, exclude
`api/` in the Pages project settings (or move the backend to its own repo).
