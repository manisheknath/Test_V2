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

## Endpoints (built so far)

Auth uses a **Bearer token** (not cookies): login returns `token`; send it as
`Authorization: Bearer <token>` on every call.

| Method | Path | Who | Does |
|---|---|---|---|
| `GET`  | `/health` | public | liveness |
| `POST` | `/api/auth/login` | public | `{orgSlug?, identifier, password}` → `{token, account}` (omit `orgSlug` for Master) |
| `GET`  | `/api/auth/me` | any | current account |
| `POST` | `/api/master/bootstrap` | `x-master-key` header | one-time: create the first Master `{name,email,password}` |
| `GET`  | `/api/master/orgs` | Master | list orgs with limits + role counts |
| `POST` | `/api/master/orgs` | Master | `{name, slug, limits, admin:{name,email,password}}` → creates org, quotas, first admin |
| `PATCH`| `/api/master/orgs/:id` | Master | `{name?, slug?, status?, limits?}` |
| `DELETE`| `/api/master/orgs/:id` | Master | delete org (cascades) |
| `GET`  | `/api/courses` | any (org-scoped) | example: courses in the caller's org |

Every Master action writes to `audit_log`. Password hashing is PBKDF2
(100k rounds, per-user salt); sessions are HMAC-signed and expire in 12h.

## Quickstart flow (after setup + deploy)

```bash
API=https://lms-api.<your-subdomain>.workers.dev

# 1. Create the Master (once). MASTER_KEY is the secret you set.
curl -X POST $API/api/master/bootstrap -H "x-master-key: $MASTER_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"You","email":"you@platform.com","password":"change-me"}'

# 2. Log in as Master → grab the token
TOKEN=$(curl -s -X POST $API/api/auth/login -H "content-type: application/json" \
  -d '{"identifier":"you@platform.com","password":"change-me"}' | jq -r .token)

# 3. Create an org (+ quotas + its first admin)
curl -X POST $API/api/master/orgs -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"Acme Corp","slug":"acme",
       "limits":{"admin":2,"user_admin":2,"coach":10,"contributor":20,"learner":200},
       "admin":{"name":"Dana","email":"dana@acme.com","password":"welcome1"}}'

# 4. That admin can now log in scoped to their org
curl -X POST $API/api/auth/login -H "content-type: application/json" \
  -d '{"orgSlug":"acme","identifier":"dana@acme.com","password":"welcome1"}'
```

## Next (not built yet)

- Tenant routes: members (with quota + role rules), groups, courses,
  assessments, enrollments, submissions, certificates — porting the
  admin/portal/engine data calls off Apps Script.
- Wire the static consoles (master/admin/portal) to call this API.
- Silo routing (`DB_<slug>` bindings) for promoted orgs; SSO; per-org region.

## Note on Pages

The static site deploys from the repo root via Pages; this `api/` folder is a
separate Worker deploy. If you'd rather Pages not serve these files, exclude
`api/` in the Pages project settings (or move the backend to its own repo).
