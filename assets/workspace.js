const $ = (id) => document.getElementById(id);
const STORE = "workspace.v5";
const OLD_STORE = "workspace.v4";
// A workspace is one folder on one machine: the same folder name on two machines is two places.
const SEP = "\t";
const phone = matchMedia("(max-width: 760px)");
const WORD = window.YardbellTree.WORD;

let state = null;
let saved = { folder: "", tabs: [], tab: 0, focus: "", hidden: [] };
const lastActivity = new Map();
const changedAt = new Map();
const done = new Set();
const paneEls = new Map();
const starting = new Set();
const startErrors = new Map();
const missing = new Map();
// A session missing from a few checks in a row has ended; one missed check is only a hiccup.
const GONE_AFTER = 3;
let dispatchAfterSync = false;
const dispatchTitles = new Map();

window.YardbellShell.head.querySelector(".col-title").insertAdjacentHTML("afterend", `
  <button class="btn quiet icon-btn" id="side-add-project" type="button" aria-label="Add a project" title="Add a project" aria-haspopup="dialog">
    <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/><path d="M8 7.5v3.5M6.25 9.25h3.5"/></svg>
  </button>
  <button class="btn quiet icon-btn" id="side-new" type="button" aria-label="New session" title="New session">
    <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
  </button>
  <button class="btn quiet icon-btn desk-only" id="keys-btn" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
    <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.75h1M7.5 6.75h1M11 6.75h1M5 9.25h6"/></svg>
  </button>`);
window.YardbellShell.column.innerHTML = '<div class="col-tree"></div>';
const treeEl = window.YardbellShell.column.querySelector(".col-tree");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function short(path) {
  return String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function validNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.split) return (node.split === "row" || node.split === "col") && validNode(node.a) && validNode(node.b);
  return typeof node.pane === "string";
}

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function parseLayout(text) {
  try {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.tabs) || !raw.tabs.every((t) => t && validNode(t.root))) return null;
    if (raw.tab !== undefined && !Number.isInteger(raw.tab)) return null;
    if (raw.hidden !== undefined && !Array.isArray(raw.hidden)) return null;
    return raw;
  } catch {
    return null;
  }
}

// A v4 layout carries over as it is, since its leaves are session leaves already. Its Dispatch
// lived in a side panel, so a panel that was showing comes back as a pane once the tabs are synced.
// A v5 that is there but unreadable means v4 is older than it, so v4 is not used then.
function restore() {
  const now = stored(STORE);
  if (now !== null) {
    const layout = parseLayout(now);
    if (layout) saved = { ...saved, ...layout };
    return;
  }
  const old = parseLayout(stored(OLD_STORE));
  if (!old) return;
  saved = { ...saved, ...old };
  dispatchAfterSync = !phone.matches && stored("yardbell.dispatch") !== "closed";
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
  if (s.stopped) return "error";
  return done.has(keyOf(s)) ? "done" : "idle";
}

function worst(list) {
  return window.YardbellTree.worst(list.map(stateOf));
}

// Layout trees: a leaf is { pane, key } for a session (key null for an empty pane),
// { pane, kind: "dispatch", conversation }, { pane, kind: "file", machine, root, path } or
// { pane, kind: "diff", machine, root, path, staged } with path relative to root, and a split is
// { split: "row" | "col", ratio, a, b }.

function isDispatch(leaf) {
  return leaf?.kind === "dispatch";
}

function isFile(leaf) {
  return leaf?.kind === "file";
}

function isDiff(leaf) {
  return leaf?.kind === "diff";
}

function isDoc(leaf) {
  return isFile(leaf) || isDiff(leaf);
}

function isEmpty(leaf) {
  return !isDispatch(leaf) && !isDoc(leaf) && !leaf.key;
}

function fileName(leaf) {
  const name = String(leaf.path || "").split("/").pop() || "File";
  return isDiff(leaf) && leaf.staged ? `${name} (staged)` : name;
}

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

function even(parts, dir) {
  return parts.length === 1 ? parts[0] : { split: dir, ratio: 1 / parts.length, a: parts[0], b: even(parts.slice(1), dir) };
}

// A balanced grid from the panes in reading order: enough columns for the count, any extra
// panes in the top rows, and every pane an equal share of its row.
function gridOf(list) {
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows = [];
  for (let at = 0; at < list.length; ) {
    const left = list.length - at;
    const take = Math.ceil(left / Math.ceil(left / cols));
    rows.push(even(list.slice(at, at + take), "row"));
    at += take;
  }
  return even(rows, "col");
}

// A folder picked while a session holds the focus stays the workspace until the focus moves.
let picked = null;

function pickedFolder() {
  if (!picked) return "";
  if (picked.focus === (saved.tabs.length ? focusedLeaf()?.key : null) && picked.tab === saved.tab && saved.folder === picked.name) return picked.name;
  picked = null;
  return "";
}

// The workspace you are in is the folder of the focused session, or the one last picked.
function project() {
  const chosen = pickedFolder();
  if (chosen) return chosen;
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

// Taking a pane out lays the tab out again as an even grid: hand-made split shapes and dragged
// ratios last only until the pane count changes.
function removeLeaf(t, leaf) {
  const parent = parentOf(t.root, leaf);
  if (!parent) return false;
  const other = parent.a === leaf ? parent.b : parent.a;
  const grand = parentOf(t.root, parent);
  if (!grand) t.root = other;
  else if (grand.a === parent) grand.a = other;
  else grand.b = other;
  t.root = gridOf(leaves(t.root));
  return true;
}

// Takes a session's pane out of whichever tab holds it, keeping the pane itself so its terminal
// does not reconnect. A tab left with nothing in it goes too.
function detach(sp, key) {
  for (const t of sp.tabs) {
    const leaf = leaves(t.root).find((l) => l.key === key);
    if (!leaf) continue;
    if (removeLeaf(t, leaf)) nameDispatchTab(t);
    else {
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

function nameDispatchTab(t) {
  const all = leaves(t.root);
  if (all.length === 1 && isDispatch(all[0])) t.name = "Dispatch";
  if (all.length === 1 && isDoc(all[0])) t.name = fileName(all[0]);
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
    const blank = sp.tabs.length === 1 && leaves(sp.tabs[0].root).every(isEmpty) ? sp.tabs[0] : null;
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
  if (document.hidden || !saved.tabs.length || document.body.classList.contains("ws-list")) return new Set();
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
    if (before !== undefined && before !== s.activity) changedAt.set(key, Date.now());
    lastActivity.set(key, s.activity);
    if (visible.has(key)) window.YardbellTree.look(key, stateOf(s));
  }
  for (const key of [...done]) if (!live.has(key)) done.delete(key);
  for (const key of [...changedAt.keys()]) if (!live.has(key)) changedAt.delete(key);
}

const KEPT_KEY = "yardbell.ws.kept";

function kept() {
  try {
    const list = JSON.parse(stored(KEPT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((k) => k && typeof k.machine === "string" && typeof k.folder === "string") : [];
  } catch {
    return [];
  }
}

function keepFolder(entry) {
  const list = kept().filter((k) => !(k.machine === entry.machine && k.folder === entry.folder));
  list.push(entry);
  try { localStorage.setItem(KEPT_KEY, JSON.stringify(list)); } catch {}
}

function projects() {
  const names = [...new Set([...sessions().map(projectOf), ...kept().map((k) => `${k.machine}${SEP}${k.folder}`)])];
  if (saved.folder && !names.includes(saved.folder)) names.push(saved.folder);
  return names.filter((n) => n.includes(SEP)).sort((a, b) => machineOf(a).localeCompare(machineOf(b)) || folderOf(a).localeCompare(folderOf(b)));
}

function dot(st) {
  return `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;
}

function renderSide() {
  const here = project();
  const focused = saved.tabs.length ? focusedLeaf()?.key : null;
  const folder = here ? { machine: machineOf(here), folder: folderOf(here) } : null;
  window.YardbellTree.render(treeEl, state, {
    stateOf,
    phone: phone.matches,
    selected: focused && sessionFor(focused) && !pickedFolder() ? { key: focused } : folder,
    keep: [...kept(), ...(folder ? [folder] : [])],
    ageOf: (key) => changedAt.get(key),
    onSession: open,
    onFolder: ({ machine, folder: path }) => openSpace(`${machine}${SEP}${path}`),
  });
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

const CHECK_CIRCLE = '<circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.7 1.7 3.3-3.6"/>';
const STATE_ICONS = {
  done: CHECK_CIRCLE,
  idle: CHECK_CIRCLE,
  working: '<circle cx="8" cy="8" r="6" opacity=".25"/><path d="M8 2a6 6 0 0 1 6 6"/>',
  blocked: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/>',
  error: '<circle cx="8" cy="8" r="6"/><path d="m6 6 4 4M10 6l-4 4"/>',
};

const DIFF_ICON = '<svg class="ws-agent" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.75H4.25c-.83 0-1.5.67-1.5 1.5v9.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5V6z"/><path d="M8 5.5v4M6 7.5h4M6 11.5h4"/></svg>';
const FILE_ICON = '<svg class="ws-agent" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.75H4.25c-.83 0-1.5.67-1.5 1.5v9.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5V6z"/><path d="M9 1.75V6h4.25"/></svg>';

const AGENT_ICONS = {
  claude: `<svg class="ws-agent claude" viewBox="0 0 16 16" aria-hidden="true">${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a, n) => `<path d="M8 8V${n % 2 ? 2.2 : 1}" transform="rotate(${a} 8 8)"/>`).join("")}</svg>`,
  other: '<svg class="ws-agent" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 5 3 3-3 3M8 11.5h4.5"/></svg>',
};

function stateIcon(st) {
  return STATE_ICONS[st] ? `<span class="ws-tab-state ${st}" title="${esc(WORD[st])}"><svg viewBox="0 0 16 16" aria-hidden="true">${STATE_ICONS[st]}</svg></span>` : "";
}

function tabAgent(t, current) {
  const all = leaves(t.root);
  if (all.every(isDoc)) return all.every(isDiff) ? DIFF_ICON : FILE_ICON;
  const live = all.map((l) => ({ l, s: sessionFor(l.key) })).filter((x) => x.s);
  const pick = (current && live.find((x) => x.l.pane === space().focus)) || live[0];
  return pick?.s.agent === "claude" ? AGENT_ICONS.claude : AGENT_ICONS.other;
}

function renderTabs() {
  if (renaming !== null) return;
  const sp = space();
  const strip = $("tabs");
  const html = sp.tabs.map((t, i) => {
    const st = tabState(t);
    const close = sp.tabs.length > 1 || !leaves(t.root).every(isEmpty) ? `<span class="ws-tab-close" data-close-tab="${i}" role="button" aria-label="Close tab ${esc(t.name)}" title="Close tab"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></span>` : "";
    return `<div class="ws-tab${i === sp.tab ? " current" : ""}" role="tab" aria-selected="${i === sp.tab}" tabindex="0" data-tab="${i}" title="${esc(t.name)}&#10;Double-click to rename, right-click for more">${stateIcon(st)}${tabAgent(t, i === sp.tab)}<span class="ws-tab-name">${esc(t.name)}</span>${close}</div>`;
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
      <span class="ws-state" hidden></span>
      <strong class="ws-pane-title"></strong>
      <span class="ws-pane-sub"></span>
      <span class="ws-views" hidden></span>
      <span class="ws-pane-end">
        <span class="ws-pane-pr" hidden></span>
        <button class="btn quiet ws-main-btn" type="button" data-act="main" hidden></button>
        <button class="btn quiet icon-btn ws-more-btn" type="button" data-act="more" aria-label="More for this pane" title="More" aria-haspopup="menu" aria-expanded="false"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></svg></button>
      </span>
    </header>
    <div class="ws-pane-body"></div>`;
  $("panes").append(el);
  paneEls.set(leaf.pane, el);
  return el;
}

function home() {
  const name = project();
  if (!name) return null;
  const known = (state?.folders || []).find((f) => f.label === folderOf(name) && f.machine === machineOf(name));
  if (known) return known;
  const mine = kept().find((k) => k.machine === machineOf(name) && k.folder === folderOf(name));
  return mine ? { machine: mine.machine, label: mine.folder, path: mine.path } : null;
}

function addProject() {
  if (!state) return;
  const up = (state.machines || []).filter((m) => m.up).map((m) => m.name);
  if (!up.length) { toast("No machine is connected right now"); return; }
  window.YardbellNewSession.addProject({
    machines: up,
    machine: home()?.machine || (project() ? machineOf(project()) : ""),
    onAdd: ({ machine, path }) => {
      const label = (state?.folders || []).find((f) => f.machine === machine && f.path === path)?.label || path;
      keepFolder({ machine, folder: label, path });
      openSpace(`${machine}${SEP}${label}`);
    },
  });
}

const START_ICON = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5l3 3-3 3M8 11.5h5"/></svg>`;

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
    ? `<p class="ws-empty-label">Start an agent in ${esc(short(where.label).split("/").pop())}:</p><div class="ws-picks">${mine.map((a, i) =>
      `<button class="btn${i === 0 ? " primary" : ""}" type="button" data-start="${esc(a.name)}"${busy}>${START_ICON}${esc(a.label)}</button>`).join("")}${other}</div>${busy ? `<p class="ws-empty-note">Starting…</p>` : ""}`
    : "";
  const list = picks.length
    ? `<p class="ws-empty-label">Or open one that is running:</p><div class="ws-picks">${picks.map((s) => `<button class="btn" type="button" data-pick="${esc(keyOf(s))}">${dot(stateOf(s))}${esc(title(s))} <span>${esc(agentLabel(s.agent))}</span></button>`).join("")}</div>`
    : "";
  const failed = startErrors.get(leaf.pane);
  const ended = leaf.ended ? `<p class="ws-empty-note">That session has ended.</p>` : "";
  return `<div class="ws-pane-empty">
    ${ended}<p class="ws-empty-title">Nothing open in this pane.</p>${start}${failed ? `<p class="ws-pane-error" role="alert">${esc(failed)}</p>` : ""}${list}
  </div>`;
}

async function startHere(leaf, agent) {
  const where = home();
  if (!where || starting.has(leaf.pane)) return;
  delete leaf.ended;
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

function dispatchSrc(conversation) {
  return `/dispatch${conversation ? `?c=${encodeURIComponent(conversation)}` : ""}`;
}

async function loadDispatchTitles() {
  try {
    const res = await fetch("/dispatch/conversations", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    for (const c of await res.json()) dispatchTitles.set(c.id, c.title);
    render();
  } catch {}
}

function termSrc(key) {
  const [machine, ...rest] = key.split("/");
  return `/term/${encodeURIComponent(machine)}/${encodeURIComponent(rest.join("/"))}`;
}

// Only an activity change seen on this page dates a session, so a fresh page shows no age.
function ageOf(key) {
  const since = changedAt.get(key);
  if (!since) return "";
  const minutes = Math.floor((Date.now() - since) / 60000);
  if (minutes < 1) return "";
  return minutes < 60 ? ` ${minutes}m` : ` ${Math.floor(minutes / 60)}h`;
}

function subOf(s) {
  const st = stateOf(s);
  const age = ["idle", "done", "blocked"].includes(st) ? ageOf(keyOf(s)) : "";
  return `${agentLabel(s.agent)} · ${WORD[st] || "last known"}${age}`;
}

function canMerge(s) {
  return s.pull?.state === "open" && window.YardbellPull.ready(s.pull) && !s.stale;
}

function asksReview(s) {
  return s.review?.state === "asking";
}

function mainAction(s) {
  if (!s) return null;
  const P = window.YardbellPull;
  if (canMerge(s)) return { kind: "merge", label: `Merge ${P.ref(s.pull)}` };
  if (asksReview(s)) return { kind: "review", label: "Open review", title: P.reviewMark(s)?.title || "" };
  return null;
}

function pullLine(s) {
  const P = window.YardbellPull;
  const { word, tone } = P.status(s.pull);
  const review = P.reviewMark(s);
  return { text: `${P.ref(s.pull)} ${word}`, tone, title: review ? `${P.describe(s.pull)} ${review.title}` : P.describe(s.pull) };
}

function paintHead(el, { st = null, name, sub = "", s = null }) {
  const head = el.querySelector(".ws-pane-head");
  const mark = head.querySelector(":scope > .ws-state");
  mark.hidden = st === null;
  if (st !== null) {
    mark.className = `ws-state ${st}`;
    mark.title = WORD[st] || "last known";
  }
  const strong = head.querySelector(".ws-pane-title");
  strong.textContent = name;
  strong.title = name;
  head.querySelector(".ws-pane-sub").textContent = sub;
  const pr = head.querySelector(".ws-pane-pr");
  pr.hidden = !s?.pull;
  if (s?.pull) {
    const { text, tone, title: why } = pullLine(s);
    pr.className = `ws-pane-pr${tone ? ` ${tone}` : ""}`;
    pr.textContent = text;
    pr.title = why;
  }
  const main = head.querySelector('[data-act="main"]');
  const act = mainAction(s);
  main.hidden = !act;
  main.textContent = act?.label || "";
  main.title = act?.title || "";
}

// The frame is made once: a new src would reload Dispatch and drop whatever is half typed in it.
function fillDispatch(leaf, body) {
  delete body.dataset.html;
  if (body.querySelector("iframe[data-dispatch]")) return;
  const frame = document.createElement("iframe");
  frame.dataset.dispatch = "";
  frame.title = "Dispatch";
  frame.src = dispatchSrc(leaf.conversation);
  body.replaceChildren(frame);
  loadDispatchTitles();
}

function fillPane(el, leaf) {
  const body = el.querySelector(".ws-pane-body");
  const frame = body.querySelector("iframe");
  if (!isFile(leaf)) delete body.dataset.file;
  if (!isDiff(leaf)) delete body.dataset.diff;
  if (isFile(leaf)) {
    delete body.dataset.html;
    paintHead(el, { name: fileName(leaf), sub: `on ${leaf.machine}` });
    window.YardbellSide.fillFile(body, leaf);
    return;
  }
  if (isDiff(leaf)) {
    delete body.dataset.html;
    paintHead(el, { name: fileName(leaf), sub: `changes on ${leaf.machine}` });
    window.YardbellChanges.fillDiff(body, leaf);
    return;
  }
  if (isDispatch(leaf)) {
    paintHead(el, { name: dispatchTitles.get(leaf.conversation) || "Dispatch" });
    fillDispatch(leaf, body);
    return;
  }
  if (isEmpty(leaf)) {
    paintHead(el, { name: "Empty" });
    const html = emptyPane(leaf);
    if (body.dataset.html !== html) {
      body.innerHTML = html;
      body.dataset.html = html;
    }
    return;
  }
  delete body.dataset.html;
  const s = sessionFor(leaf.key);
  const [machine, ...rest] = leaf.key.split("/");
  const name = rest.join("/");
  paintHead(el, s ? { st: stateOf(s), name: title(s), sub: subOf(s), s } : { name, sub: `on ${machine}` });
  if (frame?.dataset.key === leaf.key) return;
  const next = document.createElement("iframe");
  next.dataset.key = leaf.key;
  next.title = `Terminal for ${name} on ${machine}`;
  next.src = `${termSrc(leaf.key)}?embed=1`;
  body.replaceChildren(next);
}

// Panes are positioned rather than nested, and never move in the DOM: moving an iframe reloads
// it, which would drop and reopen the terminal on every split or resize.
function renderPanes() {
  const sp = space();
  const keep = new Set();
  $("panes").classList.toggle("many", !phone.matches && leaves(tab().root).length > 1);
  sp.tabs.forEach((t, ti) => {
    const layout = rects(t.root, { x: 0, y: 0, w: 1, h: 1 });
    layout.panes.forEach(({ leaf, box }) => {
      keep.add(leaf.pane);
      const el = paneEl(leaf);
      el.hidden = ti !== sp.tab || (phone.matches && leaf.pane !== focusedLeaf().pane);
      el.classList.toggle("focused", !phone.matches && leaf.pane === sp.focus && layout.panes.length > 1);
      const at = phone.matches ? { x: 0, y: 0, w: 1, h: 1 } : box;
      place(el, at);
      el.classList.toggle("edge-right", at.x + at.w < 0.999);
      el.classList.toggle("edge-bottom", at.y + at.h < 0.999);
      fillPane(el, leaf);
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
  if (dispatchAfterSync) {
    dispatchAfterSync = false;
    if (!saved.tabs.some((t) => leaves(t.root).some(isDispatch))) placeDispatch("");
  }
  if (!projects().includes(saved.folder)) saved.folder = projects()[0] || "";
  for (const t of saved.tabs) for (const l of leaves(t.root)) if (l.ended && l.key) delete l.ended;
  save();
  renderTabs();
  renderPanes();
  renderTop();
  renderSide();
  syncDispatchPressed();
  window.YardbellSide.update();
}

function setMode(mode) {
  document.body.classList.toggle("ws-list", mode === "list");
  document.body.classList.toggle("ws-session", mode === "session");
}

function showSession() {
  if (phone.matches) setMode("session");
}

function showList() {
  setMode("list");
  render();
}

// The phone's top bar and pull request strip stand in for the one pane's own header.
function renderTop() {
  const leaf = focusedLeaf();
  const name = paneEls.get(leaf.pane)?.querySelector(".ws-pane-title").textContent || "";
  const heading = $("ws-title");
  heading.textContent = name;
  heading.title = name;
  const strip = $("pr-strip");
  const s = phone.matches && leaf.key ? sessionFor(leaf.key) : null;
  strip.hidden = !s?.pull;
  if (!s?.pull) return;
  const { text, tone, title: why } = pullLine(s);
  const ref = strip.querySelector(".ws-pr-ref");
  ref.className = `ws-pr-ref${tone ? ` ${tone}` : ""}`;
  ref.textContent = text;
  ref.title = why;
  strip.querySelector('[data-pr="merge"]').hidden = !canMerge(s);
  strip.querySelector('[data-pr="review"]').hidden = !asksReview(s);
}

function focusPane(id, { into = true } = {}) {
  const sp = space();
  if (!leaves(tab().root).some((l) => l.pane === id)) return;
  sp.focus = id;
  const leaf = focusedLeaf();
  if (leaf?.key) {
    done.delete(leaf.key);
    lookAt(leaf.key);
  }
  save();
  render();
  if (into) paneEls.get(id)?.querySelector("iframe")?.contentWindow?.postMessage({ yardbell: "focus" }, location.origin);
}

function reveal(key) {
  const sp = space();
  const ti = sp.tabs.findIndex((t) => leaves(t.root).some((l) => l.key === key));
  if (ti < 0) return false;
  sp.tab = ti;
  showSession();
  focusPane(leaves(sp.tabs[ti].root).find((l) => l.key === key).pane);
  return true;
}

function lookAt(key) {
  const s = sessionFor(key);
  if (s) window.YardbellTree.look(key, stateOf(s));
}

function open(key) {
  picked = null;
  done.delete(key);
  lookAt(key);
  const sp = space();
  sp.hidden = (sp.hidden || []).filter((k) => k !== key);
  sync();
  if (reveal(key)) return;
  const all = [focusedLeaf(), ...leaves(tab().root)];
  const target = all.find(isEmpty) || all.find((l) => !isDispatch(l) && !isDoc(l));
  showSession();
  if (!target) {
    const s = sessionFor(key);
    const leaf = { pane: newId(), key };
    sp.tabs.splice(sp.tab + 1, 0, { id: newId(), name: s ? tabName(sp, s) : key.split("/").pop(), root: leaf });
    sp.tab += 1;
    focusPane(leaf.pane);
    return;
  }
  target.key = key;
  focusPane(target.pane);
}

function findDispatch() {
  for (const [ti, t] of space().tabs.entries()) {
    const leaf = leaves(t.root).find(isDispatch);
    if (leaf) return { ti, leaf };
  }
  return null;
}

// Goes to the right of the focused pane, or takes the place of a tab's one empty pane. It does
// not move the focus, so a layout brought over from v4 keeps its focused session.
function placeDispatch(conversation) {
  const leaf = { pane: newId(), kind: "dispatch", conversation };
  const t = tab();
  const all = leaves(t.root);
  if (all.length === 1 && isEmpty(all[0])) {
    t.root = leaf;
    t.name = "Dispatch";
    space().focus = leaf.pane;
    return leaf;
  }
  const at = focusedLeaf();
  const parent = parentOf(t.root, at);
  const pair = { split: "row", ratio: 0.5, a: at, b: leaf };
  if (!parent) t.root = pair;
  else if (parent.a === at) parent.a = pair;
  else parent.b = pair;
  return leaf;
}

function openDispatch(conversation = "") {
  const found = findDispatch();
  if (!found) {
    const leaf = placeDispatch(conversation);
    focusPane(leaf.pane);
    return leaf;
  }
  const { ti, leaf } = found;
  if (conversation && conversation !== leaf.conversation) {
    leaf.conversation = conversation;
    const frame = dispatchFrame();
    if (frame) frame.src = dispatchSrc(conversation);
    if (!dispatchTitles.has(conversation)) loadDispatchTitles();
  }
  space().tab = ti;
  showSession();
  focusPane(leaf.pane);
  return leaf;
}

function dispatchFrame() {
  const found = findDispatch();
  return (found && paneEls.get(found.leaf.pane)?.querySelector("iframe[data-dispatch]")) || null;
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
  if (phone.matches) setMode("list");
  const sp = space();
  if (leaf.key) sp.hidden.push(leaf.key);
  if (removeLeaf(t, leaf)) {
    nameDispatchTab(t);
    sp.focus = leaves(t.root)[0].pane;
  } else if (sp.tabs.length > 1) {
    sp.tabs.splice(sp.tab, 1);
    switchTab(Math.min(sp.tab, sp.tabs.length - 1));
    return;
  } else if (isDispatch(leaf) || isDoc(leaf)) {
    t.root = { pane: newId(), key: null };
    t.name = "Agents";
    sp.focus = t.root.pane;
  } else {
    leaf.key = null;
  }
  save();
  render();
}

function ownTab(id) {
  const sp = space();
  const t = tab();
  const leaf = leaves(t.root).find((l) => l.pane === id);
  if (!leaf || isEmpty(leaf) || !removeLeaf(t, leaf)) return;
  const s = sessionFor(leaf.key);
  const name = isDispatch(leaf) ? "Dispatch" : isDoc(leaf) ? fileName(leaf) : s ? title(s) : leaf.key.split("/").pop();
  sp.tabs.splice(sp.tab + 1, 0, { id: newId(), name, root: leaf });
  sp.tab += 1;
  sp.focus = leaf.pane;
  save();
  render();
}

// Merging keeps the pane objects, so their terminals stay connected, and lays the target tab
// out as an even grid with the arriving panes after its own. A blank target is replaced.
function mergeTab(from, to) {
  const sp = space();
  const source = sp.tabs[from];
  const target = sp.tabs[to];
  if (!source || !target || source === target) return;
  const mine = leaves(target.root);
  const added = leaves(source.root);
  target.root = gridOf(mine.length === 1 && isEmpty(mine[0]) ? added : [...mine, ...added]);
  sp.tabs.splice(from, 1);
  sp.tab = sp.tabs.indexOf(target);
  sp.focus = added[0].pane;
  save();
  render();
}

function swapPanes(aId, bId) {
  const t = tab();
  const all = leaves(t.root);
  const a = all.find((l) => l.pane === aId);
  const b = all.find((l) => l.pane === bId);
  if (!a || !b || a === b) return;
  const pa = parentOf(t.root, a);
  const pb = parentOf(t.root, b);
  if (pa === pb) {
    const x = pa.a;
    pa.a = pa.b;
    pa.b = x;
  } else {
    if (pa.a === a) pa.a = b; else pa.b = b;
    if (pb.a === b) pb.a = a; else pb.b = a;
  }
  save();
  render();
}

function movePane(e, id) {
  e.preventDefault();
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  const start = { x: e.clientX, y: e.clientY };
  let target = null;
  let active = false;
  const mark = (el) => {
    if (el === target) return;
    target?.classList.remove("ws-move-into");
    target = el;
    target?.classList.add("ws-move-into");
  };
  const move = (ev) => {
    if (!active) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      active = true;
      $("panes").classList.add("moving");
      paneEls.get(id)?.classList.add("ws-move-src");
    }
    const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.classList?.contains("ws-pane") && !el.hidden);
    mark(over && over.dataset.pane !== id ? over : null);
  };
  const end = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    $("panes").classList.remove("moving");
    paneEls.get(id)?.classList.remove("ws-move-src");
    const to = ev.type === "pointerup" ? target : null;
    mark(null);
    if (to) swapPanes(id, to.dataset.pane);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
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
      if (item.matches("a[href]")) {
        closeMenu();
        return;
      }
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
  el.innerHTML = items.map((it, i) => {
    const inner = `${it.state ? dot(it.state) : ""}<span class="menu-label">${esc(it.label)}</span>${it.state ? `<span class="ws-item-word ${it.state}">${esc(WORD[it.state])}</span>` : ""}`;
    if (it.href) return `<a role="menuitem" data-i="${i}" href="${esc(it.href)}" target="_blank" rel="noopener">${inner}</a>`;
    return `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}${it.current ? ' aria-current="true"' : ""}>${inner}</button>`;
  }).join("");
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
        if (data.setup && !data.setup.ok) toast(`${window.YardbellWorktree.setupNote(data.setup)}. The agent started anyway.`);
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
    picked = { name, focus: saved.tabs.length ? focusedLeaf()?.key : null, tab: saved.tab };
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
    { label: `Move into ${other.name}`, run: () => mergeTab(i, j) },
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
$("side-add-project").addEventListener("click", addProject);

$("panes").addEventListener("pointerdown", (e) => {
  if (phone.matches || e.button !== 0) return;
  const head = e.target.closest(".ws-pane-head");
  if (!head || e.target.closest("button, a, select, input")) return;
  if (leaves(tab().root).length < 2) return;
  movePane(e, head.closest(".ws-pane").dataset.pane);
});

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
  else if (act === "main" && leaf) runMain(e.target.closest("[data-act]"), leaf);
  else if (act === "more" && leaf) paneMenu(e.target.closest("[data-act]"), leaf);
  else focusPane(id);
});

function runMain(button, leaf) {
  const s = sessionFor(leaf.key);
  const act = mainAction(s);
  if (act?.kind === "merge") mergeFrom(s, button);
  else if (act?.kind === "review") openReview(s.review.conversation);
}

async function mergeFrom(s, button) {
  const ref = window.YardbellPull.ref(s.pull);
  const text = window.YardbellPull.mergeText(s.pull);
  $("merge-confirm-title").textContent = text.title;
  $("merge-confirm-text").textContent = text.body;
  if ((await ask($("merge-confirm"))) !== "merge") return;
  button.disabled = true;
  try {
    await window.YardbellPull.merge(s);
    toast(`Merged ${ref}`);
    load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

function openReview(conversation) {
  if (phone.matches) location.href = dispatchSrc(conversation);
  else openDispatch(conversation);
}

function splitPane(id, dir) {
  space().focus = id;
  split(dir);
}

function copyText(id) {
  paneEls.get(id)?.querySelector("iframe")?.contentWindow?.postMessage({ yardbell: "text" }, location.origin);
}

function sessionItems(leaf) {
  const [machine, ...rest] = leaf.key.split("/");
  const name = rest.join("/");
  const swaps = phone.matches ? [] : leaves(tab().root).flatMap((other, n) => {
    if (other === leaf) return [];
    const s = other.key && sessionFor(other.key);
    const what = isDispatch(other) ? "Dispatch" : isDoc(other) ? fileName(other) : s ? title(s) : other.key ? other.key.split("/").pop() : "empty pane";
    return [{ label: `Swap with ${n + 1} · ${what}`, run: () => swapPanes(leaf.pane, other.pane) }];
  });
  const s = sessionFor(leaf.key);
  const review = window.YardbellPull.reviewable(s)
    ? [{ label: `Review ${window.YardbellPull.noun(s.pull).toLowerCase()} ${window.YardbellPull.ref(s.pull)}`, run: () => reviewPull(machine, name) }]
    : [];
  return [
    ...review,
    { label: "Insights", run: () => window.YardbellInsights.open({ machine, name, onSuggest: (data) => askDispatch(data) }) },
    { label: "Suggest a better prompt", run: () => askDispatch({ machine, name }) },
    ...swaps,
  ];
}

function reloadFile(leaf) {
  const body = paneEls.get(leaf.pane)?.querySelector(".ws-pane-body");
  if (!body) return;
  if (isDiff(leaf)) window.YardbellChanges.fillDiff(body, leaf, { reload: true });
  else window.YardbellSide.fillFile(body, leaf, { reload: true });
}

async function copyPath(leaf) {
  const path = `${leaf.root.replace(/\/$/, "")}/${leaf.path}`;
  try {
    await navigator.clipboard.writeText(path);
    toast(`Copied ${short(path)}`);
  } catch {
    toast(path);
  }
}

// A file or a diff opens in a tab of its own after the current one, or goes to the tab already
// showing it.
function openFile({ machine, root, path }) {
  openDoc({ kind: "file", machine, root, path }, (l) => isFile(l));
}

function openDiff({ machine, root, path, staged }) {
  openDoc({ kind: "diff", machine, root, path, staged: Boolean(staged) }, (l) => isDiff(l) && Boolean(l.staged) === Boolean(staged));
}

function openDoc(want, same) {
  const sp = space();
  for (const [ti, t] of sp.tabs.entries()) {
    const leaf = leaves(t.root).find((l) => same(l) && l.machine === want.machine && l.root === want.root && l.path === want.path);
    if (!leaf) continue;
    sp.tab = ti;
    showSession();
    focusPane(leaf.pane);
    return;
  }
  const leaf = { pane: newId(), ...want };
  const t = tab();
  const all = leaves(t.root);
  if (all.length === 1 && isEmpty(all[0])) {
    t.root = leaf;
    t.name = fileName(leaf);
  } else {
    const taken = new Set(sp.tabs.map((x) => x.name));
    let name = fileName(leaf);
    for (let n = 2; taken.has(name); n++) name = `${fileName(leaf)} ${n}`;
    sp.tabs.splice(sp.tab + 1, 0, { id: newId(), name, root: leaf });
    sp.tab += 1;
  }
  showSession();
  focusPane(leaf.pane);
}

// Where the side panel looks: the open file's folder, else the folder of the focused session
// or the one picked in the tree.
function sideWhere() {
  const leaf = saved.tabs.length ? focusedLeaf() : null;
  if (isDoc(leaf) && leaf.machine && leaf.root) return { machine: leaf.machine, path: leaf.root };
  const f = home();
  if (f?.path) return { machine: f.machine, path: f.path };
  const s = leaf?.key ? sessionFor(leaf.key) : null;
  const path = s?.path || s?.cwd;
  return s && path ? { machine: s.machine, path } : null;
}

async function resumePast({ machine, path, id }) {
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ machine, path, agent: "claude", resume_id: id, wait: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not resume the session (${res.status})`);
    const key = `${machine}/${data.name}`;
    await load();
    open(key);
  } catch (err) {
    toast(err.message);
  }
}

// A phone shows one pane at a time, so it has nothing to split or move into a tab of its own.
function paneMenu(button, leaf) {
  if ($("ws-menu")?.trigger === button && !$("ws-menu").hidden) {
    closeMenu();
    return;
  }
  const id = leaf.pane;
  const desk = !phone.matches;
  const splits = desk ? [
    { label: "Split right", run: () => splitPane(id, "row") },
    { label: "Split down", run: () => splitPane(id, "col") },
  ] : [];
  const own = desk && !isEmpty(leaf) && leaves(tab().root).length > 1 ? [{ label: "Move to its own tab", run: () => ownTab(id) }] : [];
  const close = { label: "Close", run: () => closePane(id) };
  let items;
  if (isDispatch(leaf)) items = [{ label: "Open in its own tab", href: dispatchSrc(leaf.conversation) }, ...splits, ...own, close];
  else if (isDoc(leaf)) items = [
    { label: "Reload", run: () => reloadFile(leaf) },
    { label: "Copy path", run: () => copyPath(leaf) },
    ...splits,
    ...own,
    close,
  ];
  else if (isEmpty(leaf)) items = [...splits, close];
  else items = [
    { label: "Copy text", run: () => copyText(id) },
    { label: "Open in its own tab", href: termSrc(leaf.key) },
    ...splits,
    ...own,
    ...sessionItems(leaf),
    close,
  ];
  showMenu(button.getBoundingClientRect(), items, button);
}

// The review runs in Dispatch, so the conversation it went to opens in the Dispatch pane, or on
// a phone as the Dispatch page.
async function reviewPull(machine, name) {
  let conversation;
  try {
    conversation = await window.YardbellPull.review(machine, name);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (phone.matches) {
    location.href = dispatchSrc(conversation);
    return;
  }
  const shown = findDispatch()?.leaf.conversation === conversation;
  openDispatch(conversation);
  const frame = dispatchFrame();
  if (shown && frame) frame.src = dispatchSrc(conversation);
}

// The Dispatch pane takes the request; on a phone the Dispatch page does.
function askDispatch({ machine, name }) {
  if (phone.matches) {
    window.YardbellInsights.handOver({ machine, name });
    return;
  }
  openDispatch();
  const frame = dispatchFrame();
  if (!frame) {
    window.YardbellInsights.handOver({ machine, name });
    return;
  }
  const post = () => frame.contentWindow?.postMessage({ yardbell: "suggest", machine, name }, location.origin);
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/dispatch") post();
  else frame.addEventListener("load", post, { once: true });
}

$("panes").addEventListener("change", (e) => {
  const select = e.target.closest("[data-start-other]");
  const pane = e.target.closest(".ws-pane");
  const leaf = pane && leaves(tab().root).find((l) => l.pane === pane.dataset.pane);
  if (select?.value && leaf) startHere(leaf, select.value);
});

$("back").addEventListener("click", showList);
$("ws-more").addEventListener("click", (e) => paneMenu(e.currentTarget, focusedLeaf()));

$("pr-strip").addEventListener("click", (e) => {
  const button = e.target.closest("[data-pr]");
  const s = button && sessionFor(focusedLeaf()?.key);
  if (!s) return;
  if (button.dataset.pr === "merge" && canMerge(s)) mergeFrom(s, button);
  else if (button.dataset.pr === "review" && asksReview(s)) openReview(s.review.conversation);
});

$("keys-btn").addEventListener("click", () => $("keys").showModal());
$("keys-close").addEventListener("click", () => $("keys").close());

window.addEventListener("yardbell-app", (e) => {
  document.querySelectorAll(".ws-pane iframe").forEach((f) => f.contentWindow?.postMessage({ yardbell: "app", state: e.detail }, location.origin));
});

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.yardbell === "key") shortcut(e.data.code);
  if (e.data?.yardbell === "palette") window.YardbellPalette?.open();
  if (e.data?.yardbell !== "focused") return;
  for (const [id, el] of paneEls) {
    if (el.querySelector("iframe")?.contentWindow === e.source && id !== space().focus) focusPane(id, { into: false });
  }
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (shortcut(e.code)) e.preventDefault();
});

phone.addEventListener("change", () => {
  if (!phone.matches) setMode(null);
  else setMode(focusedLeaf()?.key ? "session" : "list");
  render();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  trackActivity();
  render();
});

function followLink() {
  const query = new URLSearchParams(location.search);
  const split = (value) => {
    const at = value.indexOf("/");
    return at < 0 ? null : { machine: value.slice(0, at), rest: value.slice(at + 1) };
  };
  const wantOpen = split(query.get("open") || "");
  const wantFolder = split(query.get("folder") || "");
  history.replaceState(null, "", "/workspace");
  if (wantOpen) {
    const key = `${wantOpen.machine}/${wantOpen.rest}`;
    if (sessionFor(key)) {
      open(key);
      return;
    }
    const gone = (state.ended || []).find((e) => e.id === `${wantOpen.machine}:${wantOpen.rest}`);
    if (gone) openSpace(`${gone.machine}${SEP}${gone.folder}`);
    let leaf = leaves(tab().root).find(isEmpty);
    if (!leaf) {
      const sp = space();
      leaf = { pane: newId(), key: null };
      sp.tabs.splice(sp.tab + 1, 0, { id: newId(), name: "Agents", root: leaf });
      sp.tab += 1;
    }
    leaf.ended = true;
    showSession();
    focusPane(leaf.pane, { into: false });
  } else if (wantFolder && (state.folders || []).some((f) => f.machine === wantFolder.machine)) {
    openSpace(`${wantFolder.machine}${SEP}${wantFolder.rest}`);
  }
}

let linked = false;

async function load() {
  try {
    const res = await fetch("/state", { headers: { Accept: "application/json" } });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) return;
    state = await res.json();
    window.YardbellShell.update(state);
    trackActivity();
    render();
    if (!linked) {
      linked = true;
      followLink();
    }
  } catch {}
}

restore();
if (phone.matches) setMode("list");
// The sessions a folder's notes can go to: any session running in it, or in a folder holding it.
function sessionsIn(machine, root) {
  const inside = (path, base) => {
    const b = String(base || "").replace(/\/$/, "");
    return Boolean(b) && (path === b || String(path).startsWith(`${b}/`));
  };
  return sessions()
    .filter((s) => !s.stale && s.machine === machine)
    .filter((s) => {
      const at = s.path || s.cwd;
      return at && (inside(at, root) || inside(root, at));
    })
    .map((s) => ({ machine: s.machine, tmux: s.tmux, label: title(s) }));
}

window.YardbellSide.init({ where: () => (state ? sideWhere() : null), openFile, openDiff, sessionsIn, toast, resume: resumePast });
load();
window.YardbellLive.follow(load, 3000);

window.YardbellShell.stateOf = stateOf;

window.addEventListener("yardbell-jump", (e) => {
  const { kind, id } = e.detail;
  if (kind === "session" && sessionFor(id)) open(id);
  else if (kind === "folder") openSpace(`${id.machine}${SEP}${id.folder}`);
  else if (kind === "conversation" && !phone.matches) openDispatch(id);
  else return;
  e.preventDefault();
});

window.YardbellShell.onRail((page) => {
  if (page !== "dispatch" || phone.matches) return false;
  const shown = leaves(tab().root).find(isDispatch);
  if (shown) closePane(shown.pane);
  else openDispatch();
  return true;
});

function syncDispatchPressed() {
  window.YardbellShell.pressed("dispatch", !phone.matches && leaves(tab().root).some(isDispatch));
}

function dispatchLeafOf(source) {
  for (const t of space().tabs) {
    const leaf = leaves(t.root).find((l) => isDispatch(l) && paneEls.get(l.pane)?.querySelector("iframe[data-dispatch]")?.contentWindow === source);
    if (leaf) return leaf;
  }
  return null;
}

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.yardbell !== "dispatch") return;
  if (e.data.action === "open" && typeof e.data.key === "string") open(e.data.key);
  if (e.data.action !== "conversation" || typeof e.data.id !== "string") return;
  const leaf = dispatchLeafOf(e.source);
  if (!leaf || leaf.conversation === e.data.id) return;
  leaf.conversation = e.data.id;
  save();
  if (e.data.id && !dispatchTitles.has(e.data.id)) loadDispatchTitles();
  else render();
});
