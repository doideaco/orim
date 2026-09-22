/**
 * Inline replacements for window.prompt/confirm/alert, which embedded
 * browsers (including the desktop app pane) silently no-op. Same visual
 * language as the auth dialog.
 */

function backdrop(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "dialog-backdrop";
  document.body.appendChild(el);
  return el;
}

export function promptDialog(opts: {
  title: string;
  placeholder?: string;
  value?: string;
  confirm?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const root = backdrop();
    root.innerHTML = `
      <div class="dialog panel" role="dialog">
        <h3></h3>
        <input id="dlg-input" />
        <div class="row">
          <button class="primary" id="dlg-ok"></button>
          <button id="dlg-cancel">Cancel</button>
        </div>
      </div>`;
    root.querySelector("h3")!.textContent = opts.title;
    const input = root.querySelector<HTMLInputElement>("#dlg-input")!;
    input.placeholder = opts.placeholder ?? "";
    input.value = opts.value ?? "";
    root.querySelector("#dlg-ok")!.textContent = opts.confirm ?? "OK";

    const done = (value: string | null) => {
      root.remove();
      resolve(value);
    };
    root.querySelector("#dlg-ok")!.addEventListener("click", () => done(input.value));
    root.querySelector("#dlg-cancel")!.addEventListener("click", () => done(null));
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) done(null);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
    input.focus();
    input.select();
  });
}

export function confirmDialog(message: string, confirmText = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    const root = backdrop();
    root.innerHTML = `
      <div class="dialog panel" role="alertdialog">
        <h3></h3>
        <div class="row">
          <button class="primary danger" id="dlg-ok"></button>
          <button id="dlg-cancel">Cancel</button>
        </div>
      </div>`;
    root.querySelector("h3")!.textContent = message;
    root.querySelector("#dlg-ok")!.textContent = confirmText;
    const done = (value: boolean) => {
      root.remove();
      resolve(value);
    };
    root.querySelector("#dlg-ok")!.addEventListener("click", () => done(true));
    root.querySelector("#dlg-cancel")!.addEventListener("click", () => done(false));
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) done(false);
    });
    (root.querySelector("#dlg-cancel") as HTMLElement).focus();
  });
}

export function noticeDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    const root = backdrop();
    root.innerHTML = `
      <div class="dialog panel" role="alertdialog">
        <h3></h3>
        <div class="row"><button class="primary" id="dlg-ok">OK</button></div>
      </div>`;
    root.querySelector("h3")!.textContent = message;
    const done = () => {
      root.remove();
      resolve();
    };
    root.querySelector("#dlg-ok")!.addEventListener("click", done);
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) done();
    });
    (root.querySelector("#dlg-ok") as HTMLElement).focus();
  });
}
