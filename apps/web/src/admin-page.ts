/**
 * Admin console: instance overview, user management (roles, sessions,
 * removal), and a filterable audit-log browser. Server-enforced admin
 * gate; this page just renders what /admin/* and /audit return.
 */
import { api, authName, openAuthDialog } from "./auth";
import { confirmDialog, noticeDialog } from "./dialogs";

interface AdminUser {
  id: number;
  name: string;
  createdAt: number;
  isAdmin: boolean;
  sso: boolean;
  sessions: number;
  lastActive: number | null;
}

interface AuditRow {
  id: number;
  at: number;
  user: string;
  action: string;
  board: string | null;
  detail: string | null;
}

const fmtTime = (at: number | null): string =>
  at
    ? new Date(at).toLocaleString(undefined, {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      })
    : "—";

const cell = (text: string, className?: string): HTMLTableCellElement => {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
};

export async function renderAdminPage(): Promise<void> {
  document.title = "Orim — Admin";
  const root = document.createElement("div");
  root.id = "start";
  root.innerHTML = `
    <header>
      <img src="/orim.svg" alt="Orim" />
      <div class="header-actions">
        <span id="account-name"></span>
        <button id="back-btn">Back to boards</button>
      </div>
    </header>
    <div id="admin-root"><div class="hint">Loading…</div></div>
  `;
  document.body.replaceChildren(root);
  root.querySelector("#account-name")!.textContent = authName() ?? "";
  root.querySelector("#back-btn")!.addEventListener("click", () => {
    location.href = "/";
  });

  const main = root.querySelector<HTMLElement>("#admin-root")!;
  try {
    await render(main);
  } catch (err) {
    // Not signed in, or not an admin: offer sign-in, then explain.
    if (!authName()) {
      const name = await openAuthDialog();
      if (name) return renderAdminPage();
    }
    main.innerHTML = `<div class="hint"></div>`;
    main.querySelector(".hint")!.textContent =
      err instanceof Error && /admin/i.test(err.message)
        ? "This page is for admins — your account doesn't have admin access."
        : `Couldn't load the admin console: ${err instanceof Error ? err.message : err}`;
  }
}

async function render(main: HTMLElement): Promise<void> {
  const [overview, users] = await Promise.all([
    api<{ users: number; boards: number; sessions: number; auditRows: number }>(
      "GET", "/admin/overview",
    ),
    api<AdminUser[]>("GET", "/admin/users"),
  ]);

  main.innerHTML = `
    <section>
      <h2>Overview</h2>
      <div id="admin-stats"></div>
    </section>
    <section>
      <h2>Users</h2>
      <table class="admin-table" id="users-table">
        <thead><tr>
          <th>Name</th><th>Sign-in</th><th>Created</th><th>Last active</th>
          <th>Sessions</th><th>Role</th><th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </section>
    <section>
      <h2>Audit log</h2>
      <div class="admin-filters">
        <input id="f-user" placeholder="Filter by user" />
        <input id="f-action" placeholder="Filter by action (e.g. auth.login)" />
        <input id="f-board" placeholder="Filter by board" />
        <button id="f-apply">Apply</button>
      </div>
      <table class="admin-table" id="audit-table">
        <thead><tr>
          <th>When</th><th>User</th><th>Action</th><th>Board</th><th>Detail</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      <button id="audit-more" hidden>Load older entries</button>
    </section>
  `;

  const stats = main.querySelector<HTMLElement>("#admin-stats")!;
  for (const [label, value] of [
    ["Users", overview.users],
    ["Boards", overview.boards],
    ["Active sessions", overview.sessions],
    ["Audit events", overview.auditRows],
  ] as const) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const num = document.createElement("strong");
    num.textContent = String(value);
    const cap = document.createElement("span");
    cap.textContent = label;
    card.append(num, cap);
    stats.appendChild(card);
  }

  // --- users ---
  const tbody = main.querySelector<HTMLElement>("#users-table tbody")!;
  const me = authName();
  for (const u of users) {
    const tr = document.createElement("tr");
    tr.append(
      cell(u.name + (u.name === me ? " (you)" : "")),
      cell(u.sso ? "SSO" : "Password"),
      cell(fmtTime(u.createdAt)),
      cell(fmtTime(u.lastActive)),
      cell(String(u.sessions)),
      cell(u.isAdmin ? "Admin" : "Member", u.isAdmin ? "role-admin" : undefined),
    );
    const actions = document.createElement("td");
    actions.className = "row-actions";
    const act = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
        await render(main);
      } catch (err) {
        await noticeDialog(
          `${label} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    };
    const roleBtn = document.createElement("button");
    roleBtn.textContent = u.isAdmin ? "Demote" : "Make admin";
    roleBtn.addEventListener("click", () =>
      void act("Role change", () =>
        api("POST", "/admin/users/role", { name: u.name, isAdmin: !u.isAdmin })),
    );
    const outBtn = document.createElement("button");
    outBtn.textContent = "Sign out everywhere";
    outBtn.disabled = u.sessions === 0;
    outBtn.addEventListener("click", () =>
      void act("Sign-out", () => api("POST", "/admin/users/signout", { name: u.name })),
    );
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      void confirmDialog(
        `Delete "${u.name}"? Their boards remain (unclaimed); their access and sessions end.`,
      ).then((yes) => {
        if (yes) {
          void act("Delete", () =>
            api("DELETE", `/admin/users?name=${encodeURIComponent(u.name)}`));
        }
      });
    });
    actions.append(roleBtn, outBtn, delBtn);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }

  // --- audit log ---
  const auditBody = main.querySelector<HTMLElement>("#audit-table tbody")!;
  const moreBtn = main.querySelector<HTMLButtonElement>("#audit-more")!;
  const PAGE = 50;
  let oldestId = 0;

  const filterParams = (): string => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    for (const [key, id] of [["user", "f-user"], ["action", "f-action"], ["board", "f-board"]]) {
      const v = main.querySelector<HTMLInputElement>(`#${id}`)!.value.trim();
      if (v) params.set(key!, v);
    }
    if (oldestId) params.set("before", String(oldestId));
    return params.toString();
  };

  const loadAudit = async (append: boolean) => {
    if (!append) {
      oldestId = 0;
      auditBody.replaceChildren();
    }
    const rows = await api<AuditRow[]>("GET", `/audit?${filterParams()}`);
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.append(
        cell(fmtTime(row.at)),
        cell(row.user),
        cell(row.action, "audit-action"),
        cell(row.board ?? ""),
        cell(row.detail ?? ""),
      );
      auditBody.appendChild(tr);
    }
    if (rows.length) oldestId = rows[rows.length - 1]!.id;
    moreBtn.hidden = rows.length < PAGE;
    if (!append && !rows.length) {
      const tr = document.createElement("tr");
      tr.appendChild(cell("No matching entries.", "hint"));
      auditBody.appendChild(tr);
    }
  };

  main.querySelector("#f-apply")!.addEventListener("click", () => void loadAudit(false));
  for (const input of main.querySelectorAll<HTMLInputElement>(".admin-filters input")) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void loadAudit(false);
    });
  }
  moreBtn.addEventListener("click", () => void loadAudit(true));
  await loadAudit(false);
}
