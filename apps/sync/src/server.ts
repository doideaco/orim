/**
 * Orim sync server — Hocuspocus WebSocket relay for Yjs docs.
 *
 * - Persists every board to SQLite (Node's built-in node:sqlite).
 * - Lightweight accounts (scrypt-hashed passwords, bearer tokens) and
 *   per-board share roles, enforced at the sync layer: viewers get
 *   read-only connections, private boards reject strangers.
 * - A minimal HTTP API for the start page and share dialog.
 */
import { mkdirSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import * as Y from "yjs";

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
`);
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

function userForToken(token: string | null): User | null {
  if (!token || token === "guest") return null;
  const row = db
    .prepare(
      "SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
    )
    .get(token) as User | undefined;
  return row ?? null;
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
      throw new Error("This board is private.");
    }
    if (access.role === "viewer") {
      connectionConfig.readOnly = true;
    }
    return { user: user?.name ?? "guest", role: access.role };
  },

  // Minimal HTTP API for the start page and share dialog. CORS-open.
  async onRequest({ request, response }) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      response.end(JSON.stringify(body));
      // Hocuspocus contract: an EMPTY rejection short-circuits later hooks
      // and the default handler; a rejection carrying an error is rethrown.
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject();
    };
    const api = url.pathname.startsWith("/boards") || url.pathname.startsWith("/auth");
    if (!api) return Promise.resolve();
    if (request.method === "OPTIONS") return send(204, {});

    const user = userForToken(bearer(request));

    try {
      // --- auth ---
      if (request.method === "POST" && url.pathname === "/auth/signup") {
        const { name, password } = JSON.parse(await readBody(request)) as {
          name?: string; password?: string;
        };
        const clean = (name ?? "").trim();
        if (!/^[\w .-]{2,32}$/.test(clean) || !password || password.length < 4) {
          return send(400, { error: "Name (2–32 chars) and password (4+ chars) required." });
        }
        try {
          db.prepare("INSERT INTO users (name, pass, created_at) VALUES (?, ?, ?)")
            .run(clean, hashPassword(password), Date.now());
        } catch {
          return send(409, { error: "That name is taken." });
        }
        const id = (db.prepare("SELECT id FROM users WHERE name = ?").get(clean) as { id: number }).id;
        const token = randomBytes(24).toString("hex");
        db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
          .run(token, id, Date.now());
        return send(200, { token, name: clean });
      }
      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { name, password } = JSON.parse(await readBody(request)) as {
          name?: string; password?: string;
        };
        const row = db.prepare("SELECT id, name, pass FROM users WHERE name = ?")
          .get((name ?? "").trim()) as { id: number; name: string; pass: string } | undefined;
        if (!row || !password || !verifyPassword(password, row.pass)) {
          return send(401, { error: "Wrong name or password." });
        }
        const token = randomBytes(24).toString("hex");
        db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
          .run(token, row.id, Date.now());
        return send(200, { token, name: row.name });
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const token = bearer(request);
        if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
        return send(200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/auth/me") {
        return user ? send(200, { name: user.name }) : send(401, { error: "not signed in" });
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
        return send(200, { ok: true });
      }
      if (request.method === "DELETE" && url.pathname === "/boards") {
        const name = url.searchParams.get("name");
        if (!name) return send(400, { error: "name required" });
        if (!canManage(docName(name), user)) return send(403, { error: "owner only" });
        db.prepare("DELETE FROM boards WHERE name = ?").run(docName(name));
        db.prepare("DELETE FROM board_settings WHERE board = ?").run(docName(name));
        db.prepare("DELETE FROM board_roles WHERE board = ?").run(docName(name));
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
