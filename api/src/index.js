/* ============================================================
   LMS platform API — Cloudflare Worker (skeleton)
   ------------------------------------------------------------
   The ONE trust boundary. Static apps hold no DB access; they
   send a signed, org-scoped session cookie. Every data query is
   scoped by an org_id taken from that session — never from the
   request. Roles and seat quotas are checked here too.

   This is the seed: /health works, and the withTenant + scoped
   query + role-guard pattern is wired for one example route.
   Login and the full endpoint set are the next step.
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      // --- public ---
      if (path === "/health") return json({ ok: true, service: "lms-api" });

      // --- tenant-scoped API (everything under /api) ---
      if (path === "/api/courses" && request.method === "GET") {
        const ctx = await withTenant(request, env);
        return json({ ok: true, courses: await listCourses(ctx) });
      }

      // TODO: /api/auth/login, /api/members, /api/enrollments, /master/*, …
      return json({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      const status = e.status || 500;
      return json({ ok: false, error: e.code || "error", message: e.message }, status);
    }
  },
};

/* ---------- Tenant + role context ---------- */

// Resolve the caller's org + role from the SESSION, then hand back a
// db handle already pointed at the right database (pooled or siloed).
async function withTenant(request, env) {
  const session = await verifySession(request, env);          // { sub, exp }
  const me = await env.DB
    .prepare("SELECT id, org_id, role, status FROM accounts WHERE id = ?")
    .bind(session.sub).first();
  if (!me || me.status !== "active") throw httpError(401, "unauthorized");
  return { env, db: tenantDB(env, me), accountId: me.id, orgId: me.org_id, role: me.role };
}

// Pooled orgs use the shared DB; siloed orgs get their own binding.
function tenantDB(env, me) {
  // TODO: for isolation === 'silo', look up the org's slug and return
  //       env["DB_" + slug]. Pooled (default) uses the shared binding.
  return env.DB;
}

function requireRole(ctx, roles) {
  if (ctx.role === "master") return;                          // master bypasses
  if (!roles.includes(ctx.role)) throw httpError(403, "forbidden");
}

// Seat-quota guard, checked before creating a member (see architecture doc).
async function assertSeatAvailable(ctx, role) {
  const [{ used }] = (await ctx.db
    .prepare("SELECT COUNT(*) AS used FROM accounts WHERE org_id = ? AND role = ?")
    .bind(ctx.orgId, role).all()).results;
  const limit = await ctx.db
    .prepare("SELECT seats FROM org_role_limits WHERE org_id = ? AND role = ?")
    .bind(ctx.orgId, role).first();
  if (limit && used >= limit.seats) throw httpError(409, "seat_limit_reached");
}

/* ---------- Example scoped read ---------- */
// org_id is BOUND from context — the isolation guarantee in one line.
async function listCourses(ctx) {
  const { results } = await ctx.db
    .prepare("SELECT id, title, summary, status FROM courses WHERE org_id = ? AND status != 'archived' ORDER BY created_at DESC")
    .bind(ctx.orgId).all();
  return results;
}

/* ---------- Sessions (HMAC-signed, short-lived) ---------- */
// payload.base64url + "." + hmac(payload). Cookie name: "sid".
async function verifySession(request, env) {
  const sid = cookie(request, "sid");
  if (!sid) throw httpError(401, "no_session");
  const [body, sig] = sid.split(".");
  if (!body || !sig) throw httpError(401, "bad_session");
  const expected = await hmac(env.SESSION_SECRET, body);
  if (sig !== expected) throw httpError(401, "bad_signature");
  const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw httpError(401, "expired");
  return payload;                                             // { sub, org, role, exp }
}
// Used by the (upcoming) login route to mint a session.
async function signSession(env, payload) {
  const body = b64url(JSON.stringify(payload));
  return body + "." + (await hmac(env.SESSION_SECRET, body));
}

/* ---------- small helpers ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json;charset=utf-8" },
  });
}
function httpError(status, code, message) { const e = new Error(message || code); e.status = status; e.code = code; return e; }
function cookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function b64url(s) { return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(mac)));
}
