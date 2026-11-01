import { html, nothing, render } from "/vendor/lit-html/lit-html.js";

const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
let data = null;
let loadError = "";
let busy = "";
let draw = null;
let opened = null;

function toast(message, kind = "error") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 6000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("logged out"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

const WORDS = { installed: "Installed", not_installed: "Not installed", needs_node: "Needs Node 18 or later", offline: "Did not answer" };
const TONES = { installed: "ok", not_installed: "", needs_node: "warn", offline: "bad" };

function ready() {
  return (data?.machines || []).filter((m) => m.state === "installed" && m.folders.length);
}

function viewUrl(d) {
  const q = new URLSearchParams({ machine: d.machine, folder: d.folder, dir: d.dir, file: d.file });
  return `/diagrams/view?${q}`;
}

function when(seconds) {
  return new Date(seconds * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function title(d) {
  return d.dir.replace(/-\d{8}-\d{6}$/, "").replace(/[-_]+/g, " ");
}

async function act(key, work) {
  busy = key;
  draw_();
  try {
    await work();
  } catch (err) {
    toast(err.message);
  } finally {
    busy = "";
    await load();
  }
}

function install(m) {
  return act(`install:${m.name}`, async () => {
    await api("POST", "/api/diagrams/install", { machine: m.name });
    toast(`Archify ${data.version} is installed on ${m.name}.`, "ok");
  });
}

async function removeDiagram(d) {
  const sure = await Nav.confirm(`Delete ${title(d)}?`, `This removes its folder from .archify in ${d.folder} on ${d.machine}.`, { confirm: "Delete", danger: true });
  if (!sure) return;
  if (opened === d) closeViewer();
  await act(`delete:${d.machine}/${d.folder}/${d.dir}`, () => api("POST", "/api/diagrams/delete", { machine: d.machine, folder: d.folder, dir: d.dir }));
}

function openDraw(machine, folder) {
  const first = ready().find((m) => m.name === machine) || ready()[0];
  draw = {
    machine: first?.name || "",
    folder: folder && first?.folders.includes(folder) ? folder : first?.folders[0] || "",
    agent: data.default_agent,
    focus: "",
    error: "",
  };
  draw_();
  document.getElementById("draw-dialog")?.showModal();
}

function closeDraw() {
  document.getElementById("draw-dialog")?.close();
  draw = null;
  draw_();
}

async function submitDraw(e) {
  e.preventDefault();
  draw.error = "";
  busy = "draw";
  draw_();
  try {
    const started = await api("POST", "/api/diagrams/draw", { machine: draw.machine, folder: draw.folder, agent: draw.agent, focus: draw.focus });
    location.href = `/term/${encodeURIComponent(started.machine)}/${encodeURIComponent(started.name)}`;
  } catch (err) {
    draw.error = err.message;
    busy = "";
    draw_();
  }
}

function openViewer(d) {
  opened = d;
  history.pushState(null, "", `/diagrams?${new URLSearchParams({ machine: d.machine, folder: d.folder, dir: d.dir, file: d.file })}`);
  draw_();
}

function closeViewer() {
  opened = null;
  history.pushState(null, "", "/diagrams");
  draw_();
}

function setupRows() {
  const machines = data.machines.filter((m) => m.state !== "installed");
  if (!machines.length) return nothing;
  return html`<ul class="rows dg-setup">${machines.map((m) => html`<li class="row">
    <span class="dg-where"><strong>${m.name}</strong>
      ${m.state === "needs_node" ? html`<small>Install Node 18 or later on ${m.name}, then check again. Yardbell does not install it.</small>` : nothing}
      ${m.state === "offline" ? html`<small class="wt-error">${m.problem}</small>` : nothing}
    </span>
    <span class="pr-badge ${TONES[m.state]}">${WORDS[m.state]}</span>
    ${m.state === "not_installed"
      ? html`<button class="btn" type="button" ?disabled=${busy === `install:${m.name}`} @click=${() => install(m)}>${busy === `install:${m.name}` ? "Installing…" : "Install"}</button>`
      : html`<button class="btn quiet" type="button" @click=${load}>Check again</button>`}
  </li>`)}</ul>`;
}

function list() {
  const rows = [...data.diagrams].sort((a, b) => b.modified - a.modified);
  if (!rows.length) {
    return html`<div class="dg-empty"><p class="dg-empty-title">No diagrams yet</p>
      <p>${ready().length ? "Draw one, and an agent maps the repository with Archify. It uses that agent's tokens." : "Install Archify on a machine to draw one."}</p></div>`;
  }
  return html`<ul class="rows dg-list">${rows.map((d) => html`<li class="row">
    <span class="dg-where"><button class="link-btn dg-open" type="button" @click=${() => openViewer(d)}>${title(d)}</button>
      <small>${d.folder} on ${d.machine}, ${when(d.modified)}</small></span>
    <button class="btn" type="button" ?disabled=${!ready().some((m) => m.name === d.machine)} @click=${() => openDraw(d.machine, d.folder)}>Draw again</button>
    <button class="btn quiet danger" type="button" ?disabled=${busy === `delete:${d.machine}/${d.folder}/${d.dir}`} @click=${() => removeDiagram(d)}>Delete</button>
  </li>`)}</ul>`;
}

function drawDialog() {
  const m = draw && data.machines.find((x) => x.name === draw.machine);
  return html`<dialog class="wide dg-dialog" id="draw-dialog" aria-labelledby="draw-title" @close=${() => { draw = null; }}>
    ${draw ? html`<form @submit=${submitDraw}>
      <div class="dialog-head"><h2 id="draw-title">Draw architecture</h2></div>
      <div class="dg-fields">
        <p class="help">An agent reads the repository and draws it with Archify, in a session you can watch or stop. It uses that agent's tokens. The diagram holds what the agent read, so check it before sharing it.</p>
        <label>Machine<select .value=${draw.machine} @change=${(e) => { draw.machine = e.target.value; draw.folder = data.machines.find((x) => x.name === draw.machine).folders[0] || ""; draw_(); }}>
          ${ready().map((x) => html`<option value=${x.name} ?selected=${x.name === draw.machine}>${x.name}</option>`)}</select></label>
        <label>Folder<select .value=${draw.folder} @change=${(e) => { draw.folder = e.target.value; }}>
          ${(m?.folders || []).map((f) => html`<option value=${f} ?selected=${f === draw.folder}>${f}</option>`)}</select></label>
        <label>Agent<select .value=${draw.agent} @change=${(e) => { draw.agent = e.target.value; }}>
          ${data.agents.map((a) => html`<option value=${a.name} ?selected=${a.name === draw.agent}>${a.label}</option>`)}</select></label>
        <label>What to focus on, if anything<textarea rows="2" .value=${draw.focus} @input=${(e) => { draw.focus = e.target.value; }} placeholder="The billing flow"></textarea></label>
        ${draw.error ? html`<p class="wt-error" role="alert">${draw.error}</p>` : nothing}
      </div>
      <div class="dialog-foot"><span class="where"></span>
        <button class="btn quiet" type="button" @click=${closeDraw}>Cancel</button>
        <button class="btn primary" type="submit" ?disabled=${busy === "draw"}>${busy === "draw" ? "Starting…" : "Draw"}</button>
      </div>
    </form>` : nothing}
  </dialog>`;
}

function viewer(d) {
  return html`<header class="main-head dg-view-head">
      <button class="btn quiet" type="button" @click=${closeViewer}>Back</button>
      <h1>${title(d)}</h1><small>${d.folder} on ${d.machine}</small>
    </header>
    <iframe class="dg-frame" title=${`Diagram: ${title(d)}`} sandbox="allow-scripts allow-downloads allow-popups" src=${viewUrl(d)}></iframe>`;
}

function page() {
  if (opened) return viewer(opened);
  if (loadError && !data) return html`<header class="main-head"><h1>Diagrams</h1></header><p class="wt-error" role="alert">${loadError}</p>`;
  if (!data) return html`<header class="main-head"><h1>Diagrams</h1></header><p class="help">Asking your machines…</p>`;
  return html`<header class="main-head"><h1>Diagrams</h1>
      <button class="btn primary" type="button" id="draw-new" ?disabled=${!ready().length} @click=${() => openDraw()}>Draw architecture</button></header>
    <p class="help dg-intro">Interactive maps of your repositories, drawn with <a href="https://github.com/tt-a1i/archify" target="_blank" rel="noopener">Archify</a> ${data.version}. They are saved in each folder's <code>.archify</code>, kept out of git.</p>
    ${setupRows()}${list()}${drawDialog()}`;
}

function draw_() {
  render(page(), $("diagrams-root"));
}

async function load() {
  try {
    data = await api("GET", "/api/diagrams");
    loadError = "";
    const q = new URLSearchParams(location.search);
    if (!opened && q.get("dir")) {
      opened = data.diagrams.find((d) => d.machine === q.get("machine") && d.folder === q.get("folder") && d.dir === q.get("dir") && d.file === q.get("file")) || null;
    }
  } catch (err) {
    loadError = err.message;
  }
  if (!document.getElementById("draw-dialog")?.open) draw_();
}

addEventListener("popstate", () => {
  if (!location.search) { opened = null; draw_(); }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !opened) load();
});
draw_();
load();
