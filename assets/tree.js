(function () {
  const RANK = { blocked: 0, error: 0, done: 1, working: 2, idle: 3 };
  const WORD = { blocked: "blocked", error: "stopped on an error", done: "done", working: "working", idle: "idle" };
  const SEEN_KEY = "yardbell.tree.seen";
  const FOLDED_KEY = "yardbell.ws.folded";

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (path) => String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const keyOf = (s) => `${s.machine}/${s.tmux}`;
  const byLabel = (a, b) => a.label.localeCompare(b.label);

  function repoOf(path) {
    const m = /^(.*)-worktrees\/[^/]+$/.exec(path);
    return m ? m[1] : path;
  }

  function worst(states) {
    return states.filter(Boolean).sort((a, b) => RANK[a] - RANK[b])[0] || "";
  }

  function build(state, { stateOf, keep = [] }) {
    const sessions = (state?.sessions || []).filter((s) => s.tmux && (s.attachable || s.stale));
    const machines = [...(state?.machines || [])];
    for (const s of sessions) if (!machines.some((m) => m.name === s.machine)) machines.push({ name: s.machine, up: true });
    return window.YardbellMachines.order(machines).map((m) => {
      const folders = new Set(sessions.filter((s) => s.machine === m.name).map((s) => s.folder || "Other"));
      for (const k of keep) if (k.machine === m.name && k.folder) folders.add(k.folder);
      const worktrees = [...folders].map((folder) => {
        const known = (state?.folders || []).find((f) => f.machine === m.name && f.label === folder);
        const mine = sessions.filter((s) => s.machine === m.name && (s.folder || "Other") === folder);
        const pull = mine.find((s) => s.pull)?.pull || null;
        return {
          machine: m.name,
          path: folder,
          label: short(folder),
          branch: known?.branch || mine.find((s) => s.branch)?.branch || "",
          pull,
          state: worst(mine.map(stateOf)),
          sessions: mine,
        };
      });
      const repos = new Map();
      for (const w of worktrees) {
        const path = repoOf(w.path);
        if (!repos.has(path)) repos.set(path, { path, label: short(path), worktrees: [] });
        repos.get(path).worktrees.push(w);
      }
      for (const r of repos.values()) r.worktrees.sort((a, b) => (b.path === r.path) - (a.path === r.path) || byLabel(a, b));
      return {
        name: m.name,
        up: Boolean(m.up),
        reason: m.reason || "",
        mem: window.YardbellMachines.memPct(m),
        tone: window.YardbellMachines.tone(m),
        repos: [...repos.values()].sort(byLabel),
      };
    });
  }

  function readSeen() {
    try {
      const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  function writeSeen(map) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch {}
  }

  function look(key, st) {
    const map = readSeen();
    if (!map || map[key] === st) return;
    map[key] = st;
    writeSeen(map);
  }

  // Only the Workspace knows a session is done; elsewhere the same session reads idle.
  const settled = (st) => (st === "done" ? "idle" : st);

  function unseen(key, st) {
    if (!st) return false;
    const map = readSeen();
    return map !== null && settled(map[key]) !== settled(st);
  }

  function foldedMachines() {
    try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || "[]")); } catch { return new Set(); }
  }

  function fold(machine, hide) {
    const folds = foldedMachines();
    if (hide) folds.add(machine);
    else folds.delete(machine);
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folds])); } catch {}
  }

  function age(since) {
    if (!since) return "";
    const minutes = Math.floor((Date.now() - since) / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  function name(s, agents) {
    const agent = agents.find((a) => a.name === s.agent)?.label || s.agent || s.tmux;
    return s.ticket && s.ticket !== "-" ? `${s.ticket} · ${agent}` : agent;
  }

  const STAR = '<svg class="tree-agent claude" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2M5.5 2.1l5 11.8M10.5 2.1l-5 11.8M2.1 5.5l11.8 5M13.9 5.5l-11.8 5"/></svg>';
  const PROMPT = '<svg class="tree-agent" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8 11.5h5"/></svg>';
  const agentIcon = (agent) => (/claude/i.test(agent || "") ? STAR : PROMPT);

  const dot = (st) => `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;

  function pullMark(p) {
    if (!p) return "";
    const { word, tone } = window.YardbellPull.status(p);
    const ref = window.YardbellPull.ref(p);
    return `<span class="tree-pr ${tone}" title="${esc(window.YardbellPull.describe(p))}" aria-label="${esc(window.YardbellPull.noun(p))} ${esc(ref)}, ${esc(word)}">${esc(ref)}</span>`;
  }

  function fact(s, st, since) {
    if (st === "blocked") return '<span class="tree-fact needs">needs you</span>';
    const resets = s.resets ? new Date(s.resets) : null;
    if (resets > Date.now()) return `<span class="tree-fact">limit ${esc(resets.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span>`;
    if (s.pull) return pullMark(s.pull);
    return `<span class="tree-age">${esc(age(since))}</span>`;
  }

  const CHEVRON = '<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
  const SERVER = '<svg class="icon tree-host" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/></svg>';

  function sessionRow(s, { stateOf, selected, ageOf, phone, agents }) {
    const key = keyOf(s);
    const st = stateOf(s);
    const bold = unseen(key, st);
    const cls = ["tree-row", "tree-session", bold && "unseen", s.stale && "stale", selected?.key === key && "current"].filter(Boolean).join(" ");
    const label = name(s, agents);
    const since = ageOf?.(key);
    const end = phone ? fact(s, st, since) : `${pullMark(s.pull)}<span class="tree-age">${esc(age(since))}</span>`;
    return `<button type="button" class="${cls}" data-key="${esc(key)}" data-state="${esc(st)}" title="${esc(label)}"${s.stale ? " disabled" : ""}${selected?.key === key ? ' aria-current="true"' : ""}>${dot(st)}${agentIcon(s.agent)}<span class="tree-name">${esc(label)}</span>${end}</button>`;
  }

  function cardCurrent(w, selected) {
    if (!selected) return false;
    if (selected.key) return w.sessions.some((s) => keyOf(s) === selected.key);
    return selected.machine === w.machine && selected.folder === w.path;
  }

  function folderRow(w, repo, { selected }) {
    const current = selected?.machine === w.machine && selected?.folder === w.path;
    const own = w.path === repo.path;
    const label = own && repo.worktrees.length === 1 ? repo.label : w.branch || w.label.split("/").pop();
    return `<button type="button" class="tree-row tree-folder${current ? " current" : ""}" data-machine="${esc(w.machine)}" data-folder="${esc(w.path)}" title="${esc(w.label)}"${current ? ' aria-current="true"' : ""}>${dot(w.state)}<span class="tree-text"><span class="tree-name">${esc(label)}</span>${w.branch && w.branch !== label ? `<span class="tree-sub">${esc(w.branch)}</span>` : ""}</span>${pullMark(w.pull)}</button>`;
  }

  function machinePick(m, { tone, label, folded, foldWord, why, current }) {
    const fold = `<button type="button" class="tree-fold" data-fold="${esc(m.name)}" aria-expanded="${!folded}" aria-label="${esc(foldWord)}" title="${esc(foldWord)}">${CHEVRON}</button>`;
    const pick = `<button type="button" class="tree-pick" data-pick="${esc(m.name)}" title="${esc(why || `Show only ${m.name}`)}"${current ? ' aria-current="true"' : ""}>${label}</button>`;
    return `<div class="tree-head tree-machine split ${tone}${current ? " current" : ""}">${fold}${pick}</div>`;
  }

  function machineMarkup(m, opts, folds) {
    const folded = folds.has(m.name);
    const down = m.up ? "" : m.reason ? "unreachable" : "offline";
    const meta = down || (m.mem === null ? "" : `${m.mem}%`);
    const label = opts.phone
      ? `<span class="tree-name">${esc(m.name)}${meta ? `<span class="tree-meta"> · ${esc(down ? "offline" : meta)}</span>` : ""}</span>`
      : `${SERVER}<span class="tree-name">${esc(m.name)}</span><span class="tree-meta">${esc(meta)}</span>`;
    const tone = down ? "down" : m.tone;
    const foldWord = `${folded ? "Show" : "Hide"} the sessions on ${m.name}`;
    const head = opts.onMachine
      ? machinePick(m, { tone, label, folded, foldWord, why: down ? m.reason || "offline" : "", current: opts.selected?.machine === m.name })
      : `<button type="button" class="tree-head tree-machine ${tone}" data-fold="${esc(m.name)}" aria-expanded="${!folded}" title="${esc(down ? m.reason || "offline" : foldWord)}">${CHEVRON}${label}</button>`;
    if (folded) return `<section class="tree-group">${head}</section>`;
    const repos = m.repos.map((r) => {
      const label = r.worktrees.length === 1 && r.worktrees[0].path === r.path ? "" : `<div class="tree-repo" title="${esc(r.label)}">${esc(r.label)}</div>`;
      return `${label}${r.worktrees.map((w) => `<div class="tree-card${cardCurrent(w, opts.selected) ? " current" : ""}">${folderRow(w, r, opts)}${w.sessions.map((s) => sessionRow(s, opts)).join("")}</div>`).join("")}`;
    }).join("");
    return `<section class="tree-group">${head}${repos}</section>`;
  }

  const painted = new WeakMap();
  const latest = new WeakMap();
  const bound = new WeakSet();

  function selectorFor(node) {
    for (const attr of ["data-key", "data-fold", "data-pick"]) if (node.hasAttribute(attr)) return `[${attr}="${CSS.escape(node.getAttribute(attr))}"]`;
    if (node.hasAttribute("data-folder")) return `[data-machine="${CSS.escape(node.dataset.machine)}"][data-folder="${CSS.escape(node.dataset.folder)}"]`;
    return "";
  }

  function paint(el, markup) {
    if (painted.get(el) === markup) return;
    painted.set(el, markup);
    const kept = el.contains(document.activeElement) ? selectorFor(document.activeElement) : "";
    el.innerHTML = markup;
    if (kept) el.querySelector(kept)?.focus({ preventScroll: true });
  }

  function bind(el) {
    if (bound.has(el)) return;
    bound.add(el);
    el.addEventListener("click", (e) => {
      const last = latest.get(el);
      const head = e.target.closest("[data-fold]");
      if (head) {
        fold(head.dataset.fold, head.getAttribute("aria-expanded") === "true");
        render(el, last.state, last.opts);
        return;
      }
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        last.opts.onMachine?.(pick.dataset.pick);
        return;
      }
      const session = e.target.closest("[data-key]");
      if (session && !session.disabled) {
        last.opts.onSession?.(session.dataset.key);
        return;
      }
      const folder = e.target.closest("[data-folder]");
      if (folder) last.opts.onFolder?.({ machine: folder.dataset.machine, folder: folder.dataset.folder });
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = [...el.querySelectorAll(".tree-row:not(:disabled), button.tree-head, .tree-pick")];
      const at = rows.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    });
  }

  function render(el, state, opts) {
    latest.set(el, { state, opts });
    bind(el);
    const stateOf = opts.stateOf;
    const sessions = (state?.sessions || []).filter((s) => s.tmux && (s.attachable || s.stale));
    if (state && Array.isArray(state.sessions) && readSeen() === null) {
      writeSeen(Object.fromEntries(sessions.map((s) => [keyOf(s), stateOf(s)]).filter(([, st]) => st)));
    }
    const machines = build(state, { stateOf, keep: opts.keep });
    const folds = foldedMachines();
    const rows = { ...opts, agents: state?.agents || [] };
    const markup = machines.map((m) => machineMarkup(m, rows, folds)).join("") || '<p class="tree-empty">No machines yet.</p>';
    paint(el, `<div class="tree">${markup}</div>`);
  }

  window.YardbellTree = { RANK, WORD, build, render, repoOf, worst, look, unseen };
})();
