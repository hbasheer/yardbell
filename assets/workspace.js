const $ = (id) => document.getElementById(id);
const STORE = "workspace.v3";
// A workspace is one folder on one machine: the same folder name on two machines is two places.
const SEP = "\t";
const phone = matchMedia("(max-width: 760px)");
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const WORD = { blocked: "blocked", done: "done", working: "working", idle: "idle" };

let state = null;
let saved = { current: "", spaces: {} };
const lastActivity = new Map();
const done = new Set();
const paneEls = new Map();
const starting = new Set();
const startErrors = new Map();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function short(path) {
  return String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "null");
    if (raw && typeof raw.spaces === "object") saved = raw;
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

function project() {
  return saved.current;
}

function space(name = project()) {
  if (!saved.spaces[name]) {
    const first = sessions().find((s) => projectOf(s) === name && !s.stale);
    const pane = { pane: newId(), key: first ? keyOf(first) : null };
    saved.spaces[name] = { tabs: [{ id: newId(), name: "Agents", root: pane }], tab: 0, focus: pane.pane };
  }
  return saved.spaces[name];
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
  if (document.hidden || !project()) return new Set();
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
  for (const name of Object.keys(saved.spaces)) if (!names.includes(name)) names.push(name);
  return names.filter((n) => n.includes(SEP)).sort((a, b) => machineOf(a).localeCompare(machineOf(b)) || folderOf(a).localeCompare(folderOf(b)));
}

function dot(st) {
  return `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;
}

function renderSide() {
  const all = sessions().filter((s) => !s.stale);
  const counts = {};
  for (const s of all) counts[stateOf(s)] = (counts[stateOf(s)] || 0) + 1;
  const server = state.server;
  $("server").innerHTML = server ? `<span>Running on</span> <b>${esc(server.machine)}</b> <code>${esc(server.address)}</code>` : "";
  $("summary").textContent = ["blocked", "done", "working", "idle"]
    .filter((k) => counts[k]).map((k) => `${counts[k]} ${WORD[k]}`).join(" · ") || "No agents running";

  const inPane = project() ? new Map(leaves(tab().root).map((l, i) => [l.key, i + 1])) : new Map();
  const row = (s) => {
    const key = keyOf(s);
    const st = stateOf(s);
    const n = inPane.get(key);
    const where = n && !phone.matches ? `<span class="ws-pane-no" title="In pane ${n}">${n}</span>` : "";
    const acts = s.stale || phone.matches || !project() ? "" : `<span class="ws-row-acts">
      <button type="button" class="btn quiet icon-btn" data-more="${esc(key)}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(title(s))}" title="More"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg></button>
    </span>`;
    return `<li class="ws-row"><button type="button" class="ws-item${n && key === focusedLeaf()?.key ? " current" : ""}${s.stale ? " stale" : ""}" data-key="${esc(key)}"${s.stale ? " disabled" : ""}>
      ${dot(st)}
      <span class="ws-item-main"><span class="ws-item-title">${esc(title(s))}</span><span class="ws-item-sub">${esc([agentLabel(s.agent), s.branch].filter(Boolean).join(" · "))}</span></span>
      <span class="ws-item-word ${st}">${esc(WORD[st] || "last known")}</span>${where}
    </button>${acts}</li>`;
  };
  let lastMachine = "";
  $("tree").innerHTML = projects().map((name) => {
    const mine = sessions().filter((s) => projectOf(s) === name);
    const current = name === project();
    const machine = machineOf(name);
    const head = machine !== lastMachine ? `<li class="ws-machine"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/></svg>${esc(machine)}</li>` : "";
    lastMachine = machine;
    return `${head}<li><button type="button" class="ws-space${current ? " current" : ""}" data-space="${esc(name)}"${current ? ' aria-current="true"' : ""}>
      ${dot(worst(mine))}<span class="ws-space-name">${esc(spaceLabel(name))}</span><span class="ws-count">${mine.filter((s) => !s.stale).length}</span>
    </button></li>${mine.length ? `<li><ul class="ws-terminals">${mine.map(row).join("")}</ul></li>` : ""}`;
  }).join("") || `<li class="ws-empty">No sessions running. Start one with New session.</li>`;
}

let renaming = null;

function renderTabs() {
  if (renaming !== null) return;
  const sp = space();
  $("tabs").innerHTML = sp.tabs.map((t, i) => {
    const st = worst(leaves(t.root).map((l) => sessionFor(l.key)).filter(Boolean));
    const close = sp.tabs.length > 1 || leaves(t.root).some((l) => l.key) ? `<span class="ws-tab-close" data-close-tab="${i}" role="button" aria-label="Close tab ${esc(t.name)}" title="Close tab">×</span>` : "";
    return `<div class="ws-tab${i === sp.tab ? " current" : ""}" role="tab" aria-selected="${i === sp.tab}" tabindex="0" data-tab="${i}" title="Double-click to rename, right-click for more">${st ? dot(st) : ""}<span class="ws-tab-name">${esc(t.name)}</span>${close}</div>`;
  }).join("");
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
      <button class="btn quiet icon-btn" type="button" data-act="close" aria-label="Close pane" title="Close pane (Alt+X)"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </header>
    <div class="ws-pane-body"></div>`;
  $("panes").append(el);
  paneEls.set(leaf.pane, el);
  return el;
}

function home() {
  const name = project();
  return (state?.folders || []).find((f) => f.label === folderOf(name) && f.machine === machineOf(name));
}

function emptyPane(leaf) {
  const shown = new Set(leaves(tab().root).map((l) => l.key));
  const picks = sessions().filter((s) => projectOf(s) === project() && !s.stale && !shown.has(keyOf(s)));
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
      body: JSON.stringify({ machine: where.machine, folder: where.label, agent }),
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

function fillPane(el, leaf, n) {
  const s = leaf.key && sessionFor(leaf.key);
  el.querySelector(".ws-pane-no").textContent = n;
  el.querySelectorAll(".ws-pane-btn").forEach((b) => { b.hidden = !leaf.key; });
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
      fillPane(el, leaf, i + 1);
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
  if (!projects().includes(project())) saved.current = projects()[0] || "";
  if (!project()) {
    renderSide();
    $("tabs").innerHTML = "";
    return;
  }
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

function reveal(name, key) {
  const sp = space(name);
  const ti = sp.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === key));
  if (ti < 0) return false;
  saved.current = name;
  sp.tab = ti;
  document.body.classList.remove("ws-picking");
  focusPane(leaves(sp.tabs[ti].root).find((l) => l.key === key).pane);
  return true;
}

function open(key) {
  done.delete(key);
  const s = sessionFor(key);
  if (reveal(project(), key)) return;
  if (s && projectOf(s) !== project() && reveal(projectOf(s), key)) return;
  const all = leaves(tab().root);
  const target = [focusedLeaf(), ...all].find((l) => !l.key) || focusedLeaf();
  target.key = key;
  document.body.classList.remove("ws-picking");
  focusPane(target.pane);
}

function split(dir, key = null) {
  if (phone.matches || !project()) return;
  const leaf = focusedLeaf();
  if (key && !leaf.key) {
    leaf.key = key;
    done.delete(key);
    focusPane(leaf.pane);
    return;
  }
  const fresh = { pane: newId(), key };
  if (key) done.delete(key);
  const replacement = { split: dir, ratio: 0.5, a: { ...leaf }, b: fresh };
  const t = tab();
  const parent = parentOf(t.root, leaf);
  if (!parent) t.root = replacement;
  else if (parent.a === leaf) parent.a = replacement;
  else parent.b = replacement;
  focusPane(fresh.pane);
}

function closePane(id = space().focus) {
  const t = tab();
  const leaf = leaves(t.root).find((l) => l.pane === id);
  if (!leaf) return;
  const parent = parentOf(t.root, leaf);
  if (!parent) {
    leaf.key = null;
    if (phone.matches) document.body.classList.add("ws-picking");
  } else {
    const other = parent.a === leaf ? parent.b : parent.a;
    const grand = parentOf(t.root, parent);
    if (!grand) t.root = other;
    else if (grand.a === parent) grand.a = other;
    else grand.b = other;
    space().focus = leaves(other)[0].pane;
  }
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

function showMenu(rect, items) {
  let el = $("ws-menu");
  if (!el) {
    el = document.createElement("div");
    el.id = "ws-menu";
    el.className = "menu";
    el.setAttribute("role", "menu");
    el.addEventListener("click", (e) => {
      const item = e.target.closest("[data-i]");
      if (!item) return;
      const run = el.actions[Number(item.dataset.i)];
      closeMenu();
      run();
    });
    document.body.append(el);
  }
  el.actions = items.map((it) => it.run);
  el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}>${esc(it.label)}</button>`).join("");
  el.hidden = false;
  const width = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
  el.style.top = `${Math.min(rect.bottom + 4, innerHeight - el.offsetHeight - 8)}px`;
  el.querySelector("[role=menuitem]").focus();
}

function openMenu(button) {
  const el = $("ws-menu");
  const key = button.dataset.more;
  if (el && !el.hidden && el.dataset.key === key) {
    closeMenu();
    return;
  }
  showMenu(button.getBoundingClientRect(), [
    { label: "Open to the right", run: () => split("row", key) },
    { label: "Open below", run: () => split("col", key) },
    { label: "Open in a new tab", run: () => {
      const s = sessionFor(key);
      done.delete(key);
      addTab(s ? title(s) : key.split("/").pop(), key);
    } },
  ]);
  $("ws-menu").dataset.key = key;
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

function closeMenu() {
  const el = $("ws-menu");
  if (el) el.hidden = true;
}

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#ws-menu, [data-more]")) closeMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("resize", closeMenu);

function addTab(name, key) {
  const sp = space();
  const pane = { pane: newId(), key };
  sp.tabs.push({ id: newId(), name, root: pane });
  sp.tab = sp.tabs.length - 1;
  sp.focus = pane.pane;
  document.body.classList.remove("ws-picking");
  save();
  render();
}

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
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Could not start the session (${res.status})`);
        const key = `${body.machine}/${data.name}`;
        await fetch("/refresh", { method: "POST", headers: { Accept: "application/json" } }).catch(() => {});
        await load();
        const started = sessionFor(key);
        if (started) saved.current = projectOf(started);
        if (!project()) return;
        addTab(body.branch || short(data.path || body.path).split("/").pop(), key);
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

function switchSpace(step) {
  const names = projects();
  if (!names.length) return;
  const i = names.indexOf(project());
  saved.current = names[(i + step + names.length) % names.length];
  save();
  render();
}

function shortcut(code) {
  if (!project()) return false;
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
  const b = e.target.closest("[data-space]");
  if (b) {
    saved.current = b.dataset.space;
    save();
    render();
    return;
  }
  const more = e.target.closest("[data-more]");
  if (more) {
    openMenu(more);
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
  showMenu({ right: e.clientX + 200, bottom: e.clientY }, [
    { label: "Rename tab", run: () => renameTab(i) },
    { label: "Close tab", danger: true, run: () => closeTab(i) },
  ]);
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
    leaf.key = pick;
    done.delete(pick);
    focusPane(id);
  } else if (e.target.closest("[data-start]") && leaf) startHere(leaf, e.target.closest("[data-start]").dataset.start);
  else if (act === "close") closePane(id);
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
setInterval(load, 3000);
