/**
 * Orim sync server — Hocuspocus WebSocket relay for Yjs docs.
 *
 * - Persists every board to SQLite (Node's built-in node:sqlite).
 * - Lightweight accounts (scrypt-hashed passwords, bearer tokens) and
 *   per-board share roles, enforced at the sync layer: viewers get
 *   read-only connections, private boards reject strangers.
 * - A minimal HTTP API for the start page and share dialog.
 */
import { existsSync, mkdirSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import * as Y from "yjs";
import { beginLogin, handleCallback, oidcConfig } from "./oidc";
import { serveStatic } from "./static";

const port = Number(process.env.PORT ?? 1234);
const dataDir = process.env.ORIM_DATA_DIR ?? new URL("../.data", import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(`${dataDir}/boards.db`);
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    name TEXT PRIMARY KEY,
    state BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS board_settings (
    board TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'link-edit',
    owner_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS board_roles (
    board TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (board, user_id)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    board TEXT,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS oidc_state (
    state TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
`);
try {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
} catch { /* column exists */ }

/** Append-only audit trail — regulated buyers ask on day one. */
const auditStmt = db.prepare(
  "INSERT INTO audit (at, user, action, board, detail) VALUES (?, ?, ?, ?, ?)",
);
function audit(user: string, action: string, board?: string | null, detail?: string): void {
  auditStmt.run(Date.now(), user, action, board?.replace(/^orim-/, "") ?? null, detail ?? null);
}

const oidc = oidcConfig();
const webDist = process.env.ORIM_WEB_DIST ?? "";
const SESSION_TTL =
  Number(process.env.ORIM_SESSION_TTL_HOURS ?? 24 * 30) * 3600_000;

/**
 * CORS allow-list. Default: same-origin only when serving the web app
 * (single-container production), open when running API-only (local dev,
 * where the Vite server is a different origin). `ORIM_CORS_ORIGINS`
 * overrides with `*` or a comma-separated origin list.
 */
const corsOrigins = (process.env.ORIM_CORS_ORIGINS ?? (webDist ? "" : "*")).trim();
const corsAllowed = corsOrigins.split(",").map((s) => s.trim()).filter(Boolean);
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!corsOrigins) return {};
  const allow = corsOrigins === "*" ? "*" : origin && corsAllowed.includes(origin) ? origin : null;
  if (!allow) return {};
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    ...(allow === "*" ? {} : { Vary: "Origin" }),
  };
}

/**
 * Per-IP fixed-window rate limit for auth endpoints (credential guessing,
 * signup spam, OIDC state churn). In-memory: resets on restart, which is
 * fine for a brute-force brake.
 */
const RATE_LIMIT = Number(process.env.ORIM_AUTH_RATE_LIMIT ?? 30);
const RATE_WINDOW_MS = 10 * 60_000;
const trustProxy = process.env.ORIM_TRUST_PROXY === "1";
const rateHits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(request: IncomingMessage): boolean {
  const fwd = trustProxy ? request.headers["x-forwarded-for"] : undefined;
  const ip =
    (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : "") ||
    request.socket?.remoteAddress ||
    "?";
  const now = Date.now();
  if (rateHits.size > 10_000) {
    for (const [k, v] of rateHits) if (now > v.resetAt) rateHits.delete(k);
  }
  let entry = rateHits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateHits.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count === RATE_LIMIT + 1) audit(ip, "auth.ratelimited");
  return entry.count > RATE_LIMIT;
}
const RATE_LIMITED_PATHS = new Set([
  "/auth/login", "/auth/signup", "/auth/oidc/login", "/auth/oidc/callback",
]);
const selectStmt = db.prepare("SELECT state FROM boards WHERE name = ?");
const upsertStmt = db.prepare(`
  INSERT INTO boards (name, state, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
`);

// --- auth --------------------------------------------------------------------

interface User { id: number; name: string }

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
};

const verifyPassword = (password: string, stored: string): boolean => {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(hash, "hex"));
};

interface SessionUser extends User { isAdmin: boolean }

function userForToken(token: string | null): SessionUser | null {
  if (!token || token === "guest") return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.is_admin AS isAdmin, s.created_at AS at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as (User & { isAdmin: number; at: number }) | undefined;
  if (!row) return null;
  if (Date.now() - row.at > SESSION_TTL) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { id: row.id, name: row.name, isAdmin: row.isAdmin === 1 };
}

function createSession(userId: number): string {
  const token = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
    .run(token, userId, Date.now());
  db.prepare("DELETE FROM sessions WHERE created_at < ?").run(Date.now() - SESSION_TTL);
  return token;
}

/** Find-or-create for SSO identities; the first user ever becomes admin. */
function upsertSsoUser(name: string): User {
  const existing = db.prepare("SELECT id, name, pass FROM users WHERE name = ?").get(name) as
    | { id: number; name: string; pass: string }
    | undefined;
  if (existing) return existing;
  const isFirst = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  db.prepare("INSERT INTO users (name, pass, created_at, is_admin) VALUES (?, 'oidc', ?, ?)")
    .run(name, Date.now(), isFirst ? 1 : 0);
  return db.prepare("SELECT id, name FROM users WHERE name = ?").get(name) as unknown as User;
}

const bearer = (request: IncomingMessage): string | null => {
  const h = request.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
};

type Role = "owner" | "editor" | "viewer" | "none";

interface Access { role: Role; mode: string; ownerName: string | null }

/** Effective access for a (possibly anonymous) user on a board doc name. */
function accessFor(board: string, user: User | null): Access {
  const settings = db
    .prepare(
      `SELECT s.mode, s.owner_id, u.name AS ownerName
       FROM board_settings s LEFT JOIN users u ON u.id = s.owner_id WHERE s.board = ?`,
    )
    .get(board) as { mode: string; owner_id: number | null; ownerName: string | null } | undefined;
  const mode = settings?.mode ?? "link-edit";
  const ownerName = settings?.ownerName ?? null;
  if (user) {
    if (settings?.owner_id === user.id) return { role: "owner", mode, ownerName };
    const grant = db
      .prepare("SELECT role FROM board_roles WHERE board = ? AND user_id = ?")
      .get(board, user.id) as { role: string } | undefined;
    if (grant) return { role: grant.role as Role, mode, ownerName };
  }
  if (mode === "link-edit") return { role: "editor", mode, ownerName };
  if (mode === "link-view") return { role: "viewer", mode, ownerName };
  return { role: "none", mode, ownerName };
}

const docName = (board: string) => (board.startsWith("orim-") ? board : `orim-${board}`);

/** Owner-or-unclaimed guard for board management operations. */
function canManage(board: string, user: User | null): boolean {
  const settings = db
    .prepare("SELECT owner_id FROM board_settings WHERE board = ?")
    .get(board) as { owner_id: number | null } | undefined;
  if (!settings || settings.owner_id === null) return true; // unclaimed: local-tool mode
  return user !== null && settings.owner_id === user.id;
}

// --- previews ----------------------------------------------------------------

/** Compact preview of a board's contents for the start page gallery. */
function previewOf(state: Uint8Array): { count: number; nodes: unknown[] } {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const nodes = [...doc.getMap("nodes").values()]
      .map((n) => (n as Y.Map<unknown>).toJSON() as Record<string, unknown>)
      .filter((n) => typeof n.x === "number");
    return {
      count: nodes.length,
      nodes: nodes.slice(0, 150).map((n) => ({
        x: n.x, y: n.y, w: n.w, h: n.h, type: n.type, color: n.color ?? null,
      })),
    };
  } catch {
    return { count: 0, nodes: [] };
  }
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (c) => {
      data += c;
      if (data.length > 64_000) reject(new Error("body too large"));
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });

// --- server ------------------------------------------------------------------

const server = new Server({
  port,

  /** Runs for every websocket connection; decides role and read-only. */
  async onAuthenticate({ token, documentName, connectionConfig }) {
    const user = userForToken(token || null);
    const access = accessFor(documentName, user);
    if (access.role === "none") {
      audit(user?.name ?? "guest", "connect.denied", documentName);
      throw new Error("This board is private.");
    }
    if (access.role === "viewer") {
      connectionConfig.readOnly = true;
    }
    audit(user?.name ?? "guest", "connect", documentName, access.role);
    return { user: user?.name ?? "guest", role: access.role };
  },

  // Minimal HTTP API for the start page and share dialog.
  async onRequest({ request, response }) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        ...corsHeaders(request.headers.origin),
      });
      response.end(JSON.stringify(body));
      // Hocuspocus contract: an EMPTY rejection short-circuits later hooks
      // and the default handler; a rejection carrying an error is rethrown.
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject();
    };
    const redirect = (location: string) => {
      response.writeHead(302, { Location: location });
      response.end();
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject();
    };

    const api =
      url.pathname.startsWith("/boards") ||
      url.pathname.startsWith("/auth") ||
      url.pathname.startsWith("/audit") ||
      url.pathname.startsWith("/admin/");
    if (!api) {
      // Single-container mode: serve the built web app.
      if (webDist && request.method === "GET" && serveStatic(webDist, url.pathname, response)) {
        // eslint-disable-next-line prefer-promise-reject-errors
        return Promise.reject();
      }
      return Promise.resolve();
    }
    if (request.method === "OPTIONS") return send(204, {});
    if (RATE_LIMITED_PATHS.has(url.pathname) && rateLimited(request)) {
      return send(429, { error: "Too many attempts — try again in a few minutes." });
    }

    const user = userForToken(bearer(request));

    try {
      // --- auth config & SSO ---
      if (request.method === "GET" && url.pathname === "/auth/config") {
        return send(200, {
          oidc: !!oidc,
          passwordAuth: !(oidc?.required),
          provider: oidc ? new URL(oidc.issuer).hostname : null,
        });
      }
      if (oidc && request.method === "GET" && url.pathname === "/auth/oidc/login") {
        return redirect(await beginLogin(db, oidc));
      }
      if (oidc && request.method === "GET" && url.pathname === "/auth/oidc/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return send(400, { error: "code and state required" });
        const name = await handleCallback(db, oidc, code, state);
        const account = upsertSsoUser(name);
        const token = createSession(account.id);
        audit(name, "auth.sso");
        return redirect(
          `${oidc.publicUrl}/#sso=${token}&user=${encodeURIComponent(account.name)}`,
        );
      }
      if (oidc?.required && ["/auth/signup", "/auth/login"].includes(url.pathname)) {
        return send(403, { error: "Password sign-in is disabled — use SSO." });
      }

      // --- auth ---
      if (request.method === "POST" && url.pathname === "/auth/signup") {
        const { name, password } = JSON.parse(await readBody(request)) as {
          name?: string; password?: string;
        };
        const clean = (name ?? "").trim();
        if (!/^[\w .-]{2,32}$/.test(clean) || !password || password.length < 4) {
          return send(400, { error: "Name (2–32 chars) and password (4+ chars) required." });
        }
        const isFirst =
          (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
        try {
          db.prepare("INSERT INTO users (name, pass, created_at, is_admin) VALUES (?, ?, ?, ?)")
            .run(clean, hashPassword(password), Date.now(), isFirst ? 1 : 0);
        } catch {
          return send(409, { error: "That name is taken." });
        }
        const id = (db.prepare("SELECT id FROM users WHERE name = ?").get(clean) as { id: number }).id;
        const token = createSession(id);
        audit(clean, "auth.signup", null, isFirst ? "admin" : undefined);
        return send(200, { token, name: clean });
      }
      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { name, password } = JSON.parse(await readBody(request)) as {
          name?: string; password?: string;
        };
        const row = db.prepare("SELECT id, name, pass FROM users WHERE name = ?")
          .get((name ?? "").trim()) as { id: number; name: string; pass: string } | undefined;
        if (row?.pass === "oidc") {
          return send(401, { error: "This account signs in with SSO." });
        }
        if (!row || !password || !verifyPassword(password, row.pass)) {
          audit((name ?? "?").trim(), "auth.login.failed");
          return send(401, { error: "Wrong name or password." });
        }
        const token = createSession(row.id);
        audit(row.name, "auth.login");
        return send(200, { token, name: row.name });
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const token = bearer(request);
        if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
        if (user) audit(user.name, "auth.logout");
        return send(200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/auth/me") {
        return user
          ? send(200, { name: user.name, isAdmin: user.isAdmin })
          : send(401, { error: "not signed in" });
      }

      // --- audit trail (admins only) ---
      if (request.method === "GET" && url.pathname === "/audit") {
        if (!user?.isAdmin) return send(403, { error: "admin only" });
        const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200));
        const where: string[] = [];
        const params: (string | number)[] = [];
        for (const key of ["board", "user", "action"] as const) {
          const v = url.searchParams.get(key);
          if (v) {
            where.push(`"${key}" = ?`);
            params.push(v);
          }
        }
        const before = Number(url.searchParams.get("before") ?? 0);
        if (before > 0) {
          where.push("id < ?");
          params.push(before);
        }
        const rows = db
          .prepare(
            `SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY id DESC LIMIT ?`,
          )
          .all(...params, limit);
        return send(200, rows);
      }

      // --- admin console ---
      if (url.pathname.startsWith("/admin/")) {
        if (!user?.isAdmin) return send(403, { error: "admin only" });
        const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

        if (request.method === "GET" && url.pathname === "/admin/overview") {
          return send(200, {
            users: count("SELECT COUNT(*) AS n FROM users"),
            boards: count("SELECT COUNT(*) AS n FROM boards"),
            sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE created_at > ?")
              .get(Date.now() - SESSION_TTL) as { n: number }).n,
            auditRows: count("SELECT COUNT(*) AS n FROM audit"),
          });
        }
        if (request.method === "GET" && url.pathname === "/admin/users") {
          const rows = db
            .prepare(
              `SELECT u.id, u.name, u.created_at AS createdAt,
                      u.is_admin AS isAdmin, (u.pass = 'oidc') AS sso,
                      (SELECT COUNT(*) FROM sessions s
                       WHERE s.user_id = u.id AND s.created_at > ?) AS sessions,
                      (SELECT MAX(a.at) FROM audit a WHERE a.user = u.name) AS lastActive
               FROM users u ORDER BY u.created_at`,
            )
            .all(Date.now() - SESSION_TTL) as Record<string, unknown>[];
          return send(200, rows.map((r) => ({ ...r, isAdmin: r.isAdmin === 1, sso: r.sso === 1 })));
        }

        const target = (name: string) =>
          db.prepare("SELECT id, name, is_admin AS isAdmin FROM users WHERE name = ?")
            .get(name) as { id: number; name: string; isAdmin: number } | undefined;
        const adminCount = () => count("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1");

        if (request.method === "POST" && url.pathname === "/admin/users/role") {
          const { name, isAdmin } = JSON.parse(await readBody(request)) as {
            name?: string; isAdmin?: boolean;
          };
          const t = name ? target(name) : undefined;
          if (!t) return send(404, { error: "no such user" });
          if (!isAdmin && t.isAdmin === 1 && adminCount() === 1) {
            return send(400, { error: "Orim needs at least one admin." });
          }
          db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, t.id);
          audit(user.name, isAdmin ? "admin.promote" : "admin.demote", null, t.name);
          return send(200, { ok: true });
        }
        if (request.method === "POST" && url.pathname === "/admin/users/signout") {
          const { name } = JSON.parse(await readBody(request)) as { name?: string };
          const t = name ? target(name) : undefined;
          if (!t) return send(404, { error: "no such user" });
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(t.id);
          audit(user.name, "admin.signout", null, t.name);
          return send(200, { ok: true });
        }
        if (request.method === "DELETE" && url.pathname === "/admin/users") {
          const name = url.searchParams.get("name");
          const t = name ? target(name) : undefined;
          if (!t) return send(404, { error: "no such user" });
          if (t.id === user.id) return send(400, { error: "You can't delete yourself." });
          if (t.isAdmin === 1 && adminCount() === 1) {
            return send(400, { error: "Orim needs at least one admin." });
          }
          // Their boards survive as unclaimed; access grants and sessions go.
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(t.id);
          db.prepare("DELETE FROM board_roles WHERE user_id = ?").run(t.id);
          db.prepare("UPDATE board_settings SET owner_id = NULL WHERE owner_id = ?").run(t.id);
          db.prepare("DELETE FROM users WHERE id = ?").run(t.id);
          audit(user.name, "admin.user.delete", null, t.name);
          return send(200, { ok: true });
        }
      }

      // --- boards ---
      if (request.method === "GET" && url.pathname === "/boards") {
        const rows = db
          .prepare("SELECT name, state, updated_at FROM boards ORDER BY updated_at DESC")
          .all() as { name: string; state: Uint8Array; updated_at: number }[];
        const visible = rows.filter((r) => accessFor(r.name, user).role !== "none");
        return send(200, visible.map((r) => ({
          name: r.name.replace(/^orim-/, ""),
          updatedAt: r.updated_at,
          ...previewOf(new Uint8Array(r.state)),
        })));
      }
      if (request.method === "GET" && url.pathname === "/boards/access") {
        const board = url.searchParams.get("board");
        if (!board) return send(400, { error: "board required" });
        return send(200, accessFor(docName(board), user));
      }
      if (request.method === "GET" && url.pathname === "/boards/shares") {
        const board = url.searchParams.get("board");
        if (!board || !canManage(docName(board), user)) return send(403, { error: "owner only" });
        const rows = db
          .prepare(
            `SELECT u.name, r.role FROM board_roles r JOIN users u ON u.id = r.user_id
             WHERE r.board = ?`,
          )
          .all(docName(board));
        return send(200, rows);
      }
      if (request.method === "POST" && url.pathname === "/boards/share") {
        const { board, mode } = JSON.parse(await readBody(request)) as {
          board?: string; mode?: string;
        };
        const modeVal = mode ?? "";
        if (!board || !["link-edit", "link-view", "private"].includes(modeVal)) {
          return send(400, { error: "board and valid mode required" });
        }
        if (!canManage(docName(board), user)) return send(403, { error: "owner only" });
        if (modeVal === "private" && !user) {
          return send(400, { error: "Sign in to make a board private." });
        }
        db.prepare(
          `INSERT INTO board_settings (board, mode, owner_id) VALUES (?, ?, ?)
           ON CONFLICT(board) DO UPDATE SET mode = excluded.mode,
             owner_id = COALESCE(board_settings.owner_id, excluded.owner_id)`,
        ).run(docName(board), modeVal, user?.id ?? null);
        audit(user?.name ?? "guest", "board.share", docName(board), modeVal);
        return send(200, accessFor(docName(board), user));
      }
      if (request.method === "POST" && url.pathname === "/boards/grant") {
        const { board, name, role } = JSON.parse(await readBody(request)) as {
          board?: string; name?: string; role?: string;
        };
        const roleVal = role ?? "";
        if (!board || !name || !["editor", "viewer", "none"].includes(roleVal)) {
          return send(400, { error: "board, name and role (editor/viewer/none) required" });
        }
        if (!canManage(docName(board), user)) return send(403, { error: "owner only" });
        const target = db.prepare("SELECT id FROM users WHERE name = ?").get(name.trim()) as
          | { id: number }
          | undefined;
        if (!target) return send(404, { error: `No user named "${name}".` });
        if (roleVal === "none") {
          db.prepare("DELETE FROM board_roles WHERE board = ? AND user_id = ?")
            .run(docName(board), target.id);
        } else {
          db.prepare(
            `INSERT INTO board_roles (board, user_id, role) VALUES (?, ?, ?)
             ON CONFLICT(board, user_id) DO UPDATE SET role = excluded.role`,
          ).run(docName(board), target.id, roleVal);
        }
        audit(user?.name ?? "guest", "board.grant", docName(board), `${name}=${roleVal}`);
        return send(200, { ok: true });
      }
      if (request.method === "DELETE" && url.pathname === "/boards") {
        const name = url.searchParams.get("name");
        if (!name) return send(400, { error: "name required" });
        if (!canManage(docName(name), user)) return send(403, { error: "owner only" });
        db.prepare("DELETE FROM boards WHERE name = ?").run(docName(name));
        db.prepare("DELETE FROM board_settings WHERE board = ?").run(docName(name));
        db.prepare("DELETE FROM board_roles WHERE board = ?").run(docName(name));
        audit(user?.name ?? "guest", "board.delete", docName(name));
        return send(200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/boards/rename") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return send(400, { error: "from and to required" });
        if (!canManage(docName(from), user)) return send(403, { error: "owner only" });
        if (selectStmt.get(docName(to))) return send(409, { error: "target exists" });
        db.prepare("UPDATE boards SET name = ? WHERE name = ?").run(docName(to), docName(from));
        db.prepare("UPDATE board_settings SET board = ? WHERE board = ?").run(docName(to), docName(from));
        db.prepare("UPDATE board_roles SET board = ? WHERE board = ?").run(docName(to), docName(from));
        audit(user?.name ?? "guest", "board.rename", docName(from), `-> ${to}`);
        return send(200, { ok: true });
      }
      return send(404, { error: "not found" });
    } catch (err) {
      if (err === undefined) throw err; // the empty short-circuit from send()
      return send(500, { error: err instanceof Error ? err.message : "server error" });
    }
  },

  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const row = selectStmt.get(documentName) as { state: Uint8Array } | undefined;
        return row ? new Uint8Array(row.state) : null;
      },
      store: async ({ documentName, state }) => {
        upsertStmt.run(documentName, state, Date.now());
      },
    }),
  ],
  async onConnect({ documentName }) {
    console.log(`[orim-sync] connect: ${documentName}`);
  },
});

server.listen().then(() => {
  console.log(`[orim-sync] listening on ws://localhost:${port}, data in ${dataDir}`);
});
