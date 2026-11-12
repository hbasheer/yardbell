(function () {
  const col = document.getElementById("col");
  const rail = document.getElementById("rail");
  if (!col && !rail) return;
  const REFRESH = 300000;
  const SEGMENTS = 10;
  let usage = null;
  let opener = null;
  let machineList = [];

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const svg = (cls, body) => `<svg class="usage-icon${cls ? ` ${cls}` : ""}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    claude: svg("claude", [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a, n) => `<path d="M8 8V${n % 2 ? 2.2 : 1}" transform="rotate(${a} 8 8)"/>`).join("")),
    codex: svg("codex", [0, 60, 120, 180, 240, 300].map((a) => `<path d="M8 2.2a2.6 2.6 0 0 1 2.6 2.6v4.4" transform="rotate(${a} 8 8)"/>`).join("")),
    gemini: svg("gemini", '<path d="M8 1.5c.4 3.4 3.1 6.1 6.5 6.5-3.4.4-6.1 3.1-6.5 6.5-.4-3.4-3.1-6.1-6.5-6.5 3.4-.4 6.1-3.1 6.5-6.5z"/>'),
    other: svg("", '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>'),
    machine: svg("", '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/>'),
    refresh: svg("", '<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.8 2v2.7H9.1M4.2 14v-2.7h2.7"/>'),
    close: svg("", '<path d="M4 4l8 8M12 4l-8 8"/>'),
    next: svg("", '<path d="M6 4l4 4-4 4"/>'),
  };
  const iconOf = (p) => ICONS[p.id] || ICONS.other;

  function resetWord(epoch) {
    if (!epoch) return "";
    const mins = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  }

  function checkedWord(seen) {
    const mins = Math.round((Date.now() - Date.parse(seen)) / 60000);
    if (!(mins >= 1)) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  }

  const past = (w) => Boolean(w.resets_at && w.resets_at * 1000 <= Date.now());
  const pctOf = (w) => (past(w) ? 0 : Math.round((w.used || 0) * 100));
  const toneOf = (w) => {
    const pct = pctOf(w);
    if (!past(w) && (w.status !== "allowed" || pct >= 90)) return "bad";
    return pct >= 70 ? "warn" : "ok";
  };
  const shortOf = (w) => w.short || w.label || "";

  // Older servers send only the Claude windows and Dispatch's Codex figures, without `providers`.
  function providers() {
    if (Array.isArray(usage?.providers)) return usage.providers.map((p) => ({ ...p, windows: p.windows || [] }));
    const out = [];
    if (usage?.windows?.length) out.push({ id: "claude", name: "Claude", windows: usage.windows, source: usage.source, seen: usage.seen, status: "ok" });
    if (usage?.codex?.windows?.length) out.push({ id: "codex", name: "Codex", windows: usage.codex.windows, source: "dispatch", seen: usage.codex.seen, note: "From the last Dispatch reply on Codex", status: "ok" });
    return out;
  }

  // The window nearest its limit among those that exist; a window past its reset counts only when
  // every window is.
  function tightest(windows) {
    const live = windows.filter((w) => !past(w));
    const pool = live.length ? live : windows;
    if (!pool.length) return null;
    return pool.reduce((a, w) => ((w.used || 0) > (a.used || 0) ? w : a));
  }

  function cells(pct, segments, tone, label) {
    const lit = pct === 0 ? 0 : Math.max(1, Math.round((pct / 100) * segments));
    const list = Array.from({ length: segments }, (_, i) => `<i${i < lit ? ' class="on"' : ""}></i>`).join("");
    return `<span class="usage-meter ${tone}" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">${list}</span>`;
  }

  const meter = (w, segments = SEGMENTS) => cells(pctOf(w), segments, toneOf(w), w.label);

  const M = () => window.YardbellMachines;

  // Memory is in the sidebar's machine list already, so the card speaks up only for a machine that
  // is down or short of memory.
  function machineTrouble() {
    const m = M();
    return m ? m.order(machineList).filter((x) => m.tone(x) !== "ok") : [];
  }

  const machineWord = (x) => (x.up ? M().word(x) : "offline");

  const card = document.createElement("button");
  card.type = "button";
  card.className = "usage-card";
  card.id = "usage-card";
  card.setAttribute("aria-haspopup", "dialog");
  card.hidden = true;
  col?.querySelector(".col-foot")?.before(card);

  const railButton = document.createElement("button");
  railButton.type = "button";
  railButton.className = "rail-link rail-usage";
  railButton.id = "rail-usage";
  railButton.setAttribute("aria-haspopup", "dialog");
  railButton.hidden = true;
  rail?.querySelector(".rail-gap")?.after(railButton);

  const scrim = document.createElement("div");
  scrim.className = "usage-scrim";
  scrim.hidden = true;
  const sheet = document.createElement("aside");
  sheet.className = "usage-sheet";
  sheet.id = "usage-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "usage-sheet-title");
  sheet.hidden = true;
  document.body.append(scrim, sheet);

  function cardRow(p) {
    const w = tightest(p.windows);
    const reset = past(w) ? "reset" : resetWord(w.resets_at);
    return `<span class="usage-row ${toneOf(w)}" data-provider="${esc(p.id)}">
      <span class="usage-row-line">${iconOf(p)}<span class="usage-row-name">${esc(p.name)}</span><span class="usage-row-win">${esc(shortOf(w))}</span><span class="usage-row-pct">${pctOf(w)}%</span></span>
      <span class="usage-row-meter">${meter(w)}<span class="usage-row-reset">${esc(reset)}</span></span>
    </span>`;
  }

  function ring(pct, tone) {
    const r = 6.5;
    const c = 2 * Math.PI * r;
    return `<svg class="usage-ring ${tone}" viewBox="0 0 16 16" aria-hidden="true"><circle class="usage-ring-track" cx="8" cy="8" r="${r}"/><circle class="usage-ring-fill" cx="8" cy="8" r="${r}" stroke-dasharray="${((pct / 100) * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
  }

  function renderCard() {
    const list = providers().filter((p) => p.windows.length);
    const trouble = machineTrouble();
    card.hidden = !list.length && !trouble.length;
    railButton.hidden = !list.length;
    if (card.hidden) return;
    const summary = [
      ...list.map((p) => {
        const w = tightest(p.windows);
        return `${p.name} ${shortOf(w)} ${pctOf(w)}%`;
      }),
      ...trouble.map((x) => `${x.name} ${machineWord(x)}`),
    ].join(", ");
    card.setAttribute("aria-label", `Usage: ${summary}`);
    card.title = "Usage for every agent";
    const warn = trouble.map((x) => `<span class="usage-trouble ${M().tone(x)}" data-machine="${esc(x.name)}">${ICONS.machine}<span>${esc(x.name)}: ${esc(machineWord(x))}</span></span>`).join("");
    card.innerHTML = `<span class="usage-card-head">Usage</span>${list.map(cardRow).join("")}${warn}`;
    if (!list.length) return;
    const top = list.map((p) => tightest(p.windows)).reduce((a, w) => (pctOf(w) > pctOf(a) ? w : a));
    railButton.innerHTML = ring(pctOf(top), toneOf(top));
    railButton.setAttribute("aria-label", `Usage: ${summary}`);
    railButton.title = `Usage: ${summary}`;
  }

  function windowRow(w) {
    const reset = past(w) ? "New figures on the next check" : w.resets_at ? `Resets in ${resetWord(w.resets_at)}` : "";
    return `<li class="usage-win ${toneOf(w)}"><span class="usage-win-line"><span class="usage-win-label">${esc(w.label)}</span><span class="usage-win-pct">${past(w) ? "reset" : `${pctOf(w)}%`}</span></span>${meter(w, 20)}<span class="usage-win-reset">${esc(reset)}</span></li>`;
  }

  function section(p) {
    const age = p.seen ? `<span class="usage-sect-age" title="${esc(new Date(p.seen).toLocaleString())}">${esc(checkedWord(p.seen))}</span>` : "";
    const plan = p.plan ? `<span class="usage-sect-plan">${esc(p.plan)}</span>` : "";
    const empty = !p.windows.length ? `<p class="usage-sect-msg${p.status === "error" ? " bad" : ""}">${esc(p.message || "No figures yet")}</p>` : "";
    const lines = [
      p.credits ? `<p class="usage-sect-line">${esc(p.credits)}</p>` : "",
      p.note ? `<p class="usage-sect-line">${esc(p.note)}</p>` : "",
      p.error ? `<p class="usage-sect-line bad" role="status">Couldn't check again: ${esc(p.error)}</p>` : "",
    ].join("");
    return `<section class="usage-sect" data-provider="${esc(p.id)}" aria-label="${esc(p.name)}">
      <header class="usage-sect-head">${iconOf(p)}<h3 class="usage-sect-name">${esc(p.name)}</h3>${plan}${age}</header>
      ${p.windows.length ? `<ul class="usage-wins">${p.windows.map(windowRow).join("")}</ul>` : empty}
      ${lines}
    </section>`;
  }

  function machinesSection() {
    const m = M();
    if (!m || !machineList.length) return "";
    const rows = m.order(machineList).map((x) => {
      const pct = m.memPct(x);
      const tone = m.tone(x);
      return `<li class="usage-win ${tone}" data-machine="${esc(x.name)}"><span class="usage-win-line"><span class="usage-win-label">${esc(x.name)}</span><span class="usage-win-pct">${x.up ? `${pct ?? 0}%` : "offline"}</span></span>${cells(x.up ? pct ?? 0 : 0, 20, tone, `${x.name} memory`)}<span class="usage-win-reset">${esc(x.up ? m.word(x) : "down")}</span></li>`;
    }).join("");
    return `<section class="usage-sect usage-machines" aria-label="Machines">
      <header class="usage-sect-head">${ICONS.machine}<h3 class="usage-sect-name">Machines</h3><span class="usage-sect-age">memory</span></header>
      <ul class="usage-wins">${rows}</ul>
    </section>`;
  }

  function renderSheet() {
    const list = providers();
    const body = (list.length
      ? list.map(section).join("")
      : '<p class="usage-sheet-empty">No agent with plan limits is set up on this computer. Yardbell reads the Claude Code, Codex and Gemini CLI sign-ins.</p>') + machinesSection();
    sheet.innerHTML = `<header class="usage-sheet-head">
        <h2 class="usage-sheet-title" id="usage-sheet-title">Usage</h2>
        <button class="usage-sheet-btn" type="button" data-usage-refresh aria-label="Check usage now" title="Check usage now">${ICONS.refresh}</button>
        <button class="usage-sheet-btn" type="button" data-usage-close aria-label="Close usage" title="Close (Esc)">${ICONS.close}</button>
      </header>
      <div class="usage-sheet-body">${body}</div>
      <a class="usage-sheet-link" href="/settings#stats-usage"><span>Stats &amp; Usage</span><span class="usage-sheet-link-note">Tokens, sessions and models</span>${ICONS.next}</a>`;
  }

  function render() {
    renderCard();
    if (!sheet.hidden) renderSheet();
  }

  function place() {
    if (matchMedia("(max-width: 760px)").matches) {
      sheet.style.left = "0px";
      return;
    }
    const edge = [col, rail].find((el) => el && el.offsetWidth && getComputedStyle(el).display !== "none");
    sheet.style.left = `${edge ? Math.round(edge.getBoundingClientRect().right) : 0}px`;
  }

  function open(from) {
    opener = from || document.activeElement;
    renderSheet();
    place();
    scrim.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add("shown"));
    sheet.querySelector("[data-usage-close]").focus();
  }

  function close() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    scrim.hidden = true;
    sheet.classList.remove("shown");
    const back = opener && opener.isConnected && !opener.hidden ? opener : card.hidden ? null : card;
    back?.focus();
    opener = null;
  }

  async function load() {
    try {
      const res = await fetch("/dispatch/usage", { headers: { Accept: "application/json" } });
      usage = res.ok ? await res.json() : usage;
    } catch {}
    render();
  }

  async function refresh(button) {
    button.disabled = true;
    button.classList.add("busy");
    try {
      const res = await fetch("/dispatch/usage/refresh", { method: "POST", headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Yardbell answered ${res.status}`);
      usage = body;
      render();
    } catch (e) {
      button.disabled = false;
      button.classList.remove("busy");
      button.title = `Couldn't check usage: ${e.message}`;
    }
  }

  card.addEventListener("click", () => open(card));
  railButton.addEventListener("click", () => open(railButton));
  scrim.addEventListener("click", close);
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-usage-close]")) { close(); return; }
    if (e.target.closest(".usage-sheet-link")) { close(); return; }
    const again = e.target.closest("[data-usage-refresh]");
    if (again) refresh(again);
  });
  sheet.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const stops = [...sheet.querySelectorAll("button:not(:disabled), a[href]")];
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) { e.stopPropagation(); close(); }
  });
  window.addEventListener("resize", () => { if (!sheet.hidden) place(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, REFRESH);
  load();

  window.YardbellUsage = {
    load,
    open,
    close,
    render,
    machines(list) {
      machineList = list || [];
      render();
    },
  };
  if (window.YardbellStrip) machineList = window.YardbellStrip.machines();
})();
