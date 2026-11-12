(function () {
  const section = document.getElementById("stats-usage");
  if (!section) return;
  const body = document.getElementById("stats-body");
  const TAB_KEY = "yardbell.stats.tab";
  const DAYS_KEY = "yardbell.stats.days";
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const keep = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  let tab = ["all", "claude", "codex"].includes(read(TAB_KEY)) ? read(TAB_KEY) : "all";
  let days = [7, 30, 90].includes(Number(read(DAYS_KEY))) ? Number(read(DAYS_KEY)) : 30;
  let asked = 0;
  let last = null;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const NAMES = { claude: "Claude", codex: "Codex" };

  function tokens(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }

  function duration(secs) {
    if (secs < 60) return "under a minute";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h ${mins % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function started(epoch) {
    const d = new Date(epoch * 1000);
    const today = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return `Today ${time}`;
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }

  const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const ICON = {
    tokens: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
    io: '<path d="M7 7h10M13 3l4 4-4 4M17 17H7M11 13l-4 4 4 4"/>',
    sessions: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    days: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  };

  function card(icon, value, label, title) {
    return `<div class="stats-card"${title ? ` title="${esc(title)}"` : ""}><span class="stats-card-icon"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[icon]}</svg></span><span class="stats-card-text"><span class="stats-card-value">${esc(value)}</span><span class="stats-card-label">${esc(label)}</span></span></div>`;
  }

  function cards(r) {
    const t = r.totals;
    const io = t.input + t.output;
    return `<div class="stats-cards">
      ${card("tokens", tokens(t.tokens), "Total tokens", `${t.tokens.toLocaleString()} tokens, ${t.cache_read.toLocaleString()} of them read from the prompt cache`)}
      ${card("io", tokens(io), "Input and output", `${t.input.toLocaleString()} input, ${t.output.toLocaleString()} output, ${t.cache_write.toLocaleString()} written to the cache`)}
      ${card("sessions", t.sessions.toLocaleString(), t.sessions === 1 ? "Session" : "Sessions", `${t.turns.toLocaleString()} replies`)}
      ${card("days", `${t.active_days} of ${r.days}`, "Active days")}
    </div>`;
  }

  // Tokens per day as bars, with sessions per day as their own row of bars on the same days
  // below, rather than a second scale on one chart.
  function chart(r) {
    const daily = r.daily;
    const W = 720, H = 168, S = 44, top = 18, gap = 2;
    const n = daily.length;
    const step = W / n;
    const bar = Math.max(2, Math.min(22, step - (n > 40 ? 1 : 4)));
    const max = Math.max(1, ...daily.map((d) => d.tokens));
    const maxSessions = Math.max(1, ...daily.map((d) => d.sessions));
    const rounded = (x, y, w, h, r) => {
      if (h <= 0) return "";
      const rr = Math.min(r, h, w / 2);
      return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
    };
    const groups = daily.map((d, i) => {
      const x = i * step + (step - bar) / 2;
      const io = d.input + d.output + d.cache_write;
      const cache = d.cache_read;
      const ioH = ((H - top) * io) / max;
      const cacheH = ((H - top) * cache) / max;
      const ioY = H - ioH;
      const cacheY = ioY - (cacheH > 0 && ioH > 0 ? gap : 0) - cacheH;
      const sH = (S - 8) * (d.sessions / maxSessions);
      const tip = `${dayLabel(d.day)}: ${tokens(d.tokens)} tokens (${tokens(io)} input and output, ${tokens(cache)} cache reads), ${d.sessions} session${d.sessions === 1 ? "" : "s"}`;
      return `<g class="stats-day" data-day="${esc(d.day)}" data-tip="${esc(tip)}"><title>${esc(tip)}</title>
        <rect class="stats-hit" x="${i * step}" y="0" width="${step}" height="${H + S + 6}"/>
        ${ioH > 0 ? `<path class="stats-io" d="${ioH >= 1 && cacheH <= 0 ? rounded(x, ioY, bar, ioH, 3) : `M${x},${H}V${ioY}H${x + bar}V${H}Z`}"/>` : ""}
        ${cacheH > 0 ? `<path class="stats-cache" d="${rounded(x, cacheY, bar, cacheH, 3)}"/>` : ""}
        ${d.sessions ? `<path class="stats-sess" d="${rounded(x, H + 6 + S - sH, bar, sH, 2)}"/>` : ""}
      </g>`;
    }).join("");
    const every = n <= 7 ? 1 : n <= 31 ? 7 : 15;
    const ticks = daily.map((d, i) => ((n - 1 - i) % every === 0 ? `<span style="left: ${((i + 0.5) / n) * 100}%">${esc(dayLabel(d.day))}</span>` : "")).join("");
    return `<section class="stats-panel stats-chart-panel">
      <div class="stats-panel-head"><h3>Daily usage</h3><div class="stats-legend"><span><i class="stats-key io"></i>Input and output</span><span><i class="stats-key cache"></i>Cache reads</span><span><i class="stats-key sess"></i>Sessions, up to ${maxSessions} a day</span></div></div>
      <div class="stats-chart">
        <div class="stats-axis"><span>${esc(tokens(max))}</span></div>
        <svg class="stats-svg" viewBox="0 0 ${W} ${H + S + 6}" preserveAspectRatio="none" role="img" aria-label="Tokens and sessions per day for the last ${r.days} days">
          <line class="stats-base" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"/>
          ${groups}
        </svg>
        <div class="stats-tip" hidden></div>
        <div class="stats-ticks">${ticks}</div>
      </div>
    </section>`;
  }

  function models(r) {
    if (!r.models.length) return "";
    const rows = r.models.slice(0, 8).map((m) => {
      const share = Math.round(m.share * 100);
      return `<tr><td><span class="stats-model">${esc(m.model)}</span>${tab === "all" ? `<span class="stats-agent">${esc(NAMES[m.provider] || m.provider)}</span>` : ""}</td><td class="stats-share"><span class="stats-share-bar"><span style="width: ${Math.max(share, 1)}%"></span></span><span>${share}%</span></td><td class="stats-num">${esc(tokens(m.tokens))}</td><td class="stats-num">${m.turns.toLocaleString()}</td></tr>`;
    }).join("");
    return `<section class="stats-panel"><div class="stats-panel-head"><h3>By model</h3></div><div class="stats-table-wrap"><table class="stats-table stats-models"><thead><tr><th>Model</th><th>Share</th><th class="stats-num">Tokens</th><th class="stats-num">Replies</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function sessions(r) {
    if (!r.sessions.length) return "";
    const rows = r.sessions.map((s) => `<tr>
      <td><span class="stats-project" title="${esc(s.folder || "")}">${esc(s.project)}</span>${tab === "all" ? `<span class="stats-agent">${esc(NAMES[s.provider] || s.provider)}</span>` : ""}</td>
      <td class="stats-muted">${esc(s.model || "Unknown model")}</td>
      <td class="stats-num">${esc(tokens(s.tokens))}</td>
      <td class="stats-muted">${esc(started(s.started))}</td>
      <td class="stats-muted stats-num">${esc(duration(s.duration))}</td>
    </tr>`).join("");
    return `<section class="stats-panel"><div class="stats-panel-head"><h3>Recent sessions</h3></div><div class="stats-table-wrap"><table class="stats-table stats-sessions"><thead><tr><th>Project</th><th>Model</th><th class="stats-num">Tokens</th><th>Started</th><th class="stats-num">Duration</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function empty(r) {
    const name = NAMES[tab];
    const found = name ? r.agents[tab] : r.agents.claude || r.agents.codex;
    if (found) return `<p class="stats-empty">No ${name ? `${name} ` : ""}use in the last ${r.days} days.</p>`;
    return `<p class="stats-empty">No ${name ? `${name} ` : ""}transcripts on this computer yet. Yardbell reads <code>~/.claude/projects</code> for Claude Code and <code>~/.codex/sessions</code> for Codex.</p>`;
  }

  function render(r) {
    last = r;
    const has = r.totals.turns > 0;
    const scan = r.scan ? `<p class="stats-foot">Read ${r.scan.files.toLocaleString()} transcript${r.scan.files === 1 ? "" : "s"} (${r.scan.read.toLocaleString()} changed) in ${r.scan.ms.toLocaleString()} ms.</p>` : "";
    body.innerHTML = has ? `${cards(r)}${chart(r)}${models(r)}${sessions(r)}${scan}` : `${cards(r)}${empty(r)}${scan}`;
  }

  function paintControls() {
    section.querySelectorAll("[data-stats-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.statsTab === tab)));
    section.querySelectorAll("[data-stats-days]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.statsDays) === days)));
  }

  async function load() {
    const mine = ++asked;
    paintControls();
    section.classList.add("stats-loading");
    if (!last) body.innerHTML = '<p class="help">Reading transcripts…</p>';
    try {
      const res = await fetch(`/api/usage/stats?provider=${encodeURIComponent(tab)}&days=${days}`, { headers: { Accept: "application/json" } });
      const report = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(report.error || `Yardbell answered ${res.status}`);
      if (mine === asked) render(report);
    } catch (e) {
      if (mine === asked) body.innerHTML = `<p class="stats-empty bad" role="alert">Couldn't read the usage: ${esc(e.message)}</p>`;
    } finally {
      if (mine === asked) section.classList.remove("stats-loading");
    }
  }

  section.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-stats-tab]");
    if (pick) { tab = pick.dataset.statsTab; keep(TAB_KEY, tab); load(); return; }
    const range = e.target.closest("[data-stats-days]");
    if (range) { days = Number(range.dataset.statsDays); keep(DAYS_KEY, String(days)); load(); return; }
    if (e.target.closest("#stats-refresh")) load();
  });

  body.addEventListener("pointerover", (e) => {
    const day = e.target.closest(".stats-day");
    const tip = body.querySelector(".stats-tip");
    if (!tip) return;
    body.querySelectorAll(".stats-day.on").forEach((g) => g.classList.remove("on"));
    if (!day) { tip.hidden = true; return; }
    day.classList.add("on");
    const box = body.querySelector(".stats-chart").getBoundingClientRect();
    const at = day.querySelector(".stats-hit").getBoundingClientRect();
    tip.textContent = day.dataset.tip;
    tip.hidden = false;
    const left = Math.min(Math.max(0, at.left - box.left + at.width / 2 - tip.offsetWidth / 2), box.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
  });
  body.addEventListener("pointerleave", () => {
    const tip = body.querySelector(".stats-tip");
    if (tip) tip.hidden = true;
    body.querySelectorAll(".stats-day.on").forEach((g) => g.classList.remove("on"));
  });

  const wanted = () => location.hash === "#stats-usage";
  window.addEventListener("hashchange", () => { if (wanted()) load(); });
  if (wanted()) load();

  window.YardbellStats = { load, render };
})();
