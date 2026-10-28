import { html, nothing, render } from "/vendor/lit-html/lit-html.js";

export const KINDS = [
  { key: "dead_code", label: "Dead code", hint: "Unused functions, modules, routes, assets and config" },
  { key: "test_gaps", label: "Test gaps", hint: "Important code without tests, running the project's tests" },
  { key: "security", label: "Security", hint: "Secrets, injection, unsafe input, missing auth, advisories" },
];

let menuButton = null;
let menuPick = null;

function menuBox() {
  let menu = document.getElementById("scan-menu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "scan-menu";
  menu.className = "menu scan-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Scan for");
  menu.hidden = true;
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("[role=menuitem]")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeMenu(true); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  });
  document.addEventListener("click", (e) => {
    if (menu.hidden || e.target.closest("#scan-menu") || e.target.closest("button") === menuButton) return;
    closeMenu(false);
  }, true);
  window.addEventListener("resize", () => closeMenu(false));
  document.body.append(menu);
  return menu;
}

export function closeMenu(focusButton) {
  const menu = document.getElementById("scan-menu");
  if (menu) menu.hidden = true;
  if (menuButton) {
    menuButton.setAttribute("aria-expanded", "false");
    if (focusButton && menuButton.isConnected) menuButton.focus();
  }
  menuButton = null;
  menuPick = null;
}

// A Menu under the Scan button of a session card, offering the three kinds of scan.
export function toggleMenu(button, pick) {
  if (menuButton === button) { closeMenu(false); return; }
  closeMenu(false);
  const menu = menuBox();
  menuPick = pick;
  render(html`${KINDS.map((k) => html`<button type="button" role="menuitem" title=${k.hint} @click=${() => { const chosen = menuPick; closeMenu(true); chosen?.(k.key); }}>
    <span class="scan-menu-item"><span>${k.label}</span><span class="scan-menu-hint">${k.hint}</span></span>
  </button>`)}`, menu);
  menu.hidden = false;
  const r = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const below = r.bottom + 4 + menu.offsetHeight <= innerHeight - 8;
  menu.style.top = `${Math.round(below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight))}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - width, innerWidth - width - 8)))}px`;
  button.setAttribute("aria-expanded", "true");
  menuButton = button;
  menu.querySelector("[role=menuitem]").focus();
}

async function checkouts(machine, path) {
  const res = await fetch(`/machines/${encodeURIComponent(machine)}/branches?path=${encodeURIComponent(path)}`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return [
    { branch: data.current, path: "" },
    ...Object.entries(data.worktrees || {})
      .filter(([branch, at]) => branch !== data.current && at !== path)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([branch, at]) => ({ branch, path: at })),
  ];
}

// Scan a folder from the composer: pick a project, then the branch to read, from its own
// checkout or one of its worktrees, optionally a folder inside it, and the kind. The scan waits
// as a step in the conversation, like one started from a card.
export function openDialog({ state, submit }) {
  let dialog = document.getElementById("scan-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "scan-dialog";
    dialog.className = "wide";
    dialog.setAttribute("aria-labelledby", "scan-title");
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  const up = new Set((state?.machines || []).filter((m) => m.up).map((m) => m.name));
  const folders = (state?.folders || [])
    .filter((f) => up.has(f.machine) && !f.worktree)
    .sort((a, b) => Number(a.label.startsWith("/")) - Number(b.label.startsWith("/")) || a.label.localeCompare(b.label));
  const machines = [...new Set(folders.map((f) => f.machine))];
  const form = { folder: folders[0] ? `${folders[0].machine}\n${folders[0].label}` : "", branches: null, checkout: "", inside: "", kind: "security", busy: false, error: "" };
  const project = () => folders.find((f) => `${f.machine}\n${f.label}` === form.folder);
  async function pickProject(value) {
    form.folder = value;
    form.checkout = "";
    const f = project();
    form.branches = f?.branch ? [{ branch: f.branch, path: "" }] : null;
    draw();
    if (!f) return;
    try {
      const found = await checkouts(f.machine, f.path);
      if (form.folder === value) form.branches = found;
    } catch {
      if (form.folder === value && !form.branches) form.branches = [];
    }
    if (dialog.open && form.folder === value) draw();
  }
  const draw = () => render(html`<form method="dialog" class="scan-form" @submit=${go}>
    <div class="dialog-head">
      <h2 id="scan-title">Scan a folder</h2>
      <button class="btn quiet" type="button" @click=${() => dialog.close()}>Close</button>
    </div>
    ${folders.length ? html`
    <section class="step grid2">
      <label>Project<select name="folder" @change=${(ev) => pickProject(ev.target.value)}>
        ${machines.map((m) => html`<optgroup label=${m}>${folders.filter((f) => f.machine === m).map((f) => html`<option value=${`${f.machine}\n${f.label}`} ?selected=${form.folder === `${f.machine}\n${f.label}`}>${f.label}</option>`)}</optgroup>`)}
      </select></label>
      <label>Branch<select name="checkout" ?disabled=${!form.branches?.length} @change=${(ev) => { form.checkout = ev.target.value; }}>
        ${form.branches === null ? html`<option value="">Reading branches…</option>` : !form.branches.length ? html`<option value="">This checkout</option>` : form.branches.map((b) => html`<option value=${b.path} ?selected=${form.checkout === b.path}>${b.branch || "No branch"}${b.path ? " (worktree)" : ""}</option>`)}
      </select></label>
      <label class="span2">Only this folder inside it<input type="text" name="inside" .value=${form.inside} placeholder="Leave empty for all of it" autocomplete="off" autocapitalize="off" spellcheck="false" @input=${(ev) => { form.inside = ev.target.value; }}></label>
    </section>
    <section class="step">
      <h3 class="step-title">Look for</h3>
      <div class="choices">
        ${KINDS.map((k) => html`<label class="choice"><input type="radio" name="kind" value=${k.key} .checked=${form.kind === k.key} @change=${() => { form.kind = k.key; }}><span><b>${k.label}</b> <span class="muted">${k.hint}</span></span></label>`)}
      </div>
    </section>
    <p class="help">The scanner is a new session in that folder. It reads all of the code, not a branch's changes, and changes no files. You start it from the card it adds here, and its findings come back as a scan card.</p>
    ${form.error ? html`<p class="form-error" role="alert">${form.error}</p>` : nothing}
    <div class="dialog-foot">
      <button class="btn" type="button" @click=${() => dialog.close()}>Cancel</button>
      <button class="btn primary" type="submit" ?disabled=${form.busy}>${form.busy ? "Preparing…" : "Prepare scan"}</button>
    </div>` : html`<p class="help">Yardbell knows no folders on a connected machine yet. Folders appear once a machine is connected and has git checkouts under its root.</p>
    <div class="dialog-foot"><button class="btn" type="button" @click=${() => dialog.close()}>Close</button></div>`}
  </form>`, dialog);
  async function go(ev) {
    ev.preventDefault();
    const [machine, folder] = form.folder.split("\n");
    const picked = form.branches?.find((b) => b.path === form.checkout);
    form.busy = true;
    form.error = "";
    draw();
    try {
      await submit({ machine, folder, inside: form.inside.trim(), kind: form.kind, ...(picked?.path ? { path: picked.path, branch: picked.branch } : {}) });
      dialog.close();
    } catch (err) {
      form.error = err.message;
    } finally {
      form.busy = false;
      if (dialog.open) draw();
    }
  }
  draw();
  dialog.showModal();
  dialog.querySelector("select, button")?.focus();
  if (form.folder) pickProject(form.folder);
}
