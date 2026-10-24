const $ = (id) => document.getElementById(id);
const STORE = "workspace.v2";
const phone = matchMedia("(max-width: 760px)");
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const WORD = { blocked: "blocked", done: "done", working: "working", idle: "idle" };

let state = null;
let saved = { current: "", spaces: {} };
const lastActivity = new Map();
const done = new Set();
const paneEls = new Map();

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
  return s.folder || "Other";
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
  return names.sort((a, b) => a.localeCompare(b));
}

function dot(st) {
  return `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;
}

function renderSide() {
  const all = sessions().filter((s) => !s.stale);
  const counts = {};
  for (const s of all) counts[stateOf(s)] = (counts[stateOf(s)] || 0) + 1;
  $("summary").textContent = ["blocked", "done", "working", "idle"]
    .filter((k) => counts[k]).map((k) => `${counts[k]} ${WORD[k]}`).join(" · ") || "No agents running";

  $("spaces").innerHTML = projects().map((name) => {
    const mine = sessions().filter((s) => projectOf(s) === name);
    const st = worst(mine);
    const current = name === project();
    return `<li><button type="button" class="ws-space${current ? " current" : ""}" data-space="${esc(name)}"${current ? ' aria-current="true"' : ""}>
      ${dot(st)}<span class="ws-space-name">${esc(short(name))}</span><span class="ws-count">${mine.filter((s) => !s.stale).length}</span>
    </button></li>`;
  }).join("") || `<li class="ws-empty">No sessions running. Start one from the <a href="/">dashboard</a>.</li>`;

  if (!project()) {
    $("agents").innerHTML = "";
    return;
  }
  const mine = sessions().filter((s) => projectOf(s) === project());
  const others = sessions().filter((s) => projectOf(s) !== project() && stateOf(s) === "blocked");
  $("agents-label").textContent = `Agents in ${short(project()).split("/").pop()}`;
  const inPane = new Map(leaves(tab().root).map((l, i) => [l.key, i + 1]));
  const row = (s, other) => {
    const key = keyOf(s);
    const st = stateOf(s);
    const n = inPane.get(key);
    const where = n && !phone.matches ? `<span class="ws-pane-no" title="In pane ${n}">${n}</span>` : "";
    const sub = other ? short(projectOf(s)) : s.branch || "";
    return `<li><button type="button" class="ws-item${n && key === focusedLeaf()?.key ? " current" : ""}${s.stale ? " stale" : ""}" data-key="${esc(key)}"${s.stale ? " disabled" : ""}>
      ${dot(st)}
      <span class="ws-item-main"><span class="ws-item-title">${esc(title(s))}</span><span class="ws-item-sub">${esc([agentLabel(s.agent), sub, s.machine].filter(Boolean).join(" · "))}</span></span>
      <span class="ws-item-word ${st}">${esc(WORD[st] || "last known")}</span>${where}
    </button></li>`;
  };
  const elsewhere = others.length ? `<li class="ws-label ws-elsewhere">Blocked in other workspaces</li>${others.map((s) => row(s, true)).join("")}` : "";
  $("agents").innerHTML = mine.map((s) => row(s, false)).join("") + elsewhere;
}

function renderTabs() {
  const sp = space();
  $("tabs").innerHTML = sp.tabs.map((t, i) => {
    const st = worst(leaves(t.root).map((l) => sessionFor(l.key)).filter(Boolean));
    const close = sp.tabs.length > 1 ? `<span class="ws-tab-close" data-close-tab="${i}" role="button" aria-label="Close tab ${esc(t.name)}" title="Close tab">×</span>` : "";
    return `<div class="ws-tab${i === sp.tab ? " current" : ""}" role="tab" aria-selected="${i === sp.tab}" tabindex="0" data-tab="${i}" title="Double-click to rename">${st ? dot(st) : ""}<span>${esc(t.name)}</span>${close}</div>`;
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

function fillPane(el, leaf, n) {
  const s = leaf.key && sessionFor(leaf.key);
  el.querySelector(".ws-pane-no").textContent = n;
  el.querySelectorAll(".ws-pane-btn").forEach((b) => { b.hidden = !leaf.key; });
  const body = el.querySelector(".ws-pane-body");
  const frame = body.querySelector("iframe");
  const head = el.querySelector(".ws-pane-title");
  if (!leaf.key) {
    head.textContent = "Empty";
    if (frame || !body.firstChild) {
      body.innerHTML = `<p class="ws-pane-empty">Pick an agent from the list to open it here.</p>`;
    }
    return;
  }
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

function split(dir) {
  if (phone.matches || !project()) return;
  const leaf = focusedLeaf();
  const fresh = { pane: newId(), key: null };
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

function newTab() {
  if (!project()) return;
  const sp = space();
  const pane = { pane: newId(), key: null };
  sp.tabs.push({ id: newId(), name: `Tab ${sp.tabs.length + 1}`, root: pane });
  sp.tab = sp.tabs.length - 1;
  sp.focus = pane.pane;
  save();
  render();
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

$("spaces").addEventListener("click", (e) => {
  const b = e.target.closest("[data-space]");
  if (!b) return;
  saved.current = b.dataset.space;
  save();
  render();
});

$("agents").addEventListener("click", (e) => {
  const item = e.target.closest(".ws-item");
  if (item && !item.disabled) open(item.dataset.key);
});

$("tabs").addEventListener("click", (e) => {
  const close = e.target.closest("[data-close-tab]");
  if (close) {
    const sp = space();
    sp.tabs.splice(Number(close.dataset.closeTab), 1);
    switchTab(Math.min(sp.tab, sp.tabs.length - 1));
    return;
  }
  const t = e.target.closest("[data-tab]");
  if (t) switchTab(Number(t.dataset.tab));
});

$("tabs").addEventListener("dblclick", (e) => {
  const t = e.target.closest("[data-tab]");
  if (!t) return;
  const current = space().tabs[Number(t.dataset.tab)];
  const name = prompt("Tab name", current.name)?.trim();
  if (!name) return;
  current.name = name;
  save();
  render();
});

$("new-tab").addEventListener("click", newTab);

$("panes").addEventListener("click", (e) => {
  const pane = e.target.closest(".ws-pane");
  if (!pane) return;
  const id = pane.dataset.pane;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "close") closePane(id);
  else if (act === "split-row" || act === "split-col") {
    space().focus = id;
    split(act === "split-row" ? "row" : "col");
  } else if (act === "text") {
    pane.querySelector("iframe")?.contentWindow?.postMessage({ yardbell: "text" }, location.origin);
  } else if (act !== "full") {
    focusPane(id);
  }
});

$("back").addEventListener("click", () => {
  document.body.classList.add("ws-picking");
  render();
});

$("keys-btn").addEventListener("click", () => $("keys").showModal());
$("keys-close").addEventListener("click", () => $("keys").close());

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
