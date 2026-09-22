/**
 * Client-side auth: token storage, API helpers, and a small sign-in /
 * sign-up dialog shared by the start page and the board app.
 */
export const API = "http://localhost:1234";

export const authToken = (): string => localStorage.getItem("orim-token") ?? "guest";
export const authName = (): string | null => localStorage.getItem("orim-user");

export const authHeaders = (): Record<string, string> =>
  authToken() !== "guest" ? { Authorization: `Bearer ${authToken()}` } : {};

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function signOut(): Promise<void> {
  try {
    await api("POST", "/auth/logout");
  } catch { /* best effort */ }
  localStorage.removeItem("orim-token");
  localStorage.removeItem("orim-user");
}

/** Sign-in/sign-up dialog. Resolves with the user name, or null if closed. */
export function openAuthDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    document.getElementById("auth-dialog-backdrop")?.remove();
    const backdrop = document.createElement("div");
    backdrop.id = "auth-dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog panel" role="dialog" aria-label="Sign in">
        <h3 id="auth-title">Sign in</h3>
        <input id="auth-name" placeholder="Name" autocomplete="username" />
        <input id="auth-pass" placeholder="Password" type="password" autocomplete="current-password" />
        <div class="err" id="auth-err"></div>
        <div class="row">
          <button class="primary" id="auth-submit">Sign in</button>
          <button id="auth-cancel">Cancel</button>
        </div>
        <button class="link" id="auth-flip">New here? Create an account</button>
      </div>`;
    document.body.appendChild(backdrop);

    const $ = (id: string) => backdrop.querySelector<HTMLElement>(`#${id}`)!;
    const nameEl = $("auth-name") as HTMLInputElement;
    const passEl = $("auth-pass") as HTMLInputElement;
    let mode: "login" | "signup" = "login";

    const done = (value: string | null) => {
      backdrop.remove();
      resolve(value);
    };
    const submit = async () => {
      try {
        const out = await api<{ token: string; name: string }>(
          "POST",
          mode === "login" ? "/auth/login" : "/auth/signup",
          { name: nameEl.value, password: passEl.value },
        );
        localStorage.setItem("orim-token", out.token);
        localStorage.setItem("orim-user", out.name);
        done(out.name);
      } catch (err) {
        $("auth-err").textContent = err instanceof Error ? err.message : String(err);
      }
    };

    $("auth-submit").addEventListener("click", () => void submit());
    $("auth-cancel").addEventListener("click", () => done(null));
    $("auth-flip").addEventListener("click", () => {
      mode = mode === "login" ? "signup" : "login";
      $("auth-title").textContent = mode === "login" ? "Sign in" : "Create account";
      $("auth-submit").textContent = mode === "login" ? "Sign in" : "Sign up";
      $("auth-flip").textContent =
        mode === "login" ? "New here? Create an account" : "Have an account? Sign in";
      passEl.autocomplete = mode === "login" ? "current-password" : "new-password";
      $("auth-err").textContent = "";
    });
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    for (const el of [nameEl, passEl]) {
      el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") done(null);
      });
    }
    nameEl.focus();
  });
}
