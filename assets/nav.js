(function () {
  const RATED = 85;
  const page = document.body.dataset.page || "";
  const app = window.__TAURI__;
  const mac = /Mac/.test(navigator.platform);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function memPct(m) {
    const h = m.health;
    return m.up && h && h.mem_total_kb ? Math.round((h.mem_used_kb / h.mem_total_kb) * 100) : null;
  }

  function tone(m) {
    if (!m.up) return "bad";
    const pct = memPct(m);
    return pct !== null && pct >= RATED ? "warn" : "ok";
  }

  function word(m) {
    const t = tone(m);
    return t === "bad" ? "down" : t === "warn" ? `memory at ${memPct(m)}%` : "connected";
  }

  function order(machines) {
    const rank = (m) => (m.up ? (tone(m) === "warn" ? 1 : 2) : 0);
    return [...machines].sort((a, b) => rank(a) - rank(b));
  }

  function running(state, name) {
    return state.sessions.filter((s) => !s.stale && (!name || s.machine === name)).length;
  }

  const ALL_ICON = '<svg class="icon nav-all" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>';

  function item(href, machine, label, count, selected, dot) {
    const current = selected ? ' aria-current="true"' : "";
    return `<li><a class="nav-item${selected ? " selected" : ""}" href="${href}" data-machine="${esc(machine)}" title="${esc(label)}, ${count} running"${current}>
      ${dot}${machine ? `<span class="rail-initial" aria-hidden="true">${esc(window.YardbellSide.initials(label))}</span>` : ""}<span class="nav-name">${esc(label)}</span><span class="nav-count" title="${count} running ${count === 1 ? "session" : "sessions"}">${count}</span>
    </a></li>`;
  }

  function render(state, selected) {
    const up = state.machines.filter((m) => m.up).length;
    document.getElementById("nav-summary").textContent = `${up} of ${state.machines.length} connected`;
    const onDashboard = page === "dashboard";
    const all = item("/", "", "All machines", running(state), onDashboard && !selected, ALL_ICON);
    const machines = order(state.machines).map((m) => item(
      `/?machine=${encodeURIComponent(m.name)}`,
      m.name,
      m.name,
      running(state, m.name),
      onDashboard && selected === m.name,
      `<span class="dot ${tone(m)}" title="${esc(word(m))}"></span><span class="sr">${esc(word(m))}</span>`,
    ));
    document.getElementById("nav-machines").innerHTML = all + machines.join("");
    renderServer(state.server);
    const vpn = document.getElementById("nav-vpn");
    const mesh = state.mesh;
    if (!mesh) {
      vpn.textContent = "";
      return;
    }
    const on = mesh.on === true ? "on" : mesh.on === false ? "off" : "status unknown";
    vpn.title = `${mesh.label} ${on}`;
    vpn.innerHTML = `<span class="dot ${mesh.on === true ? "ok" : mesh.on === false ? "bad" : ""}"></span>${esc(mesh.label)} ${on}`;
  }

  function renderServer(server) {
    const nav = document.querySelector(".machine-nav");
    if (!nav || !server) return;
    let line = document.getElementById("nav-server");
    if (!line) {
      line = document.createElement("p");
      line.id = "nav-server";
      line.className = "server-line";
      nav.after(line);
    }
    line.title = `Yardbell runs on ${server.machine}. Phones and other machines reach it at ${server.address}.`;
    line.innerHTML = `<span>Running on</span> <b>${esc(server.machine)}</b> <code>${esc(server.address)}</code>`;
  }

  function resetsIn(epoch) {
    if (!epoch) return "";
    const mins = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
    if (mins < 60) return `resets in ${mins} min`;
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)} h ${mins % 60} min`;
    return `resets ${new Date(epoch * 1000).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  }

  // Claude Code reports its limits with every Dispatch reply, so these are as fresh as the last one.
  async function loadUsage() {
    const foot = document.querySelector(".side .side-foot");
    if (!foot) return;
    let usage = null;
    try {
      const res = await fetch("/dispatch/usage", { headers: { Accept: "application/json" } });
      if (res.ok) usage = await res.json();
    } catch {}
    let card = document.getElementById("nav-usage");
    if (!usage?.windows?.length) {
      card?.remove();
      return;
    }
    if (!card) {
      card = document.createElement("section");
      card.id = "nav-usage";
      card.className = "usage-card";
      card.setAttribute("aria-label", "Claude usage");
      foot.before(card);
    }
    card.title = "Claude Code reports this each time Dispatch replies";
    card.innerHTML = `<div class="usage-head"><span>Claude usage</span></div>` + usage.windows.map((w) => {
      const pct = Math.round(w.used * 100);
      const tone = w.status !== "allowed" || pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok";
      return `<div class="usage-row">
        <div class="usage-line"><span>${esc(w.label)}</span><span class="usage-pct">${pct}%</span></div>
        <div class="usage-track" role="progressbar" aria-label="${esc(w.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="usage-fill ${tone}" style="width: ${Math.max(pct, 1)}%"></span></div>
        <div class="usage-reset">${esc(resetsIn(w.resets_at))}</div>
      </div>`;
    }).join("");
  }

  let build = "";

  function checkBuild(res) {
    const next = res.headers.get("x-yardbell-build");
    if (!next) return;
    if (!build) build = next;
    else if (next !== build && !document.querySelector("dialog[open]")) location.reload();
  }

  async function load() {
    try {
      const res = await fetch("/state", { headers: { Accept: "application/json" } });
      if (res.status === 401) { location.href = "/login"; return; }
      if (!res.ok) return;
      checkBuild(res);
      render(await res.json(), "");
    } catch {}
  }

  document.getElementById("logout").hidden = Boolean(app);
  document.getElementById("logout").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    location.href = "/login";
  });

  let asked = 0;

  function ask(title, body, { confirm = "OK", danger = false } = {}) {
    const back = document.activeElement;
    const id = `confirm-${++asked}`;
    const dialog = document.createElement("dialog");
    dialog.className = "confirm";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    dialog.setAttribute("aria-describedby", `${id}-body`);
    dialog.innerHTML = `<h2 id="${id}-title">${esc(title)}</h2>
      <p id="${id}-body">${esc(body)}</p>
      <div class="dialog-actions">
        <button class="btn quiet" type="button" data-answer="no">Cancel</button>
        <button class="btn ${danger ? "danger-solid" : "primary"}" type="button" data-answer="yes">${esc(confirm)}</button>
      </div>`;
    document.body.append(dialog);
    return new Promise((resolve) => {
      const finish = (yes) => {
        if (!dialog.isConnected) return;
        dialog.close();
        dialog.remove();
        if (back instanceof HTMLElement && back.isConnected) back.focus();
        resolve(yes);
      };
      dialog.addEventListener("click", (e) => {
        const answer = e.target.closest("[data-answer]");
        if (answer) finish(answer.dataset.answer === "yes");
      });
      dialog.addEventListener("close", () => finish(false));
      dialog.showModal();
      dialog.querySelector('[data-answer="no"]').focus();
    });
  }

  function appKey(e) {
    if (!app || e.altKey) return "";
    const held = mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && !e.metaKey;
    return held ? e.key.toLowerCase() : "";
  }

  function tabKey(e) {
    if (!app || e.altKey) return "";
    if (e.key === "Tab") return e.ctrlKey && !e.metaKey ? (e.shiftKey ? "tab-prev" : "tab-next") : "";
    const key = appKey(e);
    return /^[1-9]$/.test(key) ? `tab-${key}` : "";
  }

  if (app) {
    document.addEventListener("keydown", (e) => {
      const tab = tabKey(e);
      if (tab) {
        e.preventDefault();
        app.event.emit("shortcut", tab).catch(() => {});
        return;
      }
      const key = appKey(e);
      if (key !== "w" && key !== "q") return;
      e.preventDefault();
      if (!e.repeat) app.event.emit("shortcut", key === "w" ? "close" : "quit").catch(() => {});
    });
  }

  window.YardbellNav = { loadUsage, render, order, memPct, RATED, appKey, tabKey, confirm: ask, checkBuild };
  if (document.documentElement.classList.contains("embedded")) return;
  if (page !== "dashboard") {
    load();
    setInterval(load, 10000);
  }
  loadUsage();
  setInterval(loadUsage, 60000);
})();
