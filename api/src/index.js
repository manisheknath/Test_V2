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
      else if (path === "/api/master/admins" && m === "GET") r = await listAdmins(request, env);
      else if (path === "/api/master/admins" && m === "POST") r = await createAdmin(request, env);
      else if (path.match(/^\/api\/master\/admins\/[^/]+$/) && m === "DELETE") r = await deleteAdminAcct(request, env, path.split("/").pop());
      else if (path === "/api/master/roles" && m === "GET") r = await getRoles(request, env);
      else if (path === "/api/master/roles" && m === "PUT") r = await setRoles(request, env);

      // ---- tenant: this org's own role permissions (org admin) ----
      else if (path === "/api/roles" && m === "GET") r = await getOrgRoles(request, env);
      else if (path === "/api/roles" && m === "PUT") r = await setOrgRoles(request, env);
      else if (path === "/api/org" && m === "PATCH") r = await updateOrgSelf(request, env);

      // ---- tenant: members (User Management) ----
      else if (path === "/api/members" && m === "GET") r = await listMembers(request, env);
      else if (path === "/api/members" && m === "POST") r = await createMember(request, env);
      else if (path.match(/^\/api\/members\/[^/]+$/) && m === "PATCH") r = await updateMember(request, env, path.split("/").pop());
      else if (path.match(/^\/api\/members\/[^/]+$/) && m === "DELETE") r = await deleteMember(request, env, path.split("/").pop());

      // ---- tenant: courses (Trainings) ----
      else if (path === "/api/courses" && m === "GET") r = await listCourses(request, env);
      else if (path === "/api/courses" && m === "POST") r = await createCourse(request, env);
      else if (path.match(/^\/api\/courses\/[^/]+$/) && m === "PATCH") r = await updateCourse(request, env, path.split("/").pop());
      else if (path.match(/^\/api\/courses\/[^/]+$/) && m === "DELETE") r = await deleteCourse(request, env, path.split("/").pop());
      else if (path.match(/^\/api\/courses\/[^/]+\/file$/) && m === "PUT") r = await uploadCourseFile(request, env, path.split("/")[3]);
      else if (path.match(/^\/api\/courses\/[^/]+\/file$/) && m === "GET") r = await downloadCourseFile(request, env, path.split("/")[3]);

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
  return json({ ok: true, token, account: { ...publicAccount(acc), capabilities: await getCaps(env, acc.role, acc.org_id) }, org: await orgInfoFor(env, acc.org_id) });
}

// Org context (name, slug, logo, seat limits) — shared by login and me.
async function orgInfoFor(env, orgId) {
  if (!orgId) return null;
  const o = await env.DB.prepare("SELECT slug, name, logo FROM organizations WHERE id = ?").bind(orgId).first();
  const lims = (await env.DB.prepare("SELECT role, seats FROM org_role_limits WHERE org_id = ?").bind(orgId).all()).results;
  return { slug: o && o.slug, name: o && o.name, logo: (o && o.logo) || null, limits: lims.reduce((a, r) => ((a[r.role] = r.seats), a), {}) };
}

async function me(request, env) {
  const ctx = await auth(request, env);
  return json({ ok: true, account: { ...publicAccount(ctx.account), capabilities: ctx.caps }, org: await orgInfoFor(env, ctx.account.org_id) });
}

// Resolve the caller from the Bearer token; load their (active) account.
async function auth(request, env) {
  const token = bearer(request);
  if (!token) throw httpError(401, "no_token");
  const s = await verifySession(env, token);
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(s.sub).first();
  if (!account || account.status !== "active") throw httpError(401, "unauthorized");
  return { env, db: tenantDB(env, account), accountId: account.id, orgId: account.org_id, role: account.role, caps: await getCaps(env, account.role, account.org_id), account };
}
function requireRole(ctx, roles) { if (ctx.role !== "master" && !roles.includes(ctx.role)) throw httpError(403, "forbidden"); }
function requireMaster(ctx) { if (ctx.role !== "master") throw httpError(403, "forbidden"); }

/* ---------- Capabilities (single source of truth) ----------
   The permission matrix. The frontend maps its UI to caps(role);
   routes gate with requireCap. Keep this and the architecture doc
   in sync. */
const CAPS = { // seed defaults — used until the Master customizes a role
  master:      ["manage_platform"],
  admin:       ["manage_users", "assign_roles", "manage_groups", "manage_content", "edit_assigned_content", "enroll", "grade", "manage_org_settings", "learn"],
  user_admin:  ["manage_users", "manage_groups", "learn"],
  coach:       ["manage_content", "edit_assigned_content", "enroll", "grade", "learn"],
  contributor: ["edit_assigned_content", "learn"],
  learner:     ["learn"],
};
const ALL_CAPS = ["manage_users", "assign_roles", "manage_groups", "manage_content", "edit_assigned_content", "enroll", "grade", "manage_org_settings", "learn"];
const EDITABLE_ROLES = ["admin", "user_admin", "coach", "contributor", "learner"]; // Master edits all of these
const ORG_EDITABLE_ROLES = ["user_admin", "coach", "contributor", "learner"];      // an org edits its user roles (not admin)
const PLATFORM = ""; // role_permissions.org_id sentinel for the platform-default template
function defaultCaps(role) { return CAPS[role] || []; }

// Effective capabilities for a role in an org: the org's own override, else the
// platform-default template (org_id=''), else the built-in seed defaults.
async function getCaps(env, role, orgId) {
  if (role === "master") return CAPS.master;
  if (orgId) {
    const own = (await env.DB.prepare("SELECT capability FROM role_permissions WHERE org_id = ? AND role = ?").bind(orgId, role).all()).results;
    if (own.length) return own.map(r => r.capability);
  }
  const plat = (await env.DB.prepare("SELECT capability FROM role_permissions WHERE org_id = ? AND role = ?").bind(PLATFORM, role).all()).results;
  if (plat.length) return plat.map(r => r.capability);
  return defaultCaps(role);
}
// Read every role's effective caps for one scope (an org id, or PLATFORM).
async function rolesForScope(env, orgId, roleList) {
  const roles = {};
  for (const role of roleList) roles[role] = await getCaps(env, role, orgId);
  return roles;
}
// Replace the stored caps for the given roles within one scope.
async function writeRoles(env, orgId, wanted, allowedRoles) {
  const stmts = [];
  for (const role of Object.keys(wanted)) {
    if (!allowedRoles.includes(role)) continue;
    stmts.push(env.DB.prepare("DELETE FROM role_permissions WHERE org_id = ? AND role = ?").bind(orgId, role));
    for (const c of (wanted[role] || [])) {
      if (ALL_CAPS.includes(c)) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO role_permissions (org_id, role, capability) VALUES (?, ?, ?)").bind(orgId, role, c));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}
function requireCap(ctx, cap) { if (ctx.role !== "master" && !(ctx.caps || []).includes(cap)) throw httpError(403, "forbidden"); }
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
  const asmts = (await env.DB.prepare("SELECT org_id, COUNT(*) AS n FROM assessments GROUP BY org_id").all()).results;
  const crs = (await env.DB.prepare("SELECT org_id, COUNT(*) AS n FROM courses GROUP BY org_id").all()).results;
  const byOrg = (rows, val) => rows.reduce((a, r) => (((a[r.org_id] ||= {})[r.role] = r[val]), a), {});
  const flat = rows => rows.reduce((a, r) => ((a[r.org_id] = r.n), a), {});
  const L = byOrg(limits, "seats"), C = byOrg(counts, "n"), AS = flat(asmts), CR = flat(crs);
  return json({ ok: true, orgs: orgs.map(o => ({ ...o, limits: L[o.id] || {}, counts: C[o.id] || {}, assessments: AS[o.id] || 0, courses: CR[o.id] || 0 })) });
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

// A logo is stored inline as a data: URL (no R2 needed). Guard the size so a
// row stays small — the client downscales before upload; this is the backstop.
const MAX_LOGO_BYTES = 600000; // ~600 KB of base64 (~440 KB image)
function checkLogo(logo) {
  if (logo == null || logo === "") return null;               // clearing the logo
  if (typeof logo !== "string" || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(logo)) throw httpError(400, "bad_logo");
  if (logo.length > MAX_LOGO_BYTES) throw httpError(413, "logo_too_large");
  return logo;
}

async function updateOrg(request, env, orgId) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const { name, slug, status, limits, logo } = await body(request);
  const org = await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first();
  if (!org) throw httpError(404, "not_found");
  const sets = [], vals = [];
  if (name != null) { sets.push("name = ?"); vals.push(name); }
  if (slug != null) { sets.push("slug = ?"); vals.push(slug); }
  if (status != null) { sets.push("status = ?"); vals.push(status); }
  if (logo !== undefined) { sets.push("logo = ?"); vals.push(checkLogo(logo)); }
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

/* ---------- Master: admins across orgs ---------- */
async function listAdmins(request, env) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const { results } = await env.DB.prepare(
    "SELECT a.id, a.name, a.email, a.status, a.created_at, o.name AS org, o.slug AS org_slug " +
    "FROM accounts a JOIN organizations o ON o.id = a.org_id WHERE a.role = 'admin' ORDER BY a.created_at DESC").all();
  return json({ ok: true, admins: results });
}
async function createAdmin(request, env) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const { orgSlug, orgId, name, email, password } = await body(request);
  if (!name || !email || !password) throw httpError(400, "missing_fields");
  const org = orgId
    ? await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first()
    : await env.DB.prepare("SELECT id FROM organizations WHERE slug = ?").bind(orgSlug).first();
  if (!org) throw httpError(404, "org_not_found");
  await assertSeatAvailable({ db: env.DB }, org.id, "admin");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO accounts (id, org_id, role, name, email, password_hash) VALUES (?, ?, 'admin', ?, ?, ?)")
    .bind(id, org.id, name, email, await hashPassword(password)).run();
  await audit(env, ctx.accountId, org.id, "admin.create", { email });
  return json({ ok: true, id });
}
async function deleteAdminAcct(request, env, id) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const acc = await env.DB.prepare("SELECT org_id FROM accounts WHERE id = ? AND role = 'admin'").bind(id).first();
  if (!acc) throw httpError(404, "not_found");
  await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
  await audit(env, ctx.accountId, acc.org_id, "admin.delete", { id });
  return json({ ok: true });
}

/* ---------- Tenant: courses (Trainings) ----------
   Org-scoped content. Gated by manage_content (admin, coach). Categories are
   just a text field on each course — the client derives the list from them. */
async function listCourses(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_content");
  const { results } = await ctx.db
    .prepare("SELECT id, title, summary, category, file_name, status, created_at FROM courses WHERE org_id = ? AND status != 'archived' ORDER BY created_at DESC")
    .bind(ctx.orgId).all();
  return json({ ok: true, courses: results.map(c => ({
    id: c.id, title: c.title, summary: c.summary || "", category: c.category || "",
    fileName: c.file_name || null, status: c.status, updatedAt: (c.created_at || "").slice(0, 10),
  })) });
}
async function createCourse(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_content");
  const b = await body(request);
  if (!b.title) throw httpError(400, "title_required");
  const id = crypto.randomUUID();
  await ctx.db.prepare("INSERT INTO courses (id, org_id, title, summary, category, file_name, status) VALUES (?, ?, ?, ?, ?, ?, 'published')")
    .bind(id, ctx.orgId, b.title, b.summary || null, b.category || null, b.fileName || null).run();
  await audit(env, ctx.accountId, ctx.orgId, "course.create", { title: b.title });
  return json({ ok: true, id });
}
async function updateCourse(request, env, id) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_content");
  const b = await body(request);
  if (!(await ctx.db.prepare("SELECT id FROM courses WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).first())) throw httpError(404, "not_found");
  const sets = [], vals = [];
  if (b.title != null) { sets.push("title = ?"); vals.push(b.title); }
  if (b.summary != null) { sets.push("summary = ?"); vals.push(b.summary || null); }
  if (b.category != null) { sets.push("category = ?"); vals.push(b.category || null); }
  if (b.fileName !== undefined) { sets.push("file_name = ?"); vals.push(b.fileName || null); }
  if (sets.length) await ctx.db.prepare(`UPDATE courses SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`).bind(...vals, id, ctx.orgId).run();
  return json({ ok: true });
}
async function deleteCourse(request, env, id) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_content");
  const c = await ctx.db.prepare("SELECT file_key FROM courses WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).first();
  if (!c) throw httpError(404, "not_found");
  if (c.file_key && env.MEDIA) await env.MEDIA.delete(c.file_key);
  await ctx.db.prepare("DELETE FROM courses WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).run();
  return json({ ok: true });
}

/* Course file (R2). Objects are keyed by org id so the Worker is the only way
   in — a caller can only reach files under their own org. One file per course. */
async function uploadCourseFile(request, env, id) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_content");
  if (!env.MEDIA) throw httpError(503, "storage_unavailable");
  if (!(await ctx.db.prepare("SELECT id FROM courses WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).first())) throw httpError(404, "not_found");
  const name = (new URL(request.url).searchParams.get("name") || "file").slice(0, 200);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const key = "courses/" + ctx.orgId + "/" + id;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType }, customMetadata: { name, org: ctx.orgId } });
  await ctx.db.prepare("UPDATE courses SET file_key = ?, file_name = ? WHERE id = ? AND org_id = ?").bind(key, name, id, ctx.orgId).run();
  await audit(env, ctx.accountId, ctx.orgId, "course.file.upload", { id, name });
  return json({ ok: true, fileName: name });
}
async function downloadCourseFile(request, env, id) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_content");
  if (!env.MEDIA) throw httpError(503, "storage_unavailable");
  const c = await ctx.db.prepare("SELECT file_key, file_name FROM courses WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).first();
  if (!c || !c.file_key) throw httpError(404, "no_file");
  const obj = await env.MEDIA.get(c.file_key);
  if (!obj) throw httpError(404, "no_file");
  const h = new Headers();
  h.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream");
  h.set("content-disposition", 'attachment; filename="' + String(c.file_name || "file").replace(/["\r\n]/g, "") + '"');
  return new Response(obj.body, { headers: h });
}

/* ---------- Master: role permissions per scope ----------
   Scope = a specific org id, or PLATFORM ('') for the template that
   every org inherits until it sets its own. Master edits all roles. */
async function getRoles(request, env) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const org = new URL(request.url).searchParams.get("org") || PLATFORM;
  const roles = await rolesForScope(env, org, EDITABLE_ROLES);
  return json({ ok: true, scope: org, roles, allCaps: ALL_CAPS });
}
async function setRoles(request, env) {
  const ctx = await auth(request, env); requireMaster(ctx);
  const b = await body(request);
  const org = b.orgId || PLATFORM;
  if (org !== PLATFORM && !(await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(org).first())) throw httpError(404, "org_not_found");
  await writeRoles(env, org, b.roles || {}, EDITABLE_ROLES);
  await audit(env, ctx.accountId, org || null, "roles.update", { scope: org || "platform", roles: Object.keys(b.roles || {}) });
  return json({ ok: true });
}

/* ---------- Tenant: an org configures its own user roles ----------
   Gated by manage_org_settings. Only the user roles are editable here;
   the Admin role is platform-controlled (prevents self-lockout). */
async function getOrgRoles(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_org_settings");
  if (!ctx.orgId) throw httpError(400, "no_org");
  const roles = await rolesForScope(env, ctx.orgId, ORG_EDITABLE_ROLES);
  return json({ ok: true, roles, adminCaps: await getCaps(env, "admin", ctx.orgId), editableRoles: ORG_EDITABLE_ROLES, allCaps: ALL_CAPS });
}
async function setOrgRoles(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_org_settings");
  if (!ctx.orgId) throw httpError(400, "no_org");
  await writeRoles(env, ctx.orgId, (await body(request)).roles || {}, ORG_EDITABLE_ROLES);
  await audit(env, ctx.accountId, ctx.orgId, "org_roles.update", { roles: "user roles" });
  return json({ ok: true });
}

/* ---------- Tenant: an org edits its own settings (logo, …) ---------- */
async function updateOrgSelf(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_org_settings");
  if (!ctx.orgId) throw httpError(400, "no_org");
  const b = await body(request);
  if (b.logo !== undefined) {
    await env.DB.prepare("UPDATE organizations SET logo = ? WHERE id = ?").bind(checkLogo(b.logo), ctx.orgId).run();
    await audit(env, ctx.accountId, ctx.orgId, "org.settings", { logo: b.logo ? "set" : "cleared" });
  }
  return json({ ok: true, org: await orgInfoFor(env, ctx.orgId) });
}

/* ---------- Tenant: members (User Management) ---------- */
const MEMBER_ROLES = ["learner", "coach", "contributor", "user_admin", "admin"];

async function listMembers(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_users");
  const members = (await ctx.db.prepare(
    "SELECT id, login_id, name, email, role, (password_hash IS NOT NULL) AS has_password " +
    "FROM accounts WHERE org_id = ? AND role != 'master' ORDER BY created_at DESC").bind(ctx.orgId).all()).results;
  const ag = (await ctx.db.prepare(
    "SELECT ag.account_id AS aid, g.name AS name FROM account_groups ag JOIN groups g ON g.id = ag.group_id WHERE g.org_id = ?").bind(ctx.orgId).all()).results;
  const gby = ag.reduce((a, r) => (((a[r.aid] ||= []).push(r.name)), a), {});
  return json({ ok: true, members: members.map(m => ({
    id: m.id, loginId: m.login_id, name: m.name, email: m.email, role: m.role,
    hasPassword: !!m.has_password, groups: (gby[m.id] || []).join(", "),
  })) });
}
async function createMember(request, env) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_users");
  const b = await body(request);
  const role = b.role || "learner";
  if (!b.name) throw httpError(400, "name_required");
  if (!MEMBER_ROLES.includes(role)) throw httpError(400, "bad_role");
  if (ctx.role === "user_admin" && role !== "learner") throw httpError(403, "cannot_grant_role");
  await assertSeatAvailable(ctx, ctx.orgId, role);
  const id = crypto.randomUUID();
  await ctx.db.prepare("INSERT INTO accounts (id, org_id, role, name, email, login_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ctx.orgId, role, b.name, b.email || null, (b.loginId || "").trim() || null, b.password ? await hashPassword(b.password) : null).run();
  await setMemberGroups(env, ctx.orgId, id, b.groups);
  return json({ ok: true, id });
}
async function updateMember(request, env, id) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_users");
  const b = await body(request);
  const m = await ctx.db.prepare("SELECT id, role FROM accounts WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).first();
  if (!m) throw httpError(404, "not_found");
  if (ctx.role === "user_admin" && (m.role !== "learner" || (b.role && b.role !== "learner"))) throw httpError(403, "forbidden");
  if (b.role && !MEMBER_ROLES.includes(b.role)) throw httpError(400, "bad_role");
  const sets = [], vals = [];
  if (b.name != null) { sets.push("name = ?"); vals.push(b.name); }
  if (b.email != null) { sets.push("email = ?"); vals.push(b.email || null); }
  if (b.loginId != null) { sets.push("login_id = ?"); vals.push((b.loginId || "").trim() || null); }
  if (b.role != null) { sets.push("role = ?"); vals.push(b.role); }
  if (b.password) { sets.push("password_hash = ?"); vals.push(await hashPassword(b.password)); }
  if (sets.length) await ctx.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  if (b.groups != null) await setMemberGroups(env, ctx.orgId, id, b.groups);
  return json({ ok: true });
}
async function deleteMember(request, env, id) {
  const ctx = await auth(request, env); requireCap(ctx, "manage_users");
  const m = await ctx.db.prepare("SELECT role FROM accounts WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).first();
  if (!m) throw httpError(404, "not_found");
  if (ctx.role === "user_admin" && m.role !== "learner") throw httpError(403, "forbidden");
  await ctx.db.prepare("DELETE FROM accounts WHERE id = ? AND org_id = ?").bind(id, ctx.orgId).run();
  return json({ ok: true });
}
// Reconcile a member's groups from a comma-separated list (creating groups as needed).
async function setMemberGroups(env, orgId, accountId, csv) {
  if (csv == null) return;
  const names = [...new Set(String(csv).split(",").map(s => s.trim()).filter(Boolean))];
  await env.DB.prepare("DELETE FROM account_groups WHERE account_id = ?").bind(accountId).run();
  for (const name of names) {
    let g = await env.DB.prepare("SELECT id FROM groups WHERE org_id = ? AND name = ?").bind(orgId, name).first();
    if (!g) { const gid = crypto.randomUUID(); await env.DB.prepare("INSERT INTO groups (id, org_id, name) VALUES (?, ?, ?)").bind(gid, orgId, name).run(); g = { id: gid }; }
    await env.DB.prepare("INSERT OR IGNORE INTO account_groups (account_id, group_id) VALUES (?, ?)").bind(accountId, g.id).run();
  }
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
