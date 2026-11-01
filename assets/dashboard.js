import { html, render as litRender } from "/vendor/lit-html/lit-html.js";
import { repeat } from "/vendor/lit-html/directives/repeat.js";

const $ = (id) => document.getElementById(id);
const onHost = ["localhost", "127.0.0.1"].includes(location.hostname);
const Nav = window.YardbellNav;
const Live = window.YardbellLive;
const NewSession = window.YardbellNewSession;
const Worktree = window.YardbellWorktree;
let current = null;
let lastJson = "";
let lastRender = 0;
let lastOk = 0;
let focusedId = "";
let selected = new URLSearchParams(location.search).get("machine") || "";
const filters = { q: "", status: "all" };
let sshHosts = null;

const ICONS = {
  open: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6 7.5 3 10.5M7.5 11.5H13"/></svg>`,
  external: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3H13v3.5M13 3 7.5 8.5M11 9.5V13H3V5h3.5"/></svg>`,
  chevron: html`<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>`,
  plus: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
  more: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="0.6"/><circle cx="8" cy="8" r="0.6"/><circle cx="12.5" cy="8" r="0.6"/></svg>`,
};

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

function lasted(since) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h`;
}

function renderHealthBanner(problems) {
  const banner = $("health-banner");
  const list = problems || [];
  banner.hidden = !list.length;
  if (banner.hidden) return;
  const outside = (link) => /^https?:/.test(link);
  litRender(html`<div class="banner-text">
    <strong>${list.length === 1 ? "1 thing looks stuck" : `${list.length} things look stuck`}</strong>
    <ul class="health-list">${repeat(list, (p) => p.key, (p) => html`<li>
      <a href=${p.link} target=${outside(p.link) ? "_blank" : "_self"} rel="noopener">${p.title}</a>
      <span class="health-lasted">${lasted(p.since)}</span>
      <span class="health-detail">${p.detail}</span>
    </li>`)}</ul>
  </div>
  <a class="btn" href="/settings#health">Change checks</a>`, banner);
}

function renderMeshBanner(mesh) {
  const banner = $("mesh-banner");
  banner.hidden = !mesh || mesh.on !== false;
  if (banner.hidden) return;
  const button = mesh.can_turn_on
    ? html`<button class="btn primary" type="button" data-act="mesh-on">Turn on ${mesh.label}</button>` : "";
  litRender(html`<div class="banner-text">
      <strong>${mesh.label} is off on this machine.</strong>
      <span>Other machines and your phone cannot reach Yardbell or its tunnels. ${mesh.hint || ""}</span>
    </div>${button}`, banner);
}

function memory(m) {
  const h = m.health;
  if (!m.up || !h || !h.mem_total_kb) return "";
  // RSS counts shared pages once per process, so the per-account sums can exceed what is in use.
  const usedKb = Math.min(h.mem_used_kb, h.mem_total_kb);
  const agentKb = Math.min(h.agent_kb, usedKb);
  const split = h.user_kb > 0;
  const mineKb = split ? Math.min(Math.max(h.user_kb, agentKb), usedKb) : agentKb;
  const yoursKb = mineKb - agentKb;
  const othersKb = usedKb - mineKb;
  const freeKb = Math.max(h.mem_total_kb - usedKb, 0);
  const share = (kb) => ((kb / h.mem_total_kb) * 100).toFixed(1);
  const pct = Nav.memPct(m);
  const level = pct >= 95 ? " full" : pct >= Nav.RATED ? " hot" : "";
  const parts = [["agents", "Agents", agentKb]];
  if (split) parts.push(["mine", "Your other processes", yoursKb]);
  if (!split || othersKb > 0) parts.push(["other", split ? "Other accounts" : "Other", othersKb]);
  parts.push(["free", "Free", freeKb]);
  const label = `Memory ${pct}% used of ${gb(h.mem_total_kb)} GB: ` + parts.map(([, name, kb]) => `${name.toLowerCase()} ${gb(kb)} GB`).join(", ");
  return html`<div class="mem${level}">
    <div class="mem-head"><span>Memory <span class="mem-pct">${pct}% used</span> of ${gb(h.mem_total_kb)} GB</span></div>
    <div class="mem-bar" role="img" aria-label=${label}>
      <span class="mem-agents" style="width:${share(agentKb)}%"></span>
      ${split ? html`<span class="mem-mine" style="width:${share(yoursKb)}%"></span>` : ""}
      <span class="mem-other" style="width:${share(othersKb)}%"></span>
    </div>
    <div class="mem-legend">
      ${parts.map(([key, name, kb]) => html`<span><i class="key ${key}"></i>${name} ${gb(kb)} GB</span>`)}
    </div>
    ${accounts(m)}${limit(m)}
  </div>`;
}

// Only on a machine shared with other people: on your own machine the legend already says it all.
function accounts(m) {
  const list = m.accounts || [];
  if (!list.some((a) => !a.you)) return "";
  return html`<div class="mem-accounts">
    ${list.slice(0, 6).map((a) => html`<span class=${a.you ? "you" : ""} title=${a.containers_kb ? `${gb(a.containers_kb)} GB of it in containers` : ""}>${a.name}${a.you ? " (you)" : ""} <b>${gb(a.kb)} GB</b></span>`)}
  </div>`;
}

function limit(m) {
  const h = m.health;
  const pct = Nav.limitPct(m);
  if (pct === null) return "";
  const level = pct >= 95 ? " full" : pct >= Nav.RATED ? " hot" : "";
  return html`<div class="mem-limit${level}">Your account's limit: <b>${gb(h.limit_used_kb)} of ${gb(h.limit_kb)} GB</b>, ${pct}%</div>`;
}

function disk(m) {
  const h = m.health;
  if (!m.up || !h || !h.disk_total_kb) return "";
  const pct = Math.round((h.disk_used_kb / h.disk_total_kb) * 100);
  const freeKb = Math.max(h.disk_total_kb - h.disk_used_kb, 0);
  const level = pct >= 95 ? " full" : pct >= Nav.RATED ? " hot" : "";
  const label = `Disk ${pct}% used of ${gb(h.disk_total_kb)} GB, ${gb(freeKb)} GB free`;
  return html`<div class="mem disk${level}">
    <div class="mem-head"><span>Disk <span class="mem-pct">${pct}% used</span> of ${gb(h.disk_total_kb)} GB</span><span>${gb(freeKb)} GB free</span></div>
    <div class="mem-bar" role="img" aria-label=${label}>
      <span class="mem-other" style="width:${Math.min(pct, 100)}%"></span>
    </div>
  </div>`;
}

function statusBadge(s) {
  if (s.stale) return html`<span class="badge">Last known</span>`;
  if (s.activity === "blocked") return html`<span class="badge blocked" title="Waiting for your answer or approval">Needs you</span>`;
  return s.activity === "active"
    ? html`<span class="badge busy">Working</span>`
    : html`<span class="badge">Idle</span>`;
}

function ports(s) {
  if (!s.ports.length) return "";
  return html`<ul class="port-list">${s.ports.map((p) => {
    const name = html`<span class="svc">${p.service}</span><span class="num">:${p.local ?? p.remote}</span>`;
    const state = html`<span class="dot ${tone(p.status)}" title=${p.status}></span>`;
    const body = p.url
      ? html`<a href=${p.url} target="_blank" rel="noopener" title="${p.status}, remote port ${p.remote}">${state}${name}${ICONS.external}</a>`
      : html`<span>${state}${name}</span>`;
    return html`<li>${body}<span class="port-status ${tone(p.status)}">${p.status}</span></li>`;
  })}</ul>`;
}

function termUrl(s) {
  return `/term/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}`;
}

function actions(s) {
  if (!s.attachable || s.stale) return "";
  const host = onHost && current.host_terminal !== "none"
    ? html`<button class="btn" type="button" data-act="host" data-machine=${s.machine} data-name=${s.tmux}>Terminal app</button>` : "";
  return html`<div class="row-actions">
    <a class="btn" href=${termUrl(s)} target="_blank" rel="noopener">${ICONS.open}Open</a>${host}
    <button class="btn quiet" type="button" data-act="insights" data-machine=${s.machine} data-name=${s.tmux} title="When it worked, waited and idled, and the tools and tests it ran">Insights</button>
    <button class="btn quiet" type="button" data-act="move-machine" data-id=${s.id} title="Move this session's branch, changes and task to another machine">Move</button>
    <button class="btn quiet danger stop" type="button" data-act="stop" data-machine=${s.machine} data-name=${s.tmux}>Stop</button>
  </div>`;
}

function filtering() {
  return Boolean(filters.q) || filters.status !== "all";
}

function matchesText(fields) {
  return !filters.q || fields.join(" ").toLowerCase().includes(filters.q);
}

function shownAs(s) {
  return s.activity === "blocked" ? "idle" : s.activity;
}

function matches(s) {
  if (filters.status !== "all" && (s.stale || shownAs(s) !== filters.status)) return false;
  return matchesText([s.folder, s.branch, s.ticket === "-" ? "" : s.ticket, agentLabel(s.agent), s.machine]);
}

function matchesEnded(e) {
  return filters.status === "all" && matchesText([e.folder, e.ticket === "-" ? "" : e.ticket, agentLabel(e.agent), e.machine]);
}

function agentLabel(name) {
  return (current?.agents || []).find((a) => a.name === name)?.label || name;
}

function pullBadge(p) {
  if (!p) return "";
  const { word, tone } = window.YardbellPull.status(p);
  return html`<a class="pr-badge ${tone}" href=${p.url} target="_blank" rel="noopener" title=${window.YardbellPull.describe(p)}><span class="pr-num">${window.YardbellPull.ref(p)}</span>${word}</a>`;
}

function pullWhy(s) {
  if (s.pull || !s.pull_why) return "";
  return html`<a class="pr-why" href="/settings#pull-requests" title=${s.pull_why}>No PR info</a>`;
}

function setupFlag(s) {
  if (!s.setup) return "";
  const word = s.setup.ok ? "Setup ran" : s.setup.timed_out ? "Setup timed out" : "Setup failed";
  return html`<button type="button" class="setup-flag${s.setup.ok ? "" : " failed"}" data-act="setup" data-id=${s.id} title=${Worktree.setupNote(s.setup)}>${word}</button>`;
}

function identity(s, extra = "") {
  const ticket = s.ticket !== "-" ? html`<span class="ticket">${s.ticket}</span>` : "";
  const branch = s.branch ? html`<span class="branch">${s.branch}</span>` : "";
  const agent = s.agent ? html`<span class="agent">${agentLabel(s.agent)}</span>` : "";
  return html`<div class="s-line"><span class="folder">${short(s.folder)}</span>${ticket}${extra}</div>
    <div class="s-sub">${branch}${pullBadge(s.pull)}${pullWhy(s)}${setupFlag(s)}${agent}</div>`;
}

function sessionRow(s) {
  const cells = html`<div class="s-main">${identity(s)}</div>
    <div class="s-status">${statusBadge(s)}</div>
    <div class="s-ports">${ports(s)}</div>
    <div class="s-actions">${actions(s)}</div>`;
  if (!s.attachable || s.stale) return html`<li class="s-row${s.stale ? " stale" : ""}">${cells}</li>`;
  return html`<li class="s-row openable${focusedId === s.id ? " kb" : ""}" data-id=${s.id} data-href=${termUrl(s)} tabindex="0" aria-label="Open ${short(s.folder)} on ${s.machine}">${cells}</li>`;
}

function looseRow(s) {
  const busy = s.activity === "active" ? html`<span class="badge busy" title="Estimated from CPU use">Working</span>` : "";
  return html`<li class="sub-row">
    <div class="s-main">${identity(s, busy)}</div>
    <div class="row-actions">
      <button class="btn" type="button" data-act="move" data-machine=${s.machine} data-pid=${s.pid} data-folder=${short(s.folder)} data-agent=${s.agent} data-busy=${s.activity === "active"}>Move to tmux</button>
      <button class="btn quiet danger" type="button" data-act="stop-pid" data-machine=${s.machine} data-pid=${s.pid} data-folder=${short(s.folder)} data-agent=${s.agent} data-busy=${s.activity === "active"}>Stop</button>
    </div>
  </li>`;
}

function endedRow(e) {
  const remove = e.worktree && e.path
    ? html`<button class="btn quiet danger" type="button" data-act="remove-worktree" data-machine=${e.machine} data-path=${e.path}>Remove worktree</button>` : "";
  return html`<li class="sub-row">
    <div class="s-main">${identity({ ...e, branch: e.worktree ? e.branch : "" })}</div>
    <div class="row-actions">
      <button class="btn" type="button" data-act="resume" data-machine=${e.machine} data-folder=${e.folder} data-path=${e.path || ""} data-agent=${e.agent}>Resume</button>
      ${remove}
      <button class="btn quiet" type="button" data-act="insights" data-machine=${e.machine} data-name=${e.id.slice(e.machine.length + 1)} title="When it worked, waited and idled, and the tools and tests it ran">Insights</button>
      <button class="btn quiet" type="button" data-act="forget" data-id=${e.id}>Forget</button>
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
    toggle: html`<button type="button" class="mg-toggle" data-toggle=${kind} data-machine=${m.name} aria-expanded=${open} aria-controls=${id}>${ICONS.chevron}<span class="mg-toggle-count">${count}</span>${label}</button>`,
    panel: html`<div class="mg-panel" id=${id} ?hidden=${!open}>${body}</div>`,
  };
}

function machineActions(m) {
  const name = m.name;
  const work = m.up
    ? html`<button class="btn icon-btn quiet" type="button" data-act="new" data-machine=${name} aria-label="New session on ${name}" title="New session on ${name}">${ICONS.plus}</button>
       <button class="btn icon-btn quiet" type="button" data-act="shell" data-machine=${name} aria-label="Open a shell on ${name}" title="Open a shell on ${name}">${ICONS.open}</button>`
    : "";
  return html`<div class="mg-actions">${work}<button class="btn icon-btn quiet" type="button" data-act="more" data-machine=${name} data-local=${m.local} aria-label="More for ${name}" title="More" aria-haspopup="menu" aria-expanded="false">${ICONS.more}</button></div>`;
}

function group(state, m) {
  const mine = state.sessions.filter((s) => s.machine === m.name);
  const rows = mine.filter((s) => (s.attachable || s.stale) && matches(s));
  const loose = mine.filter((s) => !s.attachable && !s.stale && matches(s));
  const ended = state.ended.filter((e) => e.machine === m.name && matchesEnded(e));
  if (filtering() && !rows.length && !loose.length && !ended.length) return "";
  const live = mine.filter((s) => !s.stale).length;
  const collapsed = !filtering() && remembered(`collapsed:${m.name}`) === "1";
  const looseHelp = html`<p class="loose-help">Yardbell can only open sessions that run in tmux. Move one to stop its agent and start it again in tmux with the same conversation, or <a href="https://github.com/hbasheer/yardbell#making-every-session-openable" target="_blank" rel="noopener">start agents inside tmux</a> from now on.</p>`;
  const outside = disclosure("loose", m, loose.length, "outside tmux", html`${looseHelp}<ul class="sub-list">${repeat(loose, (s) => s.id, looseRow)}</ul>`);
  const gone = disclosure("ended", m, ended.length, "ended", html`<ul class="sub-list">${repeat(ended, (e) => e.id, endedRow)}</ul>`);
  const empty = filtering()
    ? html`<li class="s-empty"><span>No matching open sessions</span></li>`
    : m.up
    ? html`<li class="s-empty"><span>No open sessions</span><button class="btn quiet" type="button" data-act="new" data-machine=${m.name}>Start one</button></li>`
    : html`<li class="s-empty"><span>Unreachable. Its sessions reappear when it reconnects.</span></li>`;
  const foot = outside.toggle || gone.toggle
    ? html`<div class="mg-foot">${outside.toggle}${gone.toggle}</div>${outside.panel}${gone.panel}` : "";
  const bodyId = `mg-body-${m.name.replace(/[^a-z0-9-]/gi, "-")}`;
  const body = collapsed ? "" : html`<div id=${bodyId}><ul class="s-list">${rows.length ? repeat(rows, (s) => s.id, sessionRow) : empty}</ul>${foot}</div>`;
  const state_ = m.up ? (Nav.memPct(m) >= Nav.RATED ? " hot" : "") : " down";
  const dot = m.up ? (state_ === " hot" ? "warn" : "ok") : "bad";
  const fold = filtering()
    ? html`<span class="mg-fold" aria-hidden="true"></span>`
    : html`<button type="button" class="mg-fold" data-collapse=${m.name} aria-expanded=${!collapsed} aria-controls=${bodyId} aria-label="${collapsed ? "Show" : "Hide"} sessions on ${m.name}">${ICONS.chevron}</button>`;
  return html`<section class="mgroup${state_}${collapsed ? " collapsed" : ""}" aria-labelledby="mg-${m.name}">
    <header class="mg-head">
      <div class="mg-id">
        <div class="mg-title">${fold}<span class="dot ${dot}"></span><h2 id="mg-${m.name}">${m.name}</h2>${m.up ? html`<span class="mg-count">${plural(live, "session")}</span>` : ""}</div>
        <p class="mg-conn">${connection(m)}</p>
      </div>
      <div class="health">${memory(m)}${disk(m)}</div>
      ${machineActions(m)}
    </header>
    ${body}
  </section>`;
}

function renderCounts(state) {
  const live = state.sessions.filter((s) => !s.stale && (!selected || s.machine === selected));
  $("count-all").textContent = live.length;
  $("count-active").textContent = live.filter((s) => s.activity === "active").length;
  $("count-idle").textContent = live.filter((s) => shownAs(s) === "idle").length;
  document.querySelectorAll(".segmented [data-status]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.status === filters.status)));
}

function renderGroups(state) {
  const machine = state.machines.find((m) => m.name === selected);
  const machines = Nav.order(state.machines).filter((m) => !selected || m.name === selected);
  $("title").textContent = machine ? machine.name : "Sessions";
  renderCounts(state);
  const visible = state.sessions.filter((s) => (!selected || s.machine === selected) && (s.attachable || s.stale) && matches(s));
  if (focusedId && !visible.some((s) => s.id === focusedId)) focusedId = "";
  const groups = $("groups");
  groups.classList.toggle("no-ports", !visible.some((s) => s.ports.length));
  // lit renders after whatever the container already holds, so the page's static placeholder has to go.
  groups.querySelector(":scope > .checking")?.remove();
  const shown = machines.map((m) => group(state, m));
  let view;
  if (!machines.length) {
    view = html`<div class="empty"><p>No machines yet. Add one to see its agent sessions here.</p><a class="btn primary" href="/add">Add machine</a></div>`;
  } else if (shown.every((g) => g === "")) {
    view = html`<div class="empty"><p>No sessions match${filters.q ? ` "${filters.q}"` : ""}.</p><button class="btn" type="button" data-act="clear-filters">Clear filters</button></div>`;
  } else {
    view = repeat(machines, (m) => m.name, (m, i) => shown[i]);
  }
  litRender(view, groups);
  followMenuTrigger();
}

function render(state) {
  if (selected && !state.machines.some((m) => m.name === selected)) selected = "";
  Nav.render(state, selected);
  renderMeshBanner(state.mesh);
  renderHealthBanner(state.problems);
  renderGroups(state);
}

// A stopped session leaves the list as soon as the stop succeeds. A state fetched before the
// server checked its machine again still lists it, so it stays out until a state without it.
const LEAVING_FOR = 15000;
const leaving = new Map();
let fetched = null;

function withoutLeaving(state) {
  const now = Date.now();
  const listed = new Set(state.sessions.map((s) => s.id));
  for (const [id, at] of leaving) if (now - at > LEAVING_FOR || !listed.has(id)) leaving.delete(id);
  if (!leaving.size) return state;
  return { ...state, sessions: state.sessions.filter((s) => !leaving.has(s.id)) };
}

function leave(id) {
  leaving.set(id, Date.now());
  if (fetched) render((current = withoutLeaving(fetched)));
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
      fetched = JSON.parse(text);
      current = withoutLeaving(fetched);
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

const touch = matchMedia("(pointer: coarse)");

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
  // On a touch screen the whole card as one target swallowed taps meant for Stop and the other
  // buttons beside Open, so there only Open opens it.
  if (touch.matches) return;
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

$("refresh-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.classList.add("spinning");
  try {
    await api("POST", "/refresh");
    await refresh();
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
  litRender(html`<a role="menuitem" href="/settings#machine-${name}">Machine settings</a>${local ? "" : html`
    <button type="button" role="menuitem" data-act="copy-ssh" data-machine=${name}>Copy ssh command</button>
    <button type="button" role="menuitem" class="danger" data-act="remove" data-machine=${name}>Remove machine…</button>`}`, menu);
  menu.hidden = false;
  placeMenu(button);
  button.setAttribute("aria-expanded", "true");
  menuButton = button;
  menu.querySelector("[role=menuitem]").focus();
  if (!local) loadSshHosts();
}

function followMenuTrigger() {
  if (!menuButton) return;
  if (menuButton.isConnected) placeMenu(menuButton);
  else closeMenu(false);
}

async function ask(title, body, options) {
  const back = document.activeElement;
  const visible = back?.matches(":focus-visible");
  const yes = await Nav.confirm(title, body, options);
  const lost = !document.activeElement || document.activeElement === document.body;
  if (lost && back?.isConnected) back.focus({ preventScroll: true, focusVisible: visible });
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
    if (res.setup && !res.setup.ok) toast(`${Worktree.setupNote(res.setup)}. The agent started anyway; its row shows the output.`, "warn");
  } catch (err) {
    if (tab) tab.close();
    throw err;
  }
}

function openNew(machine) {
  const up = (current?.machines || []).filter((m) => m.up);
  if (!up.length) { toast("No machine is connected right now"); return; }
  NewSession.open({
    machines: up.map((m) => m.name),
    machine: machine || selected,
    agents: current?.agents || [],
    defaultAgent: current?.default_agent,
    onError: toast,
    onStart: (body) => startAndOpen(body)
      .then(() => Live.soon())
      .catch((err) => toast(err.message)),
  });
}

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
  if (act === "setup") {
    const s = current?.sessions.find((x) => x.id === id);
    if (s?.setup) Worktree.showSetup(s.setup);
    return;
  }
  if (act === "remove-worktree") {
    Worktree.remove({ machine, path: b.dataset.path, toast, done: () => Live.soon() });
    return;
  }
  if (act === "insights") {
    window.YardbellInsights.open({ machine, name, onSuggest: window.YardbellInsights.handOver });
    return;
  }
  if (act === "move-machine") {
    const s = current?.sessions.find((x) => x.id === id);
    if (!s) return;
    Worktree.move({
      session: s,
      state: current,
      toast,
      done: (moved) => { leave(s.id); Live.soon(); return moved; },
      openTerm: (m, n) => window.open(`/term/${encodeURIComponent(m)}/${encodeURIComponent(n)}`, "_blank", "noopener"),
    });
    return;
  }
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
      Live.soon();
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
      leave(`${machine}:${name}`);
      toast(`Stopped ${name}`, "ok");
    } else if (act === "stop-pid") {
      await api("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(pid)}/stop-process`);
      leave(`${machine}:${pid}`);
      toast(`Stopped ${agentLabel(agent)} in ${folder}`, "ok");
    } else if (act === "host") {
      await api("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/host-terminal`);
    } else if (act === "resume") {
      const where = b.dataset.path ? { path: b.dataset.path } : { folder };
      await startAndOpen({ machine, ...where, resume: true, agent });
    } else if (act === "forget") {
      await api("POST", `/ended/${encodeURIComponent(id)}/forget`);
    }
    Live.soon();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$("new-btn").addEventListener("click", () => openNew());

function openNewIfClosed() {
  if (!NewSession.isOpen()) openNew();
}

if (window.__TAURI__) {
  window.__TAURI__.event.listen("new-session", () => openNewIfClosed()).catch(() => {});
  document.addEventListener("keydown", (e) => {
    if (Nav.appKey(e) !== "n") return;
    e.preventDefault();
    openNewIfClosed();
  });
}

refresh();
Live.follow(refresh, 5000);
setInterval(tick, 1000);
