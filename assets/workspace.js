const $ = (id) => document.getElementById(id);
const STORE = "workspace.v4";
// A workspace is one folder on one machine: the same folder name on two machines is two places.
const SEP = "\t";
const phone = matchMedia("(max-width: 760px)");
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const WORD = { blocked: "blocked", done: "done", working: "working", idle: "idle" };

let state = null;
let saved = { folder: "", tabs: [], tab: 0, focus: "", hidden: [] };
const lastActivity = new Map();
const done = new Set();
const paneEls = new Map();
const starting = new Set();
const startErrors = new Map();
const missing = new Map();
// A session missing from a few checks in a row has ended; one missed check is only a hiccup.
const GONE_AFTER = 3;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const version = (server) => (server.version ? ` <a class="server-version" href="/settings#about" title="About Yardbell">v${esc(server.version)}</a>` : "");

function short(path) {
  return String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "null");
    if (raw && Array.isArray(raw.tabs)) saved = { ...saved, ...raw };
  } catch {}
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch {}
}

function keyOf(s) {
  return `${s.machine}/${s.tmux}`;
}

function sessions() {
  return (state?.sessions || []).filter((s) => s.tmux && (s.attachable || s.stale));
}

function sessionFor(key) {
  return sessions().find((s) => keyOf(s) === key);
}

function projectOf(s) {
  return `${s.machine}${SEP}${s.folder || "Other"}`;
}

function machineOf(name) {
  return name.split(SEP)[0];
}

function folderOf(name) {
  return name.split(SEP).slice(1).join(SEP) || name;
}

function spaceLabel(name) {
  return short(folderOf(name));
}

function agentLabel(name) {
  return state?.agents.find((a) => a.name === name)?.label || name;
}

function title(s) {
  const folder = short(s.folder).split("/").pop() || s.tmux;
  return s.ticket && s.ticket !== "-" ? `${s.ticket} · ${folder}` : folder;
}

function stateOf(s) {
  if (s.stale) return "";
  if (s.activity === "blocked") return "blocked";
  if (s.activity === "active") return "working";
  return done.has(keyOf(s)) ? "done" : "idle";
}

function worst(list) {
  return list.map(stateOf).filter(Boolean).sort((a, b) => RANK[a] - RANK[b])[0] || "";
}

// Layout trees: a leaf is { pane, key }, a split is { split: "row" | "col", ratio, a, b }.

function leaves(node, out = []) {
  if (!node) return out;
  if (node.split) {
    leaves(node.a, out);
    leaves(node.b, out);
  } else {
    out.push(node);
  }
  return out;
}

function parentOf(node, target, parent = null) {
  if (node === target) return parent;
  if (!node.split) return undefined;
  const left = parentOf(node.a, target, node);
  return left !== undefined ? left : parentOf(node.b, target, node);
}

// The workspace you are in is the folder of the focused session, or the one last picked.
function project() {
  const s = saved.tabs.length ? sessionFor(focusedLeaf()?.key) : null;
  return s ? projectOf(s) : saved.folder;
}

function space() {
  if (!saved.tabs.length) {
    const pane = { pane: newId(), key: null };
    saved.tabs = [{ id: newId(), name: "Agents", root: pane }];
    saved.tab = 0;
    saved.focus = pane.pane;
  }
  return saved;
}

function removeLeaf(t, leaf) {
  const parent = parentOf(t.root, leaf);
  if (!parent) return false;
  const other = parent.a === leaf ? parent.b : parent.a;
  const grand = parentOf(t.root, parent);
  if (!grand) t.root = other;
  else if (grand.a === parent) grand.a = other;
  else grand.b = other;
  return true;
}

// Takes a session's pane out of whichever tab holds it, keeping the pane itself so its terminal
// does not reconnect. A tab left with nothing in it goes too.
function detach(sp, key) {
  for (const t of sp.tabs) {
    const leaf = leaves(t.root).find((l) => l.key === key);
    if (!leaf) continue;
    if (!removeLeaf(t, leaf)) {
      const at = sp.tabs.indexOf(t);
      if (sp.tabs.length === 1) t.root = { pane: newId(), key: null };
      else {
        sp.tabs.splice(at, 1);
        if (at < sp.tab || sp.tab === sp.tabs.length) sp.tab = Math.max(0, sp.tab - 1);
      }
    }
    return leaf;
  }
  return null;
}

function tabName(sp, s) {
  const base = title(s);
  const taken = new Set(sp.tabs.map((t) => t.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

// Every running session has a place in a tab: its own, unless it was split into another one or
// its tab was closed with the session kept running.
function sync() {
  const sp = space();
  sp.hidden ||= [];
  const mine = sessions();
  const known = new Set(mine.map(keyOf));
  for (const leaf of sp.tabs.flatMap((t) => leaves(t.root))) {
    if (!leaf.key || known.has(leaf.key)) {
      missing.delete(leaf.key);
      continue;
    }
    const n = (missing.get(leaf.key) || 0) + 1;
    missing.set(leaf.key, n);
    if (n < GONE_AFTER) continue;
    missing.delete(leaf.key);
    const only = sp.tabs.length === 1 && leaves(sp.tabs[0].root).length === 1;
    detach(sp, leaf.key);
    if (only) sp.tabs[0].name = "Agents";
  }
  sp.hidden = sp.hidden.filter((k) => known.has(k));
  const placed = new Set(sp.tabs.flatMap((t) => leaves(t.root).map((l) => l.key)));
  for (const s of mine) {
    const key = keyOf(s);
    if (s.stale || placed.has(key) || sp.hidden.includes(key)) continue;
    const blank = sp.tabs.length === 1 && !leaves(sp.tabs[0].root).some((l) => l.key) ? sp.tabs[0] : null;
    if (blank) {
      leaves(blank.root)[0].key = key;
      blank.name = tabName({ tabs: [] }, s);
    } else {
      sp.tabs.push({ id: newId(), name: tabName(sp, s), root: { pane: newId(), key } });
    }
  }
  sp.tab = Math.min(sp.tab, sp.tabs.length - 1);
  const shown = leaves(sp.tabs[sp.tab].root);
  if (!shown.some((l) => l.pane === sp.focus)) sp.focus = shown[0].pane;
}

function tab() {
  const sp = space();
  sp.tab = Math.min(sp.tab, sp.tabs.length - 1);
  return sp.tabs[sp.tab];
}

function focusedLeaf() {
  const all = leaves(tab().root);
  return all.find((l) => l.pane === space().focus) || all[0];
}

function visibleKeys() {
  if (document.hidden || !saved.tabs.length) return new Set();
  const all = phone.matches ? [focusedLeaf()] : leaves(tab().root);
  return new Set(all.map((l) => l.key).filter(Boolean));
}

function trackActivity() {
  const visible = visibleKeys();
  const live = new Set();
  for (const s of sessions()) {
    if (s.stale) continue;
    const key = keyOf(s);
    live.add(key);
    const before = lastActivity.get(key);
    if (s.activity === "idle" && before && before !== "idle" && !visible.has(key)) done.add(key);
    if (s.activity !== "idle" || visible.has(key)) done.delete(key);
    lastActivity.set(key, s.activity);
  }
  for (const key of [...done]) if (!live.has(key)) done.delete(key);
}

function projects() {
  const names = [...new Set(sessions().map(projectOf))];
  if (saved.folder && !names.includes(saved.folder)) names.push(saved.folder);
  return names.filter((n) => n.includes(SEP)).sort((a, b) => machineOf(a).localeCompare(machineOf(b)) || folderOf(a).localeCompare(folderOf(b)));
}

function pullMark(p) {
  if (!p) return "";
  const { word, tone } = window.YardbellPull.status(p);
  return `<span class="ws-pr ${tone}" title="${esc(window.YardbellPull.describe(p))}" aria-label="Pull request #${esc(p.number)}, ${esc(word)}">#${esc(p.number)}</span>`;
}

function dot(st) {
  return `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;
}

// Every state the server pushes renders the sidebar, and writing the same markup again replaces
// its buttons, which drops a click that lands in between. Only a change is written.
const painted = new WeakMap();

function paint(el, markup) {
  if (painted.get(el) === markup) return;
  painted.set(el, markup);
  el.innerHTML = markup;
}

function renderSide() {
  const all = sessions().filter((s) => !s.stale);
  const counts = {};
  for (const s of all) counts[stateOf(s)] = (counts[stateOf(s)] || 0) + 1;
  const server = state.server;
  paint($("server"), server ? `<span>Running on</span> <b>${esc(server.machine)}</b> <code>${esc(server.address)}</code>${version(server)}` : "");
  const summary = ["blocked", "done", "working", "idle"]
    .filter((k) => counts[k]).map((k) => `${counts[k]} ${WORD[k]}`).join(" · ") || "No agents running";
  if ($("summary").textContent !== summary) $("summary").textContent = summary;

  const inPane = new Map(leaves(tab().root).map((l, i) => [l.key, i + 1]));
  const row = (s) => {
    const key = keyOf(s);
    const st = stateOf(s);
    const n = inPane.get(key);
    const where = n && !phone.matches ? `<span class="ws-pane-no" title="In pane ${n}">${n}</span>` : "";
    return `<li><button type="button" class="ws-item${n && key === focusedLeaf()?.key ? " current" : ""}${s.stale ? " stale" : ""}" data-key="${esc(key)}"${s.stale ? " disabled" : ""}>
      ${dot(st)}
      <span class="ws-item-main"><span class="ws-item-title">${esc(title(s))}</span><span class="ws-item-sub">${pullMark(s.pull)}${esc([agentLabel(s.agent), s.branch].filter(Boolean).join(" · "))}</span></span>
      <span class="ws-item-word ${st}">${esc(WORD[st] || "last known")}</span>${where}
    </button></li>`;
  };
  let lastMachine = "";
  const folds = foldedMachines();
  paint($("tree"), projects().map((name) => {
    const mine = sessions().filter((s) => projectOf(s) === name);
    const current = name === project();
    const machine = machineOf(name);
    const folded = folds.has(machine);
    const live = sessions().filter((s) => !s.stale && s.machine === machine).length;
    const head = machine !== lastMachine ? `<li class="ws-machine"><button type="button" class="ws-machine-btn" data-fold="${esc(machine)}" aria-expanded="${!folded}" title="${folded ? "Show" : "Hide"} the sessions on ${esc(machine)}">
      <svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/></svg><span class="ws-machine-name">${esc(machine)}</span><span class="ws-count">${live}</span>
    </button></li>` : "";
    lastMachine = machine;
    const hide = folded ? ' class="ws-folded"' : "";
    return `${head}<li${hide}><button type="button" class="ws-space${current ? " current" : ""}" data-space="${esc(name)}" title="${esc(spaceLabel(name))}"${current ? ' aria-current="true"' : ""}>
      ${dot(worst(mine))}<span class="rail-initial" aria-hidden="true">${esc(window.YardbellSide.initials(spaceLabel(name)))}</span><span class="ws-space-name">${esc(spaceLabel(name))}</span><span class="ws-count">${mine.filter((s) => !s.stale).length}</span>
    </button></li>${mine.length ? `<li${hide}><ul class="ws-terminals">${mine.map(row).join("")}</ul></li>` : ""}`;
  }).join("") || `<li class="ws-empty">No sessions running. Start one with New session.</li>`);
}

const FOLDED_KEY = "yardbell.ws.folded";

function foldedMachines() {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || "[]")); } catch { return new Set(); }
}

function fold(machine, hide) {
  const folds = foldedMachines();
  if (hide) folds.add(machine);
  else folds.delete(machine);
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folds])); } catch {}
  renderSide();
}

let renaming = null;
let tabsHtml = "";
let shownTab = null;
// Matches the fade style.css draws at an edge of the tab row, so a tab scrolled into view clears it.
const TAB_FADE = 24;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function tabState(t) {
  return worst(leaves(t.root).map((l) => sessionFor(l.key)).filter(Boolean));
}

function renderTabs() {
  if (renaming !== null) return;
  const sp = space();
  const strip = $("tabs");
  const html = sp.tabs.map((t, i) => {
    const st = tabState(t);
    const close = sp.tabs.length > 1 || leaves(t.root).some((l) => l.key) ? `<span class="ws-tab-close" data-close-tab="${i}" role="button" aria-label="Close tab ${esc(t.name)}" title="Close tab">×</span>` : "";
    return `<div class="ws-tab${i === sp.tab ? " current" : ""}" role="tab" aria-selected="${i === sp.tab}" tabindex="0" data-tab="${i}" title="${esc(t.name)}&#10;Double-click to rename, right-click for more">${st ? dot(st) : ""}<span class="ws-tab-name">${esc(t.name)}</span>${close}</div>`;
  }).join("");
  if (html !== tabsHtml) {
    const focused = strip.contains(document.activeElement) ? document.activeElement.closest("[data-tab]")?.dataset.tab : undefined;
    strip.innerHTML = html;
    tabsHtml = html;
    if (focused !== undefined && document.hasFocus()) strip.querySelector(`[data-tab="${focused}"]`)?.focus({ preventScroll: true });
  }
  markOverflow();
  const id = sp.tabs[sp.tab].id;
  if (id !== shownTab) revealTab(shownTab === null || reduceMotion.matches ? "auto" : "smooth");
  shownTab = id;
}

function revealTab(behavior = "auto") {
  const strip = $("tabs");
  const el = strip.querySelector(".ws-tab.current");
  if (!el || strip.scrollWidth <= strip.clientWidth) return;
  const box = strip.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const before = r.left - box.left - TAB_FADE;
  const after = r.right - box.right + TAB_FADE;
  if (before >= 0 && after <= 0) return;
  strip.scrollTo({ left: strip.scrollLeft + (before < 0 ? before : Math.min(after, before)), behavior });
}

function markOverflow() {
  const strip = $("tabs");
  const room = strip.scrollWidth - strip.clientWidth;
  strip.classList.toggle("more-left", room > 1 && strip.scrollLeft > 1);
  strip.classList.toggle("more-right", room > 1 && strip.scrollLeft < room - 1);
  $("tab-list").hidden = room <= 1;
}

function rects(node, box, out = { panes: [], splits: [] }) {
  if (!node.split) {
    out.panes.push({ leaf: node, box });
    return out;
  }
  const r = node.ratio;
  const [a, b] = node.split === "row"
    ? [{ ...box, w: box.w * r }, { ...box, x: box.x + box.w * r, w: box.w * (1 - r) }]
    : [{ ...box, h: box.h * r }, { ...box, y: box.y + box.h * r, h: box.h * (1 - r) }];
  out.splits.push({ node, box, at: node.split === "row" ? b.x : b.y });
  rects(node.a, a, out);
  rects(node.b, b, out);
  return out;
}

function place(el, box) {
  el.style.left = `${box.x * 100}%`;
  el.style.top = `${box.y * 100}%`;
  el.style.width = `${box.w * 100}%`;
  el.style.height = `${box.h * 100}%`;
}

function paneEl(leaf) {
  let el = paneEls.get(leaf.pane);
  if (el) return el;
  el = document.createElement("section");
  el.className = "ws-pane";
  el.dataset.pane = leaf.pane;
  el.innerHTML = `<header class="ws-pane-head">
      <span class="ws-pane-no"></span>
      <span class="ws-pane-title"></span>
      <button class="btn quiet ws-pane-btn" type="button" data-act="text" title="Show the screen as text you can select and copy">Copy text</button>
      <a class="btn quiet ws-pane-btn" data-act="full" target="_blank" rel="noopener" title="Open in its own tab">Open</a>
      <button class="btn quiet icon-btn ws-split-btn" type="button" data-act="split-row" aria-label="Split right" title="Split right (Alt+\\)"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M8 3v10"/></svg></button>
      <button class="btn quiet icon-btn ws-split-btn" type="button" data-act="split-col" aria-label="Split down" title="Split down (Alt+-)"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 8h11"/></svg></button>
      <button class="btn quiet icon-btn ws-own-btn" type="button" data-act="own-tab" aria-label="Move to its own tab" title="Move to its own tab"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg></button>
      <button class="btn quiet icon-btn" type="button" data-act="close" aria-label="Close pane" title="Close pane (Alt+X)"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </header>
    <div class="ws-pane-body"></div>`;
  $("panes").append(el);
  paneEls.set(leaf.pane, el);
  return el;
}

function home() {
  const name = project();
  if (!name) return null;
  return (state?.folders || []).find((f) => f.label === folderOf(name) && f.machine === machineOf(name));
}

function emptyPane(leaf) {
  const shown = new Set(leaves(tab().root).map((l) => l.key));
  const here = project();
  const picks = sessions().filter((s) => !s.stale && !shown.has(keyOf(s)))
    .sort((a, b) => (projectOf(b) === here) - (projectOf(a) === here));
  const where = home();
  const busy = starting.has(leaf.pane) ? " disabled" : "";
  const used = new Set([state.default_agent, ...(state.sessions || []).map((s) => s.agent), ...(state.ended || []).map((e) => e.agent)]);
  const all = state.agents || [];
  const mine = all.filter((a) => used.has(a.name)).sort((a, b) => (b.name === state.default_agent) - (a.name === state.default_agent));
  const rest = all.filter((a) => !used.has(a.name));
  const other = rest.length
    ? `<select class="ws-other" data-start-other aria-label="Start another agent"${busy}><option value="">Other agent…</option>${rest.map((a) => `<option value="${esc(a.name)}">${esc(a.label)}</option>`).join("")}</select>`
    : "";
  const start = where && all.length
    ? `<p>Start an agent in ${esc(short(where.label).split("/").pop())}:</p><div class="ws-picks">${mine.map((a, i) =>
      `<button class="btn${i === 0 ? " primary" : ""}" type="button" data-start="${esc(a.name)}"${busy}>${esc(a.label)}</button>`).join("")}${other}</div>${busy ? "<p>Starting…</p>" : ""}`
    : "";
  const list = picks.length
    ? `<p>Or open one that is running:</p><div class="ws-picks">${picks.map((s) => `<button class="btn" type="button" data-pick="${esc(keyOf(s))}">${dot(stateOf(s))}${esc(title(s))} <span>${esc(agentLabel(s.agent))}</span></button>`).join("")}</div>`
    : "";
  const failed = startErrors.get(leaf.pane);
  return `<div class="ws-pane-empty">
    <p>Nothing open in this pane.</p>${start}${failed ? `<p class="ws-pane-error" role="alert">${esc(failed)}</p>` : ""}${list}
  </div>`;
}

async function startHere(leaf, agent) {
  const where = home();
  if (!where || starting.has(leaf.pane)) return;
  starting.add(leaf.pane);
  startErrors.delete(leaf.pane);
  render();
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ machine: where.machine, folder: where.label, agent, wait: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not start the agent (${res.status})`);
    leaf.key = `${where.machine}/${data.name}`;
    starting.delete(leaf.pane);
    focusPane(leaf.pane);
    load();
  } catch (err) {
    starting.delete(leaf.pane);
    startErrors.set(leaf.pane, err.message);
    render();
  }
}

function fillPane(el, leaf, n, alone) {
  const s = leaf.key && sessionFor(leaf.key);
  el.querySelector(".ws-pane-no").textContent = n;
  el.querySelectorAll(".ws-pane-btn").forEach((b) => { b.hidden = !leaf.key; });
  el.querySelector(".ws-own-btn").hidden = !leaf.key || alone;
  const body = el.querySelector(".ws-pane-body");
  const frame = body.querySelector("iframe");
  const head = el.querySelector(".ws-pane-title");
  if (!leaf.key) {
    head.textContent = "Empty";
    const html = emptyPane(leaf);
    if (body.dataset.html !== html) {
      body.innerHTML = html;
      body.dataset.html = html;
    }
    return;
  }
  delete body.dataset.html;
  const [machine, ...rest] = leaf.key.split("/");
  const name = rest.join("/");
  const src = `/term/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`;
  head.innerHTML = s
    ? `${dot(stateOf(s))}<strong>${esc(title(s))}</strong> <span>${esc(agentLabel(s.agent))} on ${esc(machine)}</span>`
    : `<strong>${esc(name)}</strong> <span>on ${esc(machine)}</span>`;
  el.querySelector('[data-act="full"]').href = src;
  if (frame?.dataset.key === leaf.key) return;
  const next = document.createElement("iframe");
  next.dataset.key = leaf.key;
  next.title = `Terminal for ${name} on ${machine}`;
  next.src = `${src}?embed=1`;
  body.replaceChildren(next);
}

// Panes are positioned rather than nested, and never move in the DOM: moving an iframe reloads
// it, which would drop and reopen the terminal on every split or resize.
function renderPanes() {
  const sp = space();
  const keep = new Set();
  sp.tabs.forEach((t, ti) => {
    const layout = rects(t.root, { x: 0, y: 0, w: 1, h: 1 });
    layout.panes.forEach(({ leaf, box }, i) => {
      keep.add(leaf.pane);
      const el = paneEl(leaf);
      el.hidden = ti !== sp.tab || (phone.matches && leaf.pane !== focusedLeaf().pane);
      el.classList.toggle("focused", leaf.pane === sp.focus && layout.panes.length > 1);
      place(el, phone.matches ? { x: 0, y: 0, w: 1, h: 1 } : box);
      fillPane(el, leaf, i + 1, layout.panes.length === 1);
    });
  });
  for (const [id, el] of paneEls) {
    if (keep.has(id)) continue;
    el.remove();
    paneEls.delete(id);
  }
  document.querySelectorAll(".ws-divider").forEach((d) => d.remove());
  if (phone.matches) return;
  for (const { node, box, at } of rects(tab().root, { x: 0, y: 0, w: 1, h: 1 }).splits) {
    const d = document.createElement("div");
    d.className = `ws-divider ${node.split}`;
    d.setAttribute("role", "separator");
    d.setAttribute("aria-orientation", node.split === "row" ? "vertical" : "horizontal");
    place(d, node.split === "row" ? { x: at, y: box.y, w: 0, h: box.h } : { x: box.x, y: at, w: box.w, h: 0 });
    d.addEventListener("pointerdown", (e) => drag(e, node, box));
    $("panes").append(d);
  }
}

function drag(e, node, box) {
  e.preventDefault();
  const area = $("panes").getBoundingClientRect();
  $("panes").classList.add("dragging");
  const move = (ev) => {
    const at = node.split === "row" ? (ev.clientX - area.left) / area.width : (ev.clientY - area.top) / area.height;
    const ratio = node.split === "row" ? (at - box.x) / box.w : (at - box.y) / box.h;
    node.ratio = Math.min(0.9, Math.max(0.1, ratio));
    renderPanes();
  };
  const up = () => {
    $("panes").classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    save();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function render() {
  if (!state) return;
  sync();
  if (!projects().includes(saved.folder)) saved.folder = projects()[0] || "";
  save();
  renderTabs();
  renderPanes();
  renderSide();
}

function focusPane(id, { into = true } = {}) {
  const sp = space();
  if (!leaves(tab().root).some((l) => l.pane === id)) return;
  sp.focus = id;
  const leaf = focusedLeaf();
  if (leaf?.key) done.delete(leaf.key);
  save();
  render();
  if (into) paneEls.get(id)?.querySelector("iframe")?.contentWindow?.postMessage({ yardbell: "focus" }, location.origin);
}

function reveal(key) {
  const sp = space();
  const ti = sp.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === key));
  if (ti < 0) return false;
  sp.tab = ti;
  document.body.classList.remove("ws-picking");
  focusPane(leaves(sp.tabs[ti].root).find((l) => l.key === key).pane);
  return true;
}

function open(key) {
  done.delete(key);
  const sp = space();
  sp.hidden = (sp.hidden || []).filter((k) => k !== key);
  sync();
  if (reveal(key)) return;
  const all = leaves(tab().root);
  const target = [focusedLeaf(), ...all].find((l) => !l.key) || focusedLeaf();
  target.key = key;
  document.body.classList.remove("ws-picking");
  focusPane(target.pane);
}

function split(dir) {
  if (phone.matches) return;
  const leaf = focusedLeaf();
  const fresh = { pane: newId(), key: null };
  const replacement = { split: dir, ratio: 0.5, a: { ...leaf }, b: fresh };
  const t = tab();
  const parent = parentOf(t.root, leaf);
  if (t.root === leaf) t.root = replacement;
  else if (parent.a === leaf) parent.a = replacement;
  else parent.b = replacement;
  focusPane(fresh.pane);
}

function closePane(id = space().focus) {
  const t = tab();
  const leaf = leaves(t.root).find((l) => l.pane === id);
  if (!leaf) return;
  const sp = space();
  if (leaf.key) sp.hidden.push(leaf.key);
  if (removeLeaf(t, leaf)) {
    sp.focus = leaves(t.root)[0].pane;
  } else if (sp.tabs.length > 1) {
    sp.tabs.splice(sp.tab, 1);
    switchTab(Math.min(sp.tab, sp.tabs.length - 1));
    return;
  } else {
    leaf.key = null;
    if (phone.matches) document.body.classList.add("ws-picking");
  }
  save();
  render();
}

function ownTab(id) {
  const sp = space();
  const t = tab();
  const leaf = leaves(t.root).find((l) => l.pane === id);
  if (!leaf?.key || !removeLeaf(t, leaf)) return;
  const s = sessionFor(leaf.key);
  sp.tabs.splice(sp.tab + 1, 0, { id: newId(), name: s ? title(s) : leaf.key.split("/").pop(), root: leaf });
  sp.tab += 1;
  sp.focus = leaf.pane;
  save();
  render();
}

function mergeTab(from, to, dir) {
  const sp = space();
  const source = sp.tabs[from];
  const target = sp.tabs[to];
  if (!source || !target || source === target) return;
  target.root = { split: dir, ratio: 0.5, a: target.root, b: source.root };
  sp.tabs.splice(from, 1);
  sp.tab = sp.tabs.indexOf(target);
  sp.focus = leaves(source.root)[0].pane;
  save();
  render();
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}

function showMenu(rect, items, trigger = null) {
  let el = $("ws-menu");
  if (!el) {
    el = document.createElement("div");
    el.id = "ws-menu";
    el.className = "menu ws-menu";
    el.setAttribute("role", "menu");
    el.addEventListener("click", (e) => {
      const item = e.target.closest("[data-i]");
      if (!item) return;
      const run = el.actions[Number(item.dataset.i)];
      closeMenu(e.detail === 0);
      run();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = [...el.querySelectorAll("[role=menuitem]")];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
    });
    document.body.append(el);
  }
  el.trigger?.setAttribute("aria-expanded", "false");
  el.trigger = trigger;
  trigger?.setAttribute("aria-expanded", "true");
  el.actions = items.map((it) => it.run);
  el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}${it.current ? ' aria-current="true"' : ""}>${it.state ? dot(it.state) : ""}<span class="menu-label">${esc(it.label)}</span>${it.state ? `<span class="ws-item-word ${it.state}">${esc(WORD[it.state])}</span>` : ""}</button>`).join("");
  el.hidden = false;
  const width = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
  el.style.top = `${Math.min(rect.bottom + 4, innerHeight - el.offsetHeight - 8)}px`;
  (el.querySelector('[aria-current="true"]') || el.querySelector("[role=menuitem]")).focus();
}

function renameTab(i) {
  const t = space().tabs[i];
  const label = $("tabs").querySelector(`[data-tab="${i}"] .ws-tab-name`);
  if (!t || !label) return;
  renaming = i;
  const input = document.createElement("input");
  input.className = "ws-tab-input";
  input.value = t.name;
  input.setAttribute("aria-label", "Tab name");
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (keep) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (keep && name) t.name = name;
    renaming = null;
    tabsHtml = "";
    save();
    render();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

function closeMenu(refocus = false) {
  const el = $("ws-menu");
  if (!el || el.hidden) return;
  el.hidden = true;
  el.trigger?.setAttribute("aria-expanded", "false");
  if (refocus) el.trigger?.focus();
  el.trigger = null;
}

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#ws-menu") && !$("ws-menu")?.trigger?.contains(e.target)) closeMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu(Boolean($("ws-menu")?.contains(document.activeElement)));
});
window.addEventListener("resize", () => closeMenu());

function newTab() {
  if (!state) return;
  const up = (state.machines || []).filter((m) => m.up).map((m) => m.name);
  if (!up.length) { toast("No machine is connected right now"); return; }
  const where = project() ? home() : null;
  window.YardbellNewSession.open({
    machines: up,
    machine: where?.machine,
    agents: state.agents || [],
    defaultAgent: state.default_agent,
    path: where?.path,
    onError: toast,
    onStart: async (body) => {
      try {
        const res = await fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ ...body, wait: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Could not start the session (${res.status})`);
        const key = `${body.machine}/${data.name}`;
        await load();
        open(key);
      } catch (err) {
        toast(err.message);
      }
    },
  });
}

function ask(dialog) {
  return new Promise((resolve) => {
    const done = (e) => {
      const b = e.target.closest("button[value]");
      if (!b) return;
      dialog.removeEventListener("click", done);
      dialog.close();
      resolve(b.value);
    };
    dialog.addEventListener("click", done);
    dialog.addEventListener("cancel", () => resolve("cancel"), { once: true });
    dialog.showModal();
  });
}

async function closeTab(i) {
  const sp = space();
  const t = sp.tabs[i];
  if (!t) return;
  const running = leaves(t.root).map((l) => sessionFor(l.key)).filter((s) => s && !s.stale);
  if (running.length) {
    $("close-tab-title").textContent = `Close ${t.name}?`;
    $("close-tab-text").textContent = running.length === 1
      ? `${title(running[0])} is still running. Stop it, or keep it running and only close the tab?`
      : `${running.length} sessions are still running in this tab. Stop them, or keep them running and only close the tab?`;
    const them = running.length === 1 ? "it" : "them";
    $("close-tab").querySelector('[value="keep"]').textContent = `Keep ${them} running`;
    $("close-tab").querySelector('[value="stop"]').textContent = `Stop ${them}`;
    const choice = await ask($("close-tab"));
    if (choice === "cancel") return;
    if (choice === "stop") {
      for (const s of running) {
        try {
          const res = await fetch(`/sessions/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}/stop`, { method: "POST", headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not stop ${title(s)}`);
        } catch (err) {
          toast(err.message);
        }
      }
      load();
    }
  }
  const at = sp.tabs.indexOf(t);
  if (at < 0) return;
  sp.hidden.push(...leaves(t.root).map((l) => l.key).filter(Boolean));
  if (sp.tabs.length === 1) {
    t.root = { pane: newId(), key: null };
    t.name = "Agents";
  } else {
    sp.tabs.splice(at, 1);
  }
  switchTab(Math.min(sp.tab, sp.tabs.length - 1));
}

function switchTab(i) {
  const sp = space();
  sp.tab = (i + sp.tabs.length) % sp.tabs.length;
  sp.focus = leaves(tab().root)[0].pane;
  save();
  render();
}

function openSpace(name) {
  saved.folder = name;
  const first = saved.tabs.flatMap((t) => leaves(t.root)).find((l) => {
    const s = sessionFor(l.key);
    return s && projectOf(s) === name;
  });
  if (!first || !reveal(first.key)) {
    save();
    render();
  }
}

function switchSpace(step) {
  const names = projects();
  if (!names.length) return;
  const i = names.indexOf(project());
  openSpace(names[(i + step + names.length) % names.length]);
}

function shortcut(code) {
  if (/^Digit[1-9]$/.test(code)) {
    const leaf = leaves(tab().root)[Number(code.slice(5)) - 1];
    if (leaf) focusPane(leaf.pane);
  } else if (code === "Backslash") split("row");
  else if (code === "Minus") split("col");
  else if (code === "KeyX") closePane();
  else if (code === "KeyT") newTab();
  else if (code === "BracketLeft") switchTab(space().tab - 1);
  else if (code === "BracketRight") switchTab(space().tab + 1);
  else if (code === "ArrowUp") switchSpace(-1);
  else if (code === "ArrowDown") switchSpace(1);
  else return false;
  return true;
}

$("tree").addEventListener("click", (e) => {
  const folder = e.target.closest("[data-fold]");
  if (folder) {
    fold(folder.dataset.fold, folder.getAttribute("aria-expanded") === "true");
    return;
  }
  const b = e.target.closest("[data-space]");
  if (b) {
    openSpace(b.dataset.space);
    return;
  }
  const item = e.target.closest(".ws-item");
  if (item && !item.disabled) open(item.dataset.key);
});

$("tabs").addEventListener("click", (e) => {
  const close = e.target.closest("[data-close-tab]");
  if (close) {
    closeTab(Number(close.dataset.closeTab));
    return;
  }
  const t = e.target.closest("[data-tab]");
  if (!t) return;
  // Switching tabs redraws the bar, so the browser never sees a double-click on the same element.
  const i = Number(t.dataset.tab);
  const now = Date.now();
  if (lastTabClick.i === i && now - lastTabClick.at < 400) {
    lastTabClick.at = 0;
    renameTab(i);
    return;
  }
  lastTabClick.i = i;
  lastTabClick.at = now;
  if (i !== space().tab) switchTab(i);
});

const lastTabClick = { i: -1, at: 0 };

$("tabs").addEventListener("contextmenu", (e) => {
  const t = e.target.closest("[data-tab]");
  if (!t) return;
  e.preventDefault();
  const i = Number(t.dataset.tab);
  const others = phone.matches ? [] : space().tabs.flatMap((other, j) => j === i ? [] : [
    { label: `Split into ${other.name}, right`, run: () => mergeTab(i, j, "row") },
    { label: `Split into ${other.name}, below`, run: () => mergeTab(i, j, "col") },
  ]);
  showMenu({ right: e.clientX + 200, bottom: e.clientY }, [
    ...others,
    { label: "Rename tab", run: () => renameTab(i) },
    { label: "Close tab", danger: true, run: () => closeTab(i) },
  ]);
});

$("tabs").addEventListener("keydown", (e) => {
  const t = e.target.closest("[data-tab]");
  if (!t || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  const i = Number(t.dataset.tab);
  if (i !== space().tab) switchTab(i);
});

$("tabs").addEventListener("wheel", (e) => {
  const strip = $("tabs");
  if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || strip.scrollWidth <= strip.clientWidth) return;
  e.preventDefault();
  strip.scrollLeft += e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1);
}, { passive: false });

$("tabs").addEventListener("scroll", markOverflow, { passive: true });

new ResizeObserver(() => {
  markOverflow();
  revealTab();
}).observe($("tabs").parentElement);

$("tab-list").addEventListener("click", (e) => {
  const button = e.currentTarget;
  if ($("ws-menu")?.trigger === button) {
    closeMenu();
    return;
  }
  const sp = space();
  showMenu(button.getBoundingClientRect(), sp.tabs.map((t, i) => ({
    label: t.name,
    state: tabState(t),
    current: i === sp.tab,
    run: () => { if (i !== space().tab) switchTab(i); },
  })), button);
});

$("new-tab").addEventListener("click", newTab);
$("side-new").addEventListener("click", newTab);

$("panes").addEventListener("click", (e) => {
  const pane = e.target.closest(".ws-pane");
  if (!pane) return;
  const id = pane.dataset.pane;
  const act = e.target.closest("[data-act]")?.dataset.act;
  const leaf = leaves(tab().root).find((l) => l.pane === id);
  const pick = e.target.closest("[data-pick]")?.dataset.pick;
  if (pick && leaf) {
    detach(space(), pick);
    leaf.key = pick;
    done.delete(pick);
    focusPane(id);
  } else if (e.target.closest("[data-start]") && leaf) startHere(leaf, e.target.closest("[data-start]").dataset.start);
  else if (act === "close") closePane(id);
  else if (act === "own-tab") ownTab(id);
  else if (act === "split-row" || act === "split-col") {
    space().focus = id;
    split(act === "split-row" ? "row" : "col");
  } else if (act === "text") {
    pane.querySelector("iframe")?.contentWindow?.postMessage({ yardbell: "text" }, location.origin);
  } else if (act !== "full") {
    focusPane(id);
  }
});

$("panes").addEventListener("change", (e) => {
  const select = e.target.closest("[data-start-other]");
  const pane = e.target.closest(".ws-pane");
  const leaf = pane && leaves(tab().root).find((l) => l.pane === pane.dataset.pane);
  if (select?.value && leaf) startHere(leaf, select.value);
});

$("back").addEventListener("click", () => {
  document.body.classList.add("ws-picking");
  render();
});

$("keys-btn").addEventListener("click", () => $("keys").showModal());
$("keys-close").addEventListener("click", () => $("keys").close());

window.addEventListener("yardbell-app", (e) => {
  document.querySelectorAll(".ws-pane iframe").forEach((f) => f.contentWindow?.postMessage({ yardbell: "app", state: e.detail }, location.origin));
});

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.yardbell === "key") shortcut(e.data.code);
  if (e.data?.yardbell !== "focused") return;
  for (const [id, el] of paneEls) {
    if (el.querySelector("iframe")?.contentWindow === e.source && id !== space().focus) focusPane(id, { into: false });
  }
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (shortcut(e.code)) e.preventDefault();
});

phone.addEventListener("change", render);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  trackActivity();
  render();
});

async function load() {
  try {
    const res = await fetch("/state", { headers: { Accept: "application/json" } });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) return;
    state = await res.json();
    trackActivity();
    render();
  } catch {}
}

restore();
if (phone.matches) document.body.classList.add("ws-picking");
load();
window.YardbellLive.follow(load, 3000);

const DISPATCH_KEY = "yardbell.dispatch";

function dispatchShown() {
  try { return localStorage.getItem(DISPATCH_KEY) !== "closed"; } catch { return true; }
}

function showDispatch(open) {
  const toggle = $("dispatch-toggle");
  const aside = $("ws-dispatch");
  if (open && !aside.querySelector("iframe")) {
    const frame = document.createElement("iframe");
    frame.src = "/dispatch";
    frame.title = "Dispatch";
    aside.append(frame);
  }
  aside.hidden = !open;
  toggle.setAttribute("aria-pressed", String(open));
  toggle.title = open ? "Hide Dispatch" : "Show Dispatch";
  try {
    if (open) localStorage.removeItem(DISPATCH_KEY);
    else localStorage.setItem(DISPATCH_KEY, "closed");
  } catch {}
}

function toggleDispatch() {
  if (phone.matches) { location.href = "/dispatch"; return; }
  showDispatch($("ws-dispatch").hidden);
}

$("dispatch-toggle").addEventListener("click", toggleDispatch);

$("logout").hidden = Boolean(window.__TAURI__);
$("logout").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  location.href = "/login";
});

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.yardbell !== "dispatch") return;
  if (e.data.action === "hide") showDispatch(false);
  if (e.data.action === "open" && typeof e.data.key === "string") open(e.data.key);
});

if (dispatchShown() && !phone.matches) showDispatch(true);

window.YardbellSide.resizable({ handle: $("dispatch-resize"), panel: $("ws-dispatch"), prop: "--ws-dispatch", key: "yardbell.ws.dispatch-width", min: 300, normal: 380, max: 640 });
