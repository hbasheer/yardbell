(function () {
  const shell = document.getElementById("shell");
  if (!shell) return;
  const foot = shell.querySelector("#col .col-foot");
  const rail = shell.querySelector("#rail");
  const BANNER_AFTER = 3000;
  let machines = [];
  let sessions = [];
  let awake = null;
  let anchor = null;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const svg = (cls, body) => `<svg class="strip-icon${cls ? ` ${cls}` : ""}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    machine: svg("", '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/>'),
    plug: svg("", '<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/>'),
    cup: svg("", '<path d="M3 6.5h8v3.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM11 7.5h1a1.5 1.5 0 0 1 0 3h-1.2M5.5 2.5v1.8M8.5 2.5v1.8"/>'),
    open: svg("", '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
  };

  // Keep computer awake, live ports and the connection sit at the right of the sidebar's foot, or
  // at the bottom of the rail when the sidebar is folded or the page has none.
  const group = document.createElement("div");
  group.className = "status-group";
  group.id = "status-group";
  group.innerHTML = '<span class="status-slot status-awake"></span><span class="status-slot status-ports"></span><span class="status-live" id="status-live" role="img"></span>';
  const awakeEl = group.querySelector(".status-awake");
  const portsEl = group.querySelector(".status-ports");
  const liveEl = group.querySelector("#status-live");

  function place() {
    const inRail = !foot || document.documentElement.classList.contains("side-rail");
    if (inRail && rail) rail.querySelector("[data-theme-toggle]")?.before(group);
    else foot?.append(group);
    group.classList.toggle("in-rail", inRail);
  }

  const banner = document.createElement("div");
  banner.className = "conn-banner";
  banner.id = "conn-banner";
  banner.setAttribute("role", "status");
  banner.hidden = true;
  banner.textContent = "Reconnecting to Yardbell…";
  let bannerTimer = 0;

  function showBanner(on) {
    clearTimeout(bannerTimer);
    if (!on) { banner.hidden = true; return; }
    if (!banner.hidden) return;
    bannerTimer = setTimeout(() => {
      banner.hidden = false;
      placeBanner();
    }, BANNER_AFTER);
  }

  function placeBanner() {
    if (banner.hidden) return;
    const main = document.getElementById("main");
    const box = main && main.offsetWidth ? main.getBoundingClientRect() : { left: 0, width: innerWidth, top: 0 };
    banner.style.left = `${Math.round(box.left + box.width / 2)}px`;
    banner.style.top = `${Math.round(Math.max(0, box.top) + 10)}px`;
  }

  function renderLive(e) {
    const up = e?.detail && "open" in e.detail ? e.detail.open : (window.YardbellLive?.connected() ?? false);
    const word = up ? "Live" : "Reconnecting";
    liveEl.className = `status-live ${up ? "up" : "down"}`;
    liveEl.title = word;
    liveEl.setAttribute("aria-label", `Connection: ${word}`);
    if (e) showBanner(!up);
  }

  function livePorts() {
    const seen = new Map();
    for (const s of sessions) {
      for (const p of s.ports || []) {
        const key = `${s.machine}:${p.remote}`;
        if (!seen.has(key)) seen.set(key, { ...p, machine: s.machine });
      }
    }
    return [...seen.values()];
  }

  function renderPorts() {
    const n = livePorts().length;
    portsEl.innerHTML = n
      ? `<button class="status-btn" type="button" id="status-ports" aria-haspopup="dialog" aria-expanded="${portsPop.hidden ? "false" : "true"}" title="${n} live port${n === 1 ? "" : "s"}">${ICONS.plug}<span class="visually-hidden">Live ports </span><span class="status-count">${n}</span></button>`
      : "";
    document.querySelectorAll("[data-status-count=ports]").forEach((el) => { el.textContent = String(n); });
    if (!portsPop.hidden) renderPortsPop();
  }

  function portRow(p) {
    const where = p.local ? `localhost:${p.local}` : `remote ${p.remote}`;
    const inner = `<b class="ports-num">${esc(p.local ?? p.remote)}</b><span class="ports-text"><span class="ports-svc">${esc(p.service)}</span><span class="ports-where">${esc(where)} · ${esc(p.status)}</span></span>`;
    return p.url
      ? `<a class="ports-row" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open ${esc(p.service)} on ${esc(where)}">${inner}${ICONS.open}</a>`
      : `<div class="ports-row" title="${esc(p.status)}">${inner}</div>`;
  }

  function renderPortsPop() {
    const list = livePorts();
    const groups = new Map();
    for (const p of list) {
      if (!groups.has(p.machine)) groups.set(p.machine, []);
      groups.get(p.machine).push(p);
    }
    const body = list.length
      ? [...groups].map(([machine, ports]) => `<div class="ports-group"><div class="ports-machine">${ICONS.machine}<span>${esc(machine)}</span><span class="ports-n">${ports.length}</span></div>${ports.sort((a, b) => a.remote - b.remote).map(portRow).join("")}</div>`).join("")
      : '<p class="strip-pop-empty">No ports are forwarded right now.</p>';
    portsPop.innerHTML = `<div class="strip-pop-head">${ICONS.plug}<span class="strip-pop-title">Live ports <span class="strip-pop-n">(${list.length})</span></span><span class="strip-pop-note">${groups.size} machine${groups.size === 1 ? "" : "s"}</span></div><div class="ports-list">${body}</div>`;
  }

  const AWAKE = [
    { mode: "on", word: "On", label: "On", desc: "Keep this computer awake continuously" },
    { mode: "agent", word: "Agent", label: "While agents work", desc: "Stay awake while an agent is working on this computer" },
    { mode: "off", word: "Off", label: "Off", desc: "Let the computer sleep as usual" },
  ];

  function awakeSummary() {
    if (!awake) return "";
    const word = AWAKE.find((a) => a.mode === awake.mode)?.word || "Off";
    if (awake.error) return `${word} · Unavailable`;
    return `${word} · ${awake.holding ? "Active" : "Inactive"}`;
  }

  function renderAwake() {
    document.querySelectorAll("[data-status-count=awake]").forEach((el) => { el.textContent = awake ? awakeSummary() : ""; });
    if (!awake) { awakeEl.innerHTML = ""; return; }
    const state = awake.error ? "missing" : awake.holding ? "holding" : "idle";
    awakeEl.innerHTML = `<button class="status-btn status-cup ${state}" type="button" id="status-awake" data-mode="${esc(awake.mode)}" aria-haspopup="dialog" aria-expanded="${awakePop.hidden ? "false" : "true"}" title="Keep computer awake: ${esc(awakeSummary())}">${ICONS.cup}<span class="visually-hidden">Keep computer awake: ${esc(awakeSummary())}</span></button>`;
    if (!awakePop.hidden) renderAwakePop();
  }

  function renderAwakePop() {
    const options = AWAKE.map((a) => `<button class="awake-opt" type="button" role="menuitemradio" data-awake="${a.mode}" aria-checked="${awake?.mode === a.mode}"><span class="awake-bullet" aria-hidden="true"></span><span class="awake-text"><span class="awake-label">${a.label}</span><span class="awake-desc">${a.desc}</span></span></button>`).join("");
    const why = awake?.error ? `<p class="awake-error" role="status">${esc(awake.error.charAt(0).toUpperCase() + awake.error.slice(1))}</p>` : "";
    awakePop.innerHTML = `<div class="strip-pop-head"><span class="strip-pop-title">Keep computer awake</span><span class="strip-pop-note">${esc(awakeSummary())}</span></div><div class="awake-list" role="menu" aria-label="Keep computer awake">${options}</div>${why}`;
  }

  async function setAwake(mode, button) {
    button.disabled = true;
    try {
      const res = await fetch("/api/settings/keep-awake", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ mode }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Yardbell answered ${res.status}`);
      awake = body;
    } catch (e) {
      awake = { ...(awake || {}), error: `Couldn't save: ${e.message}` };
    }
    renderAwake();
  }

  function popover(id, label) {
    const el = document.createElement("div");
    el.className = "strip-pop";
    el.id = id;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", label);
    el.hidden = true;
    document.body.append(el);
    return el;
  }
  const portsPop = popover("ports-pop", "Live ports");
  const awakePop = popover("awake-pop", "Keep computer awake");

  // Above the button that opened it, kept inside the window; from the rail it opens beside it.
  function placeAt(el, from) {
    const r = from.getBoundingClientRect();
    const beside = from.closest(".in-rail");
    const left = beside ? r.right + 8 : r.left + r.width / 2 - el.offsetWidth / 2;
    el.style.left = `${Math.round(Math.max(8, Math.min(left, innerWidth - el.offsetWidth - 8)))}px`;
    el.style.bottom = `${Math.round(Math.max(8, beside ? innerHeight - r.bottom : innerHeight - r.top + 6))}px`;
  }

  function closeAll(refocus) {
    let was = null;
    for (const el of [portsPop, awakePop]) {
      if (el.hidden) continue;
      el.hidden = true;
      was = anchor;
    }
    anchor = null;
    renderPorts();
    renderAwake();
    if (refocus && was) (was.isConnected ? was : document.getElementById(was.id))?.focus();
  }

  function toggle(which, from) {
    const el = which === "ports" ? portsPop : awakePop;
    const opening = el.hidden;
    closeAll(false);
    if (!opening) return;
    el.hidden = false;
    anchor = from;
    (which === "ports" ? renderPortsPop : renderAwakePop)();
    renderPorts();
    renderAwake();
    placeAt(el, from.isConnected ? from : document.getElementById(from.id) || from);
    el.querySelector("a, button")?.focus();
  }

  document.addEventListener("click", (e) => {
    const ports = e.target.closest("#status-ports");
    if (ports) { toggle("ports", ports); return; }
    const cup = e.target.closest("#status-awake");
    if (cup) { toggle("awake", cup); return; }
    const pick = e.target.closest("#awake-pop [data-awake]");
    if (pick) { setAwake(pick.dataset.awake, pick); return; }
    if ([portsPop, awakePop].some((el) => !el.hidden && !e.composedPath().includes(el)) && !e.target.closest("[data-status-open]")) closeAll(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (!portsPop.hidden || !awakePop.hidden)) closeAll(true);
  });
  window.addEventListener("yardbell-live", renderLive);
  window.addEventListener("yardbell-shell", place);
  window.addEventListener("resize", () => {
    placeBanner();
    if (!portsPop.hidden || !awakePop.hidden) closeAll(false);
  });

  place();
  document.body.append(banner);
  renderLive();

  window.YardbellStrip = {
    update(state) {
      machines = state.machines || [];
      sessions = state.sessions || [];
      if (state.keep_awake) awake = state.keep_awake;
      renderLive();
      renderPorts();
      renderAwake();
      window.YardbellUsage?.machines(machines);
    },
    // The phone's More menu has no foot to anchor to, so it opens these from its own button.
    open(which, from) {
      toggle(which, from);
    },
    machines: () => machines,
  };
})();
