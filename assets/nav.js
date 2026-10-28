(function () {
  const RATED = 85;
  const page = document.body.dataset.page || "";
  const app = window.__TAURI__;
  const mac = /Mac/.test(navigator.platform);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const version = (server) => (server.version ? ` <a class="server-version" href="/settings#about" title="About Yardbell">v${esc(server.version)}</a>` : "");

  function memPct(m) {
    const h = m.health;
    return m.up && h && h.mem_total_kb ? Math.round((h.mem_used_kb / h.mem_total_kb) * 100) : null;
  }

  function limitPct(m) {
    const h = m.health;
    return m.up && h && h.limit_kb ? Math.round((h.limit_used_kb / h.limit_kb) * 100) : null;
  }

  // An account's own memory limit can run out on a machine with plenty free, so it counts too.
  function tone(m) {
    if (!m.up) return "bad";
    return Math.max(memPct(m) ?? 0, limitPct(m) ?? 0) >= RATED ? "warn" : "ok";
  }

  function word(m) {
    const t = tone(m);
    if (t !== "warn") return t === "bad" ? "down" : "connected";
    const limit = limitPct(m);
    return limit !== null && limit > (memPct(m) ?? 0) ? `your memory limit at ${limit}%` : `memory at ${memPct(m)}%`;
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

  // Writing the same markup again replaces every link, which drops a click that lands in between
  // and flickers the hover, so only a change is written.
  const painted = new WeakMap();

  function paint(el, markup) {
    if (painted.get(el) === markup) return;
    painted.set(el, markup);
    el.innerHTML = markup;
  }

  function render(state, selected) {
    const up = state.machines.filter((m) => m.up).length;
    const summary = document.getElementById("nav-summary");
    const counted = `${up} of ${state.machines.length} connected`;
    if (summary.textContent !== counted) summary.textContent = counted;
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
    paint(document.getElementById("nav-machines"), all + machines.join(""));
    renderServer(state.server);
    const vpn = document.getElementById("nav-vpn");
    const mesh = state.mesh;
    if (!mesh) {
      paint(vpn, "");
      return;
    }
    const on = mesh.on === true ? "on" : mesh.on === false ? "off" : "status unknown";
    vpn.title = `${mesh.label} ${on}`;
    paint(vpn, `<span class="dot ${mesh.on === true ? "ok" : mesh.on === false ? "bad" : ""}"></span>${esc(mesh.label)} ${on}`);
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
    paint(line, `<span>Running on</span> <b>${esc(server.machine)}</b> <code>${esc(server.address)}</code>${version(server)}`);
  }

  function resetsIn(epoch) {
    if (!epoch) return "";
    const mins = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
    if (mins < 60) return `resets in ${mins} min`;
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)} h ${mins % 60} min`;
    return `resets ${new Date(epoch * 1000).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  }

  function checkedAgo(stamp) {
    const mins = Math.round((Date.now() - Date.parse(stamp)) / 60000);
    if (!(mins >= 1)) return "just now";
    if (mins < 60) return `${mins} min ago`;
    return `${Math.floor(mins / 60)} h ago`;
  }

  // The server reads the account's limits every few minutes; when it cannot, these are from
  // Dispatch's last reply, so the card says how old they are.
  async function loadUsage() {
    if (!document.querySelector(".side .side-foot")) return;
    let usage = null;
    try {
      const res = await fetch("/dispatch/usage", { headers: { Accept: "application/json" } });
      if (res.ok) usage = await res.json();
    } catch {}
    renderUsage(usage);
  }

  async function refreshUsage(button) {
    button.disabled = true;
    button.classList.add("spinning");
    try {
      const res = await fetch("/dispatch/usage/refresh", { method: "POST", headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Yardbell answered ${res.status}`);
      renderUsage(body);
    } catch (e) {
      const age = document.querySelector("#nav-usage .usage-age");
      if (age) age.textContent = "couldn't check";
      const card = document.getElementById("nav-usage");
      if (card) card.title = `Couldn't check Claude usage: ${e.message}`;
    } finally {
      button.disabled = false;
      button.classList.remove("spinning");
    }
  }

  function usageRows(windows, who) {
    return windows.map((w) => {
      // Past its reset time the stored figure is from the previous window, so it is not shown.
      const reset = w.resets_at && w.resets_at * 1000 <= Date.now();
      const pct = reset ? 0 : Math.round(w.used * 100);
      const tone = !reset && (w.status !== "allowed" || pct >= 90) ? "bad" : pct >= 70 ? "warn" : "ok";
      return `<div class="usage-row">
        <div class="usage-line"><span>${esc(w.label)}</span><span class="usage-pct">${reset ? "reset" : `${pct}%`}</span></div>
        <div class="usage-track" role="progressbar" aria-label="${esc(`${who} ${w.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="usage-fill ${tone}" style="width: ${Math.max(pct, 1)}%"></span></div>
        <div class="usage-reset">${esc(reset ? "new figures on the next check" : resetsIn(w.resets_at))}</div>
      </div>`;
    }).join("");
  }

  // Codex reports its limits only in its own records of a thread, so these are as of Dispatch's
  // last reply on Codex, with nothing to refresh.
  function codexUsage(usage) {
    const codex = usage?.codex?.windows?.length ? usage.codex : null;
    if (!codex && usage?.runs_on !== "codex") return "";
    const age = codex?.seen ? `Dispatch, ${checkedAgo(codex.seen)}` : "";
    const head = `<div class="usage-head" title="From Codex's own record of Dispatch's last reply"><span>Codex usage</span><span class="usage-tools"><span class="usage-age">${esc(age)}</span></span></div>`;
    return head + (codex ? usageRows(codex.windows, "Codex") : `<p class="usage-none">Not available for Codex.</p>`);
  }

  function renderUsage(usage) {
    const foot = document.querySelector(".side .side-foot");
    if (!foot) return;
    let card = document.getElementById("nav-usage");
    const claude = usage?.windows?.length ? usage : null;
    const codex = codexUsage(usage);
    if (!claude && !codex) {
      card?.remove();
      return;
    }
    if (!card) {
      card = document.createElement("section");
      card.id = "nav-usage";
      card.className = "usage-card";
      card.setAttribute("aria-label", "Usage");
      card.addEventListener("click", (e) => {
        const button = e.target.closest(".usage-refresh");
        if (button) refreshUsage(button);
      });
      foot.before(card);
    }
    if (!claude) {
      card.removeAttribute("title");
      card.innerHTML = codex;
      return;
    }
    const live = claude.source === "account";
    card.title = live
      ? "From your Claude account, checked every 5 minutes"
      : "From Dispatch's last reply. Live figures need Claude Code signed in on the machine running Yardbell.";
    const age = claude.seen ? `${live ? "" : "Dispatch, "}${checkedAgo(claude.seen)}` : "";
    const refresh = `<button class="usage-refresh" type="button" aria-label="Check Claude usage now" title="Check now"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 3.5v3h-3M3 12.5v-3h3M12.4 6.5A5 5 0 0 0 3.6 5.2M3.6 9.5a5 5 0 0 0 8.8 1.3"/></svg></button>`;
    card.innerHTML = `<div class="usage-head"><span>Claude usage</span><span class="usage-tools"><span class="usage-age">${esc(age)}</span>${refresh}</span></div>`
      + usageRows(claude.windows, "Claude")
      + codex;
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

  window.YardbellNav = { loadUsage, render, order, memPct, limitPct, RATED, appKey, tabKey, confirm: ask, checkBuild };
  if (document.documentElement.classList.contains("embedded")) return;
  if (page !== "dashboard") {
    load();
    window.YardbellLive.follow(load, 10000);
  }
  loadUsage();
  setInterval(() => {
    if (!document.hidden) loadUsage();
  }, 60000);
})();
