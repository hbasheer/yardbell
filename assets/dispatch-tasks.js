import { html, nothing, render } from "/vendor/lit-html/lit-html.js";

function when(stamp) {
  if (!stamp) return "Comes with Yardbell";
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "2-digit", minute: "2-digit" });
}

function diffView(parts) {
  if (!parts) return html`<p class="help">Comparing…</p>`;
  if (!parts.some((p) => p.op !== "same")) return html`<p class="help">These two versions are the same.</p>`;
  return html`<div class="th-diff" aria-label="Changes">${parts.map((p) => p.op === "add"
    ? html`<ins>${p.text}</ins>`
    : p.op === "del" ? html`<del>${p.text}</del>` : html`<span>${p.text}</span>`)}</div>`;
}

// A task's versions, newest first, with a word diff of any two and Restore, which saves the
// picked text as a new version.
export function openHistory({ name, customised, api, toast, changed }) {
  const dialog = document.createElement("dialog");
  dialog.className = "wide th-dialog";
  dialog.setAttribute("aria-labelledby", "th-title");
  document.body.append(dialog);
  const back = document.activeElement;
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  });
  const view = { history: null, from: 0, to: 0, parts: null, error: "", busy: false, customised: Boolean(customised) };

  async function compare() {
    view.parts = null;
    draw();
    const { from, to } = view;
    try {
      const out = await api("GET", `/dispatch/tasks/diff?name=${encodeURIComponent(name)}&from=${from}&to=${to}`);
      if (view.from === from && view.to === to) view.parts = out.parts;
    } catch (err) {
      view.error = err.message;
    }
    draw();
  }

  async function restore(n) {
    view.busy = true;
    view.error = "";
    draw();
    try {
      const out = await api("POST", "/dispatch/tasks/versions/restore", { name, version: n });
      changed(out.tasks);
      view.customised = Boolean(out.tasks.find((t) => t.name === name)?.customised);
      toast(n === 1 && view.history.builtin ? `Reset "${name}" to the default` : `Restored version ${n} of "${name}" as version ${out.history.current}`, "ok");
      setHistory(out.history);
    } catch (err) {
      view.error = err.message;
    }
    view.busy = false;
    draw();
    if (view.parts) compare();
  }

  function setHistory(h) {
    view.history = h;
    const ns = h.versions.map((v) => v.n);
    view.to = h.current;
    view.from = ns.length > 1 ? ns[ns.length - 2] : h.current;
  }

  function versionRow(v, h) {
    const current = v.n === h.current;
    const note = v.restored ? (v.restored === 1 && h.builtin ? "The default again" : `Restored from version ${v.restored}`) : "";
    return html`<li class="th-version ${current ? "current" : ""}">
      <div class="th-version-head">
        <strong>Version ${v.n}</strong>
        <span class="th-when">${when(v.at)}</span>
        ${current ? html`<span class="badge done">Current</span>` : nothing}
        ${note ? html`<span class="th-note">${note}</span>` : nothing}
        ${current ? nothing : html`<button class="btn quiet" type="button" ?disabled=${view.busy} @click=${() => restore(v.n)}>Restore</button>`}
      </div>
      <pre class="th-text">${v.text}</pre>
    </li>`;
  }

  function draw() {
    const h = view.history;
    const options = (selected) => h.versions.map((v) => html`<option value=${v.n} ?selected=${v.n === selected}>Version ${v.n}${v.n === h.current ? " (current)" : ""}</option>`);
    render(html`<div class="dialog-head"><h2 id="th-title">History of ${name}</h2><button class="btn quiet" type="button" @click=${() => dialog.close()}>Close</button></div>
      ${!h ? html`<p class="help th-pad">${view.error || "Loading…"}</p>` : html`
      <p class="help th-pad">Every save keeps the text before it. Restoring a version saves it again as the newest, so nothing is lost. Triggers always run the current version.</p>
      ${h.versions.length > 1 ? html`<section class="step th-compare">
        <div class="th-pick">
          <label>Compare<select aria-label="Older version" @change=${(e) => { view.from = Number(e.target.value); compare(); }}>${options(view.from)}</select></label>
          <label>with<select aria-label="Newer version" @change=${(e) => { view.to = Number(e.target.value); compare(); }}>${options(view.to)}</select></label>
        </div>
        ${diffView(view.parts)}
      </section>` : nothing}
      ${view.error ? html`<p class="form-error th-pad" role="alert">${view.error}</p>` : nothing}
      <ol class="th-list">${[...h.versions].reverse().map((v) => versionRow(v, h))}</ol>
      <div class="dialog-foot">
        <p class="where">${h.versions.length === 1 ? "One version so far." : `${h.versions.length} versions kept.`}</p>
        ${h.builtin && view.customised ? html`<button class="btn" type="button" ?disabled=${view.busy} @click=${() => restore(1)}>Reset to the default</button>` : nothing}
        <button class="btn primary" type="button" @click=${() => dialog.close()}>Done</button>
      </div>`}`, dialog);
  }

  draw();
  dialog.showModal();
  api("GET", `/dispatch/tasks/history?name=${encodeURIComponent(name)}`)
    .then((h) => {
      setHistory(h);
      draw();
      if (h.versions.length > 1) compare();
      dialog.querySelector(".dialog-foot .btn.primary")?.focus();
    })
    .catch((err) => {
      view.error = err.message;
      draw();
    });
}

const PROMPT = /```prompt[^\n]*\n([\s\S]*?)```/g;

// The prompt Dispatch proposed for "Suggest a better prompt", the last fenced block marked prompt.
export function proposedPrompt(text) {
  const found = [...String(text).matchAll(PROMPT)];
  return found.length ? found[found.length - 1][1].trim() : "";
}
