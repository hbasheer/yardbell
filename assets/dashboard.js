const $ = (id) => document.getElementById(id);
const onHost = ["localhost", "127.0.0.1"].includes(location.hostname);
const Nav = window.YardbellNav;
let current = null;
let lastJson = "";
let lastRender = 0;
let lastOk = 0;
let focusedId = "";
let selected = new URLSearchParams(location.search).get("machine") || "";
const filters = { q: "", status: "all" };
let sshHosts = null;

const ICONS = {
  open: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6 7.5 3 10.5M7.5 11.5H13"/></svg>',
  external: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3H13v3.5M13 3 7.5 8.5M11 9.5V13H3V5h3.5"/></svg>',
  chevron: '<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  more: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="0.6"/><circle cx="8" cy="8" r="0.6"/><circle cx="12.5" cy="8" r="0.6"/></svg>',
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function short(path) {
  return String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
}

function gb(kb) {
  return (kb / 1048576).toFixed(1);
}

function ago(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  let mins = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
  if (mins < 0) mins += 24 * 60;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function toast(message, kind = "error") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("logged out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function tone(status) {
  if (status === "tunnel up" || status === "running") return "ok";
  if (status === "app not running" || status === "not forwardable") return "warn";
  return "bad";
}

function connection(m) {
  if (m.up) {
    const load = m.health
      ? ` · load ${Number(m.health.load1).toFixed(1)}${m.health.cpus ? ` / ${m.health.cpus} CPUs` : ""}`
      : "";
    const how = m.local ? "This machine" : m.mesh_on === false ? "Connected over LAN, VPN off" : "Connected";
    return `${how}${load}`;
  }
  if (m.reason === "no mesh") {
    return current?.mesh?.on === false ? "Unreachable: host VPN off" : "Not on the mesh (VPN off or asleep)";
  }
  const reason = (m.reason || "checking").replace(/^ssh\b/, "SSH");
  const seen = m.last_seen ? ` · last seen ${ago(m.last_seen)}` : "";
  return `${reason[0].toUpperCase()}${reason.slice(1)}${seen}`;
}

function renderMeshBanner(mesh) {
  const banner = $("mesh-banner");
  banner.hidden = !mesh || mesh.on !== false;
  if (banner.hidden) return;
  const button = mesh.can_turn_on
    ? `<button class="btn primary" type="button" data-act="mesh-on">Turn on ${esc(mesh.label)}</button>` : "";
  banner.innerHTML = `<div class="banner-text">
      <strong>${esc(mesh.label)} is off on this machine.</strong>
      <span>Other machines and your phone cannot reach Yardbell or its tunnels. ${esc(mesh.hint || "")}</span>
    </div>${button}`;
}

function memory(m) {
  const h = m.health;
  if (!m.up || !h || !h.mem_total_kb) return "";
  const used = Math.min(h.mem_used_kb / h.mem_total_kb, 1);
  const agents = Math.min(h.agent_kb / h.mem_total_kb, used);
  const otherKb = Math.max(h.mem_used_kb - h.agent_kb, 0);
  const freeKb = Math.max(h.mem_total_kb - h.mem_used_kb, 0);
  const pct = Nav.memPct(m);
  const level = pct >= 95 ? " full" : pct >= Nav.RATED ? " hot" : "";
  const label = `Memory ${pct}% used of ${gb(h.mem_total_kb)} GB: agents ${gb(h.agent_kb)} GB, other ${gb(otherKb)} GB, free ${gb(freeKb)} GB`;
  return `<div class="mem${level}">
    <div class="mem-head"><span><span class="mem-pct">${pct}% used</span> of ${gb(h.mem_total_kb)} GB</span></div>
    <div class="mem-bar" role="img" aria-label="${esc(label)}">
      <span class="mem-agents" style="width:${(agents * 100).toFixed(1)}%"></span>
      <span class="mem-other" style="width:${((used - agents) * 100).toFixed(1)}%"></span>
    </div>
    <div class="mem-legend">
      <span><i class="key agents"></i>Agents ${gb(h.agent_kb)} GB</span>
      <span><i class="key other"></i>Other ${gb(otherKb)} GB</span>
      <span><i class="key free"></i>Free ${gb(freeKb)} GB</span>
    </div>
  </div>`;
}

function statusBadge(s) {
  if (s.stale) return `<span class="badge">Last known</span>`;
  return s.activity === "active"
    ? `<span class="badge busy" title="Estimated from CPU use">Working</span>`
    : `<span class="badge" title="Estimated from CPU use">Idle</span>`;
}

function ports(s) {
  if (!s.ports.length) return "";
  return `<ul class="port-list">${s.ports.map((p) => {
    const name = `<span class="svc">${esc(p.service)}</span><span class="num">:${p.local ?? p.remote}</span>`;
    const state = `<span class="dot ${tone(p.status)}" title="${esc(p.status)}"></span>`;
    const body = p.url
      ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.status)}, remote port ${p.remote}">${state}${name}${ICONS.external}</a>`
      : `<span>${state}${name}</span>`;
    return `<li>${body}<span class="port-status ${tone(p.status)}">${esc(p.status)}</span></li>`;
  }).join("")}</ul>`;
}

function termUrl(s) {
  return `/term/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}`;
}

function actions(s) {
  if (!s.attachable || s.stale) return "";
  const host = onHost && current.host_terminal !== "none"
    ? `<button class="btn" type="button" data-act="host" data-machine="${esc(s.machine)}" data-name="${esc(s.tmux)}">Terminal app</button>` : "";
  return `<div class="row-actions">
    <a class="btn" href="${termUrl(s)}" target="_blank" rel="noopener">${ICONS.open}Open</a>${host}
    <button class="btn quiet danger stop" type="button" data-act="stop" data-machine="${esc(s.machine)}" data-name="${esc(s.tmux)}">Stop</button>
  </div>`;
}

function filtering() {
  return Boolean(filters.q) || filters.status !== "all";
}

function matchesText(fields) {
  return !filters.q || fields.join(" ").toLowerCase().includes(filters.q);
}

function matches(s) {
  if (filters.status !== "all" && (s.stale || s.activity !== filters.status)) return false;
  return matchesText([s.folder, s.branch, s.ticket === "-" ? "" : s.ticket, agentLabel(s.agent), s.machine]);
}

function matchesEnded(e) {
  return filters.status === "all" && matchesText([e.folder, e.ticket === "-" ? "" : e.ticket, agentLabel(e.agent), e.machine]);
}

function agentLabel(name) {
  return (current?.agents || []).find((a) => a.name === name)?.label || name;
}

function identity(s, extra = "") {
  const ticket = s.ticket !== "-" ? `<span class="ticket">${esc(s.ticket)}</span>` : "";
  const branch = s.branch ? `<span class="branch">${esc(s.branch)}</span>` : "";
  const agent = s.agent ? `<span class="agent">${esc(agentLabel(s.agent))}</span>` : "";
  return `<div class="s-line"><span class="folder">${esc(short(s.folder))}</span>${ticket}${extra}</div>
    <div class="s-sub">${branch}${agent}</div>`;
}

function sessionRow(s) {
  const openable = s.attachable && !s.stale;
  const attrs = openable
    ? ` class="s-row openable${focusedId === s.id ? " kb" : ""}" data-id="${esc(s.id)}" data-href="${esc(termUrl(s))}" tabindex="0" aria-label="Open ${esc(short(s.folder))} on ${esc(s.machine)}"`
    : ` class="s-row${s.stale ? " stale" : ""}"`;
  return `<li${attrs}>
    <div class="s-main">${identity(s)}</div>
    <div class="s-status">${statusBadge(s)}</div>
    <div class="s-ports">${ports(s)}</div>
    <div class="s-actions">${actions(s)}</div>
  </li>`;
}

function looseRow(s) {
  const busy = s.activity === "active" ? `<span class="badge busy" title="Estimated from CPU use">Working</span>` : "";
  return `<li class="sub-row">
    <div class="s-main">${identity(s, busy)}</div>
    <div class="row-actions">
      <button class="btn" type="button" data-act="move" data-machine="${esc(s.machine)}" data-pid="${s.pid}" data-folder="${esc(short(s.folder))}" data-agent="${esc(s.agent)}" data-busy="${s.activity === "active"}">Move to tmux</button>
      <button class="btn quiet danger" type="button" data-act="stop-pid" data-machine="${esc(s.machine)}" data-pid="${s.pid}" data-folder="${esc(short(s.folder))}" data-agent="${esc(s.agent)}" data-busy="${s.activity === "active"}">Stop</button>
    </div>
  </li>`;
}

function endedRow(e) {
  return `<li class="sub-row">
    <div class="s-main">${identity({ ...e, branch: "" })}</div>
    <div class="row-actions">
      <button class="btn" type="button" data-act="resume" data-machine="${esc(e.machine)}" data-folder="${esc(e.folder)}" data-agent="${esc(e.agent)}">Resume</button>
      <button class="btn quiet" type="button" data-act="forget" data-id="${esc(e.id)}">Forget</button>
    </div>
  </li>`;
}

function panelKey(kind, machine) {
  return `open:${kind}:${machine}`;
}

function disclosure(kind, m, count, label, body) {
  if (!count) return { toggle: "", panel: "" };
  const open = filtering() || remembered(panelKey(kind, m.name)) === "1";
  const id = `${kind}-${m.name.replace(/[^a-z0-9-]/gi, "-")}`;
  return {
    toggle: `<button type="button" class="mg-toggle" data-toggle="${kind}" data-machine="${esc(m.name)}" aria-expanded="${open}" aria-controls="${id}">${ICONS.chevron}<span class="mg-toggle-count">${count}</span>${label}</button>`,
    panel: `<div class="mg-panel" id="${id}"${open ? "" : " hidden"}>${body}</div>`,
  };
}

function machineActions(m) {
  const name = esc(m.name);
  const work = m.up
    ? `<button class="btn icon-btn quiet" type="button" data-act="new" data-machine="${name}" aria-label="New session on ${name}" title="New session on ${name}">${ICONS.plus}</button>
       <button class="btn icon-btn quiet" type="button" data-act="shell" data-machine="${name}" aria-label="Open a shell on ${name}" title="Open a shell on ${name}">${ICONS.open}</button>`
    : "";
  return `<div class="mg-actions">${work}<button class="btn icon-btn quiet" type="button" data-act="more" data-machine="${name}" data-local="${m.local}" aria-label="More for ${name}" title="More" aria-haspopup="menu" aria-expanded="false">${ICONS.more}</button></div>`;
}

function group(state, m) {
  const mine = state.sessions.filter((s) => s.machine === m.name);
  const rows = mine.filter((s) => (s.attachable || s.stale) && matches(s));
  const loose = mine.filter((s) => !s.attachable && !s.stale && matches(s));
  const ended = state.ended.filter((e) => e.machine === m.name && matchesEnded(e));
  if (filtering() && !rows.length && !loose.length && !ended.length) return "";
  const live = mine.filter((s) => !s.stale).length;
  const collapsed = !filtering() && remembered(`collapsed:${m.name}`) === "1";
  const looseHelp = `<p class="loose-help">Yardbell can only open sessions that run in tmux. Move one to stop its agent and start it again in tmux with the same conversation, or <a href="https://github.com/hbasheer/yardbell#making-every-session-openable" target="_blank" rel="noopener">start agents inside tmux</a> from now on.</p>`;
  const outside = disclosure("loose", m, loose.length, "outside tmux", `${looseHelp}<ul class="sub-list">${loose.map(looseRow).join("")}</ul>`);
  const gone = disclosure("ended", m, ended.length, "ended", `<ul class="sub-list">${ended.map(endedRow).join("")}</ul>`);
  const empty = filtering()
    ? `<li class="s-empty"><span>No matching open sessions</span></li>`
    : m.up
    ? `<li class="s-empty"><span>No open sessions</span><button class="btn quiet" type="button" data-act="new" data-machine="${esc(m.name)}">Start one</button></li>`
    : `<li class="s-empty"><span>Unreachable. Its sessions reappear when it reconnects.</span></li>`;
  const foot = outside.toggle || gone.toggle
    ? `<div class="mg-foot">${outside.toggle}${gone.toggle}</div>${outside.panel}${gone.panel}` : "";
  const bodyId = `mg-body-${m.name.replace(/[^a-z0-9-]/gi, "-")}`;
  const body = collapsed ? "" : `<div id="${bodyId}"><ul class="s-list">${rows.length ? rows.map(sessionRow).join("") : empty}</ul>${foot}</div>`;
  const state_ = m.up ? (Nav.memPct(m) >= Nav.RATED ? " hot" : "") : " down";
  const dot = m.up ? (state_ === " hot" ? "warn" : "ok") : "bad";
  const fold = filtering()
    ? `<span class="mg-fold" aria-hidden="true"></span>`
    : `<button type="button" class="mg-fold" data-collapse="${esc(m.name)}" aria-expanded="${!collapsed}" aria-controls="${bodyId}" aria-label="${collapsed ? "Show" : "Hide"} sessions on ${esc(m.name)}">${ICONS.chevron}</button>`;
  return `<section class="mgroup${state_}${collapsed ? " collapsed" : ""}" aria-labelledby="mg-${esc(m.name)}">
    <header class="mg-head">
      <div class="mg-id">
        <div class="mg-title">${fold}<span class="dot ${dot}"></span><h2 id="mg-${esc(m.name)}">${esc(m.name)}</h2>${m.up ? `<span class="mg-count">${plural(live, "session")}</span>` : ""}</div>
        <p class="mg-conn">${esc(connection(m))}</p>
      </div>
      ${memory(m) || `<div class="mem" aria-hidden="true"></div>`}
      ${machineActions(m)}
    </header>
    ${body}
  </section>`;
}

function renderCounts(state) {
  const live = state.sessions.filter((s) => !s.stale && (!selected || s.machine === selected));
  $("count-all").textContent = live.length;
  $("count-active").textContent = live.filter((s) => s.activity === "active").length;
  $("count-idle").textContent = live.filter((s) => s.activity === "idle").length;
  document.querySelectorAll(".segmented [data-status]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.status === filters.status)));
}

function renderGroups(state) {
  const machine = state.machines.find((m) => m.name === selected);
  const machines = Nav.order(state.machines).filter((m) => !selected || m.name === selected);
  $("title").textContent = machine ? machine.name : "Sessions";
  renderCounts(state);
  const visible = state.sessions.filter((s) => (!selected || s.machine === selected) && (s.attachable || s.stale) && matches(s));
  if (focusedId && !visible.some((s) => s.id === focusedId)) focusedId = "";
  $("groups").classList.toggle("no-ports", !visible.some((s) => s.ports.length));
  const key = focusKey(document.activeElement);
  if (!machines.length) {
    $("groups").innerHTML = `<div class="empty"><p>No machines yet. Add one to see its agent sessions here.</p><a class="btn primary" href="/add">Add machine</a></div>`;
  } else {
    const html = machines.map((m) => group(state, m)).join("");
    $("groups").innerHTML = html || `<div class="empty"><p>No sessions match${filters.q ? ` "${esc(filters.q)}"` : ""}.</p><button class="btn" type="button" data-act="clear-filters">Clear filters</button></div>`;
  }
  refocus(key);
  keepMenuTrigger();
}

const FOCUS_KEYS = ["data-act", "data-collapse", "data-toggle", "data-machine", "data-name", "data-pid", "data-id", "data-folder", "href"];

function focusKey(el) {
  const groups = $("groups");
  if (!(el instanceof HTMLElement) || el === groups || !groups.contains(el)) return null;
  const attrs = FOCUS_KEYS.filter((a) => el.hasAttribute(a)).map((a) => `[${a}="${CSS.escape(el.getAttribute(a))}"]`).join("");
  if (!attrs) return null;
  const selector = el.localName + attrs;
  return { selector, index: [...groups.querySelectorAll(selector)].indexOf(el), visible: el.matches(":focus-visible") };
}

function refocus(key) {
  if (!key) return;
  const found = $("groups").querySelectorAll(key.selector);
  (found[key.index] || found[0])?.focus({ preventScroll: true, focusVisible: key.visible });
}

function render(state) {
  if (selected && !state.machines.some((m) => m.name === selected)) selected = "";
  Nav.render(state, selected);
  renderMeshBanner(state.mesh);
  renderGroups(state);
}

async function refresh() {
  try {
    const res = await fetch("/state", { headers: { Accept: "application/json" } });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) throw new Error(`status ${res.status}`);
    Nav.checkBuild(res);
    const text = await res.text();
    lastOk = Date.now();
    $("offline").hidden = true;
    if (text !== lastJson || Date.now() - lastRender > 30000) {
      lastJson = text;
      lastRender = Date.now();
      current = JSON.parse(text);
      render(current);
    }
  } catch {
    $("offline").hidden = false;
  }
  tick();
}

function tick() {
  const el = $("updated");
  if (!lastOk) { el.textContent = ""; return; }
  const secs = Math.max(0, Math.round((Date.now() - lastOk) / 1000));
  el.textContent = secs < 3 ? "Updated just now" : `Updated ${secs}s ago`;
  el.classList.toggle("late", secs > 15);
}

function openRow(row) {
  if (row?.dataset.href) window.open(row.dataset.href, "_blank", "noopener");
}

function moveFocus(step) {
  const rows = [...document.querySelectorAll("#groups .s-row.openable")];
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.dataset.id === focusedId);
  i = i < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(Math.max(i + step, 0), rows.length - 1);
  rows.forEach((r) => r.classList.remove("kb"));
  rows[i].classList.add("kb");
  rows[i].focus();
  focusedId = rows[i].dataset.id;
}

$("groups").addEventListener("click", (e) => {
  const fold = e.target.closest("[data-collapse]");
  if (fold) {
    const name = fold.dataset.collapse;
    remember(`collapsed:${name}`, fold.getAttribute("aria-expanded") === "true" ? "1" : "0");
    if (current) render(current);
    return;
  }
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    $(toggle.getAttribute("aria-controls")).hidden = !open;
    remember(panelKey(toggle.dataset.toggle, toggle.dataset.machine), open ? "1" : "0");
    return;
  }
  if (e.target.closest("a, button")) return;
  openRow(e.target.closest(".s-row.openable"));
});

$("groups").addEventListener("focusin", (e) => {
  const row = e.target.closest(".s-row.openable");
  if (row) focusedId = row.dataset.id;
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape" && !$("menu").hidden) { closeMenu(true); return; }
  if (e.target.closest("input, select, textarea, dialog[open]")) return;
  if (e.key === "/") { e.preventDefault(); $("search").focus(); return; }
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveFocus(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); moveFocus(-1); }
  else if (e.key === "Enter" && e.target.closest(".s-row.openable")) { e.preventDefault(); openRow(e.target.closest(".s-row.openable")); }
  else if (e.key === "n") { e.preventDefault(); openNew(); }
});

$("nav-machines").addEventListener("click", (e) => {
  const link = e.target.closest("a[data-machine]");
  if (!link) return;
  e.preventDefault();
  selected = link.dataset.machine;
  history.replaceState(null, "", selected ? `/?machine=${encodeURIComponent(selected)}` : "/");
  if (current) render(current);
});

function applyFilters() {
  if (current) render(current);
}

$("search").addEventListener("input", (e) => {
  filters.q = e.target.value.trim().toLowerCase();
  applyFilters();
});

$("search").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.target.value = "";
  filters.q = "";
  e.target.blur();
  applyFilters();
});

document.querySelector(".segmented").addEventListener("click", (e) => {
  const b = e.target.closest("[data-status]");
  if (!b) return;
  filters.status = b.dataset.status;
  applyFilters();
});

// /state is the server's last machine check, which can be poll_seconds old, so after an action
// that changes sessions the machines are checked again before the list is drawn.
async function checkNow() {
  await api("POST", "/refresh");
  await refresh();
}

$("refresh-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.classList.add("spinning");
  try {
    await checkNow();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.classList.remove("spinning");
  }
});

async function loadSshHosts() {
  if (sshHosts) return;
  try {
    const data = await api("GET", "/api/settings");
    sshHosts = Object.fromEntries(data.machines.map((m) => [m.name, m.ssh || m.name]));
  } catch {
    sshHosts = null;
  }
}

function copyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
  return ok;
}

let menuButton = null;

function closeMenu(focusButton) {
  $("menu").hidden = true;
  if (menuButton) {
    menuButton.setAttribute("aria-expanded", "false");
    if (focusButton) menuButton.focus();
  }
  menuButton = null;
}

function placeMenu(button) {
  const menu = $("menu");
  const r = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - width, innerWidth - width - 8)))}px`;
}

function openMenu(button) {
  const name = button.dataset.machine;
  const local = button.dataset.local === "true";
  const menu = $("menu");
  menu.innerHTML = `<a role="menuitem" href="/settings#machine-${esc(name)}">Machine settings</a>${local ? "" : `
    <button type="button" role="menuitem" data-act="copy-ssh" data-machine="${esc(name)}">Copy ssh command</button>
    <button type="button" role="menuitem" class="danger" data-act="remove" data-machine="${esc(name)}">Remove machine…</button>`}`;
  menu.hidden = false;
  placeMenu(button);
  button.setAttribute("aria-expanded", "true");
  menuButton = button;
  menu.querySelector("[role=menuitem]").focus();
  if (!local) loadSshHosts();
}

function keepMenuTrigger() {
  if (!menuButton || menuButton.isConnected) return;
  const trigger = $("groups").querySelector(`[data-act="more"][data-machine="${CSS.escape(menuButton.dataset.machine)}"]`);
  if (!trigger) {
    closeMenu(false);
    return;
  }
  trigger.setAttribute("aria-expanded", "true");
  menuButton = trigger;
  placeMenu(trigger);
}

async function ask(title, body, options) {
  const key = focusKey(document.activeElement);
  const yes = await Nav.confirm(title, body, options);
  if (!document.activeElement || document.activeElement === document.body) refocus(key);
  return yes;
}

$("menu").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...$("menu").querySelectorAll("[role=menuitem]")];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
});

document.addEventListener("click", (e) => {
  if ($("menu").hidden) return;
  if (e.target.closest("#menu") || e.target.closest("[data-act=more]") === menuButton) return;
  closeMenu(false);
}, true);

window.addEventListener("resize", () => closeMenu(false));

async function openShell(machine) {
  const tab = window.open("about:blank", "_blank");
  try {
    const res = await api("POST", `/machines/${encodeURIComponent(machine)}/shell`);
    const url = `/term/${encodeURIComponent(machine)}/${encodeURIComponent(res.name)}`;
    if (tab) tab.location.href = url; else location.href = url;
  } catch (err) {
    if (tab) tab.close();
    toast(err.message);
  }
}

async function startAndOpen(body) {
  const tab = window.open("about:blank", "_blank");
  try {
    const res = await api("POST", "/sessions", body);
    const url = `/term/${encodeURIComponent(body.machine)}/${encodeURIComponent(res.name)}`;
    if (tab) tab.location.href = url; else location.href = url;
  } catch (err) {
    if (tab) tab.close();
    throw err;
  }
}

const nm = { machine: "", listing: null, branches: null, picked: "" };

function folderIcon(git) {
  return git
    ? '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5c0 2-3 2-5.5 3"/></svg>'
    : '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/></svg>';
}

async function browseTo(path) {
  $("dir-list").innerHTML = `<li class="dir-empty">Loading…</li>`;
  try {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    const l = await api("GET", `/machines/${encodeURIComponent(nm.machine)}/browse${q}`);
    nm.listing = l;
    renderBrowser(l);
    await loadBranches();
  } catch (err) {
    $("dir-list").innerHTML = `<li class="dir-empty error">${esc(err.message)}</li>`;
  }
}

function tail(path) {
  const parts = short(path).split("/").filter((p) => p && p !== "~");
  return parts.length ? parts.slice(-2).join("/") : short(path);
}

function renderRecent(recent) {
  $("recent").innerHTML = recent.length
    ? `<span class="recent-label">Recent</span>` + recent.map((p) => `<span class="recent-chip">
        <button type="button" class="recent-go" data-path="${esc(p)}" title="${esc(short(p))}">${esc(tail(p))}</button>
        <button type="button" class="recent-x" data-forget="${esc(p)}" aria-label="Remove ${esc(tail(p))} from Recent" title="Remove from Recent">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>
        </button>
      </span>`).join("")
    : "";
}

async function forgetRecent(path) {
  try {
    const res = await api("POST", `/machines/${encodeURIComponent(nm.machine)}/recent/forget`, { path });
    if (nm.listing) nm.listing.recent = res.recent;
    renderRecent(res.recent);
  } catch (err) {
    toast(err.message);
  }
}

function renderBrowser(l) {
  renderRecent(l.recent);
  const parts = l.path.split("/").filter(Boolean);
  const crumbs = [`<button type="button" class="crumb home" data-path="~">Home</button><span class="crumb-divider"></span>`, `<button type="button" class="crumb" data-path="/">/</button>`];
  parts.forEach((p, i) => crumbs.push(`${i ? `<span class="sep">/</span>` : ""}<button type="button" class="crumb${i === parts.length - 1 ? " here" : ""}" data-path="/${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`));
  $("crumbs").innerHTML = crumbs.join("");
  const up = parts.length ? `<li><button type="button" class="dir" data-path="/${esc(parts.slice(0, -1).join("/"))}"><span class="dir-name">..</span></button></li>` : "";
  $("dir-list").innerHTML = up + (l.entries.length
    ? l.entries.map((e) => `<li><button type="button" class="dir${e.git ? " git" : ""}" data-path="${esc(`${l.path.replace(/\/$/, "")}/${e.name}`)}">
        ${folderIcon(e.git)}<span class="dir-name">${esc(e.name)}</span>${e.git && e.branch ? `<span class="dir-branch">${esc(e.branch)}</span>` : ""}
      </button></li>`).join("")
    : `<li class="dir-empty">No subfolders</li>`);
  updateWhere();
}

async function loadBranches() {
  const l = nm.listing;
  nm.branches = null;
  nm.picked = "";
  $("branch-step").hidden = !l?.git;
  if (!l?.git) { updateWhere(); return; }
  $("current-branch").textContent = l.branch || "detached HEAD";
  setMode("stay");
  try {
    nm.branches = await api("GET", `/machines/${encodeURIComponent(nm.machine)}/branches?path=${encodeURIComponent(l.path)}`);
    const bases = [nm.branches.default_base, ...nm.branches.local, ...nm.branches.remote.map((r) => `origin/${r}`)].filter((v, i, a) => v && a.indexOf(v) === i);
    $("new-base").innerHTML = bases.map((b) => `<option>${esc(b)}</option>`).join("");
    renderBranchList();
  } catch (err) {
    toast(`Could not read branches: ${err.message}`);
  }
}

function renderBranchList() {
  const b = nm.branches;
  if (!b) return;
  const f = $("branch-filter").value.trim().toLowerCase();
  const names = [...b.local, ...b.remote].filter((n) => n !== b.current && (!f || n.toLowerCase().includes(f)));
  $("branch-list").innerHTML = names.length
    ? names.slice(0, 40).map((n) => {
        const wt = b.worktrees[n];
        const note = wt ? "has a worktree" : b.local.includes(n) ? "local" : "origin";
        return `<li><button type="button" class="branch-opt${nm.picked === n ? " picked" : ""}" role="option" aria-selected="${nm.picked === n}" data-branch="${esc(n)}">
          <span class="dir-name">${esc(n)}</span><span class="dir-branch">${note}</span></button></li>`;
      }).join("")
    : `<li class="dir-empty">No matching branches</li>`;
}

function mode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "stay";
}

function setMode(m) {
  document.querySelector(`input[name="mode"][value="${m}"]`).checked = true;
  $("existing-body").hidden = m !== "existing";
  $("new-body").hidden = m !== "new";
  updateWhere();
}

function worktreePath(repo, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${repo.replace(/\/$/, "")}-worktrees/${slug}`;
}

function updateWhere() {
  const l = nm.listing;
  const start = $("start-btn");
  if (!l) { $("where").textContent = ""; start.disabled = true; return; }
  let text = `Starts in ${short(l.path)}`;
  let ok = true;
  if (l.git && !$("branch-step").hidden) {
    const m = mode();
    if (m === "existing") {
      ok = Boolean(nm.picked);
      text = nm.picked
        ? `Starts on ${nm.picked} in ${short(nm.branches?.worktrees[nm.picked] || worktreePath(l.path, nm.picked))}`
        : "Pick a branch";
    } else if (m === "new") {
      const name = $("new-branch").value.trim();
      ok = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) && !name.includes("..");
      text = ok ? `Creates ${name} from ${$("new-base").value} in ${short(worktreePath(l.path, name))}` : "Enter a branch name";
    } else {
      text = `Starts on ${l.branch || "the current branch"} in ${short(l.path)}`;
    }
  }
  $("where").textContent = text;
  start.disabled = !ok;
}

function openNew(machine) {
  const up = (current?.machines || []).filter((m) => m.up);
  if (!up.length) { toast("No machine is connected right now"); return; }
  const pick = up.some((m) => m.name === (machine || selected)) ? (machine || selected) : up[0].name;
  $("new-machine").innerHTML = up.map((m) => `<option${m.name === pick ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  const agents = current?.agents || [];
  const lastAgent = remembered("agent");
  const agentPick = agents.some((a) => a.name === lastAgent) ? lastAgent : current?.default_agent;
  $("new-agent").innerHTML = agents.map((a) => `<option value="${esc(a.name)}"${a.name === agentPick ? " selected" : ""}>${esc(a.label)}</option>`).join("");
  nm.machine = pick;
  nm.listing = null;
  $("branch-filter").value = "";
  $("new-branch").value = "";
  $("new-form").querySelector('input[name="resume"]').checked = false;
  $("new-dialog").showModal();
  browseTo("");
}

$("new-dialog").addEventListener("click", (e) => {
  const forget = e.target.closest("[data-forget]");
  if (forget) { forgetRecent(forget.dataset.forget); return; }
  const target = e.target.closest("[data-path]");
  if (target) { browseTo(target.dataset.path); return; }
  const opt = e.target.closest("[data-branch]");
  if (opt) {
    nm.picked = opt.dataset.branch;
    renderBranchList();
    updateWhere();
  }
});

document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => setMode(mode())));
$("branch-filter").addEventListener("input", renderBranchList);
$("new-branch").addEventListener("input", updateWhere);
$("new-base").addEventListener("change", updateWhere);

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const { act, machine, name, folder, id, agent, pid, busy } = b.dataset;
  if (act === "new") { openNew(machine); return; }
  if (act === "more") {
    if (menuButton === b) closeMenu(false);
    else { closeMenu(false); openMenu(b); }
    return;
  }
  if (act === "shell") { openShell(machine); return; }
  if (act === "clear-filters") {
    filters.q = "";
    filters.status = "all";
    $("search").value = "";
    applyFilters();
    return;
  }
  if (act === "copy-ssh") {
    closeMenu(true);
    const cmd = `ssh ${sshHosts?.[machine] || machine}`;
    toast(copyText(cmd) ? `Copied: ${cmd}` : cmd, "ok");
    return;
  }
  if (act === "remove") {
    closeMenu(true);
    if (!(await ask(`Remove ${machine} from Yardbell?`, "Its sessions keep running. Yardbell stops watching it and closes its tunnels.", { confirm: "Remove", danger: true }))) return;
    try {
      const res = await api("POST", `/machines/${encodeURIComponent(machine)}/remove`);
      if (res.ok === false) throw new Error(res.message);
      toast(`Removed ${machine}`, "ok");
      if (selected === machine) {
        selected = "";
        history.replaceState(null, "", "/");
      }
      refresh();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (act === "mesh-on") {
    b.disabled = true;
    try {
      const res = await api("POST", "/mesh/on");
      toast(res.message, "ok");
      refresh();
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
    return;
  }
  if (act === "stop" && !(await ask(`Stop ${name} on ${machine}?`, "The agent in that session closes.", { confirm: "Stop", danger: true }))) return;
  if (act === "stop-pid") {
    const warn = busy === "true" ? "It is working right now and will be interrupted. " : "";
    if (!(await ask(`Stop ${agentLabel(agent)} in ${folder} on ${machine}?`, `${warn}The agent ends and the terminal it runs in gets its prompt back. Its conversation is kept, so Resume can continue it.`, { confirm: "Stop", danger: true }))) return;
  }
  if (act === "move") {
    const warn = busy === "true" ? "It is working right now and will be interrupted. " : "";
    if (!(await ask(`Move ${folder} on ${machine} into tmux?`, `${warn}Yardbell stops ${agentLabel(agent)} and starts it again in tmux with its last conversation. The terminal it runs in now gets its prompt back.`, { confirm: "Move to tmux" }))) return;
    const tab = window.open("about:blank", "_blank");
    b.disabled = true;
    b.textContent = "Moving…";
    try {
      const res = await api("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(pid)}/move-to-tmux`);
      const url = `/term/${encodeURIComponent(machine)}/${encodeURIComponent(res.name)}`;
      if (tab) tab.location.href = url; else location.href = url;
      toast(`Moved ${folder} into tmux`, "ok");
      checkNow().catch(() => refresh());
    } catch (err) {
      if (tab) tab.close();
      toast(err.message);
      b.disabled = false;
      b.textContent = "Move to tmux";
    }
    return;
  }
  b.disabled = true;
  try {
    if (act === "stop") {
      await api("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/stop`);
      toast(`Stopped ${name}`, "ok");
    } else if (act === "stop-pid") {
      await api("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(pid)}/stop-process`);
      toast(`Stopped ${agentLabel(agent)} in ${folder}`, "ok");
    } else if (act === "host") {
      await api("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/host-terminal`);
    } else if (act === "resume") {
      await startAndOpen({ machine, folder, resume: true, agent });
    } else if (act === "forget") {
      await api("POST", `/ended/${encodeURIComponent(id)}/forget`);
    }
    checkNow().catch(() => refresh());
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$("new-btn").addEventListener("click", () => openNew());

function openNewIfClosed() {
  if (!$("new-dialog").open) openNew();
}

if (window.__TAURI__) {
  window.__TAURI__.event.listen("new-session", () => openNewIfClosed()).catch(() => {});
  document.addEventListener("keydown", (e) => {
    if (Nav.appKey(e) !== "n") return;
    e.preventDefault();
    openNewIfClosed();
  });
}

$("new-machine").addEventListener("change", (e) => {
  nm.machine = e.target.value;
  browseTo("");
});

$("new-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "start") return;
  e.preventDefault();
  const l = nm.listing;
  if (!l) return;
  const agent = $("new-agent").value;
  remember("agent", agent);
  const body = { machine: nm.machine, path: l.path, agent, resume: $("new-form").querySelector('input[name="resume"]').checked };
  if (l.git && mode() === "existing") body.branch = nm.picked;
  if (l.git && mode() === "new") Object.assign(body, { branch: $("new-branch").value.trim(), new_branch: true, base: $("new-base").value });
  $("new-dialog").close();
  try {
    await startAndOpen(body);
    checkNow().catch(() => refresh());
  } catch (err) {
    toast(err.message);
  }
});

refresh();
setInterval(refresh, 5000);
setInterval(tick, 1000);
