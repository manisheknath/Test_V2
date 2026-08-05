/* ============================================================
   LMS platform API — Cloudflare Worker
   ------------------------------------------------------------
   The ONE trust boundary. Static apps hold no DB access; they
   send a signed Bearer token (Authorization: Bearer <token>).
   Every data query is scoped by an org_id taken from that token
   — never from the request. Roles + seat quotas checked here.

   Built so far: auth (login / me), and the Master control plane
   (bootstrap, org CRUD with quotas + first admin). Tenant routes
   (members, courses, …) are next.
   ============================================================ */

const ITER = 100000; // PBKDF2 rounds
const ROLES = ["admin", "user_admin", "coach", "contributor", "learner"];

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = request.method;
    try {
      let r;
      if (path === "/health") r = json({ ok: true, service: "lms-api" });

      // ---- auth ----
      else if (path === "/api/auth/login" && m === "POST") r = await login(request, env);
      else if (path === "/api/auth/me" && m === "GET") r = await me(request, env);

      // ---- Master control plane (role: master) ----
      else if (path === "/api/master/bootstrap" && m === "POST") r = await bootstrap(request, env);
      else if (path === "/api/master/orgs" && m === "GET") r = await listOrgs(request, env);
      else if (path === "/api/master/orgs" && m === "POST") r = await createOrg(request, env);
      else if (path.match(/^\/api\/master\/orgs\/[^/]+$/) && m === "PATCH") r = await updateOrg(request, env, path.split("/").pop());
      else if (path.match(/^\/api\/master\/orgs\/[^/]+$/) && m === "DELETE") r = await deleteOrg(request, env, path.split("/").pop());

      // ---- tenant (example scoped read) ----
      else if (path === "/api/courses" && m === "GET") r = await listCourses(request, env);

      else r = json({ ok: false, error: "not_found" }, 404);
      return cors(r);
    } catch (e) {
      return cors(json({ ok: false, error: e.code || "error", message: e.message }, e.status || 500));
    }
  },
};

/* ---------- Auth ---------- */

async function login(request, env) {
  const { orgSlug, identifier, password } = await body(request);
  if (!identifier || !password) throw httpError(400, "missing_credentials");
  let org = null;
  if (orgSlug) {
    org = await env.DB.prepare("SELECT id FROM organizations WHERE slug = ? AND status = 'active'").bind(orgSlug).first();
    if (!org) throw httpError(404, "org_not_found");
  }
  // Master signs in with no orgSlug; staff/learners are scoped to their org.
  const acc = org
    ? await env.DB.prepare(
        "SELECT * FROM accounts WHERE org_id = ? AND (email = ? OR login_id = ?) AND status = 'active'")
        .bind(org.id, identifier, identifier).first()
    : await env.DB.prepare(
        "SELECT * FROM accounts WHERE org_id IS NULL AND role = 'master' AND email = ? AND status = 'active'")
        .bind(identifier).first();
  if (!acc || !acc.password_hash || !(await verifyPassword(password, acc.password_hash)))
    throw httpError(401, "invalid_login");
  const token = await signSession(env, {
    sub: acc.id, org: acc.org_id, role: acc.role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12, // 12h
  });
  return json({ ok: true, token, account: publicAccount(acc) });
}

async function me(request, env) {
  const ctx = await auth(request, env);
  return json({ ok: true, account: publicAccount(ctx.account) });
}

// Resolve the caller from the Bearer token; load their (active) account.
async function auth(request, env) {
  const token = bearer(request);
  if (!token) throw httpError(401, "no_token");
  const s = await verifySession(env, token);
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(s.sub).first();
  if (!account || account.status !== "active") throw httpError(401, "unauthorized");
  return { env, db: tenantDB(env, account), accountId: account.id, orgId: account.org_id, role: account.role, account };
}
function requireRole(ctx, roles) { if (ctx.role !== "master" && !roles.includes(ctx.role)) throw httpError(403, "forbidden"); }
function requireMaster(ctx) { if (ctx.role !== "master") throw httpError(403, "forbidden"); }
function tenantDB(env, account) { return env.DB; } // TODO: silo → env["DB_"+slug]

// Seat-quota guard (before creating a member).
async function assertSeatAvailable(ctx, orgId, role) {
  const used = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE org_id = ? AND role = ?").bind(orgId, role).first()).n;
  const lim = await ctx.db.prepare("SELECT seats FROM org_role_limits WHERE org_id = ? AND role = ?").bind(orgId, role).first();
  if (lim && used >= lim.seats) throw httpError(409, "seat_limit_reached");
}

/* ---------- Master control plane ---------- */

// One-time: create the first master account. Gated by the MASTER_KEY secret.
async function bootstrap(request, env) {
  if ((request.headers.get("x-master-key") || "") !== (env.MASTER_KEY || "\0")) throw httpError(403, "forbidden");
  const existing = await env.DB.prepare("SELECT id FROM accounts WHERE role = 'master' LIMIT 1").first();
  if (existing) throw httpError(409, "master_exists");
  const { name, email, password } = await body(request);
  if (!name || !email || !password) throw httpError(400, "missing_fields");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO accounts (id, org_id, role, name, email, password_hash) VALUES (?, NULL, 'master', ?, ?, ?)")
    .bind(id, name, email, await hashPassword(password)).run();
  return json({ ok: true, id });
}

async function listOrgs(request, env) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const orgs = (await env.DB.prepare("SELECT * FROM organizations ORDER BY created_at DESC").all()).results;
  const limits = (await env.DB.prepare("SELECT org_id, role, seats FROM org_role_limits").all()).results;
  const counts = (await env.DB.prepare("SELECT org_id, role, COUNT(*) AS n FROM accounts WHERE org_id IS NOT NULL GROUP BY org_id, role").all()).results;
  const byOrg = (rows, val) => rows.reduce((a, r) => (((a[r.org_id] ||= {})[r.role] = r[val]), a), {});
  const L = byOrg(limits, "seats"), C = byOrg(counts, "n");
  return json({ ok: true, orgs: orgs.map(o => ({ ...o, limits: L[o.id] || {}, counts: C[o.id] || {} })) });
}

async function createOrg(request, env) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const { name, slug, limits = {}, admin = {} } = await body(request);
  if (!name || !slug) throw httpError(400, "missing_fields");
  if (await env.DB.prepare("SELECT id FROM organizations WHERE slug = ?").bind(slug).first()) throw httpError(409, "slug_taken");
  if (!admin.name || !admin.email || !admin.password) throw httpError(400, "admin_required");
  const orgId = crypto.randomUUID();
  const stmts = [
    env.DB.prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)").bind(orgId, slug, name),
    ...ROLES.map(role => env.DB.prepare("INSERT INTO org_role_limits (org_id, role, seats) VALUES (?, ?, ?)")
      .bind(orgId, role, Math.max(0, parseInt(limits[role], 10) || 0))),
    env.DB.prepare("INSERT INTO accounts (id, org_id, role, name, email, password_hash) VALUES (?, ?, 'admin', ?, ?, ?)")
      .bind(crypto.randomUUID(), orgId, admin.name, admin.email, await hashPassword(admin.password)),
  ];
  await env.DB.batch(stmts);
  await audit(env, ctx.accountId, orgId, "org.create", { slug });
  return json({ ok: true, id: orgId });
}

async function updateOrg(request, env, orgId) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const { name, slug, status, limits } = await body(request);
  const org = await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first();
  if (!org) throw httpError(404, "not_found");
  const sets = [], vals = [];
  if (name != null) { sets.push("name = ?"); vals.push(name); }
  if (slug != null) { sets.push("slug = ?"); vals.push(slug); }
  if (status != null) { sets.push("status = ?"); vals.push(status); }
  const stmts = [];
  if (sets.length) stmts.push(env.DB.prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, orgId));
  if (limits) for (const role of ROLES) if (limits[role] != null)
    stmts.push(env.DB.prepare("INSERT INTO org_role_limits (org_id, role, seats) VALUES (?, ?, ?) ON CONFLICT(org_id, role) DO UPDATE SET seats = excluded.seats")
      .bind(orgId, role, Math.max(0, parseInt(limits[role], 10) || 0)));
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env, ctx.accountId, orgId, "org.update", { name, slug, status, limits });
  return json({ ok: true });
}

async function deleteOrg(request, env, orgId) {
  const ctx = await auth(request, env); requireMaster(ctx);
  await env.DB.prepare("DELETE FROM organizations WHERE id = ?").bind(orgId).run(); // cascades
  await audit(env, ctx.accountId, orgId, "org.delete", {});
  return json({ ok: true });
}

/* ---------- Tenant (example) ---------- */
async function listCourses(request, env) {
  const ctx = await auth(request, env);
  const { results } = await ctx.db
    .prepare("SELECT id, title, summary, status FROM courses WHERE org_id = ? AND status != 'archived' ORDER BY created_at DESC")
    .bind(ctx.orgId).all();
  return json({ ok: true, courses: results });
}

/* ---------- Password hashing (PBKDF2) ---------- */
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, ITER);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}
async function verifyPassword(password, stored) {
  const [scheme, iter, saltB, hashB] = String(stored).split("$");
  if (scheme !== "pbkdf2") return false;
  const bits = await pbkdf2(password, unb64(saltB), parseInt(iter, 10));
  return timingSafeEqual(new Uint8Array(bits), unb64(hashB));
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

/* ---------- Sessions (HMAC-signed Bearer token) ---------- */
async function signSession(env, payload) {
  const b = b64url(JSON.stringify(payload));
  return b + "." + (await hmac(env.SESSION_SECRET, b));
}
async function verifySession(env, token) {
  const [b, sig] = String(token).split(".");
  if (!b || !sig || sig !== (await hmac(env.SESSION_SECRET, b))) throw httpError(401, "bad_token");
  const p = JSON.parse(atob(b.replace(/-/g, "+").replace(/_/g, "/")));
  if (p.exp && Date.now() / 1000 > p.exp) throw httpError(401, "expired");
  return p;
}

/* ---------- helpers ---------- */
async function audit(env, actorId, orgId, action, detail) {
  await env.DB.prepare("INSERT INTO audit_log (id, actor_id, org_id, action, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorId, orgId, action, JSON.stringify(detail || {})).run();
}
function publicAccount(a) { return { id: a.id, name: a.name, role: a.role, orgId: a.org_id, email: a.email, loginId: a.login_id }; }
async function body(request) { try { return await request.json(); } catch { return {}; } }
function bearer(request) { const h = request.headers.get("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7) : null; }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json;charset=utf-8" } }); }
function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("access-control-allow-headers", "content-type,authorization,x-master-key");
  return new Response(res.body, { status: res.status, headers: h });
}
function httpError(status, code, message) { const e = new Error(message || code); e.status = status; e.code = code; return e; }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function b64url(s) { return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(mac)));
}
