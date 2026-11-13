(function () {
  const RANK = { blocked: 0, error: 0, done: 1, working: 2, idle: 3 };
  const WORD = { blocked: "blocked", error: "stopped on an error", done: "done", working: "working", idle: "idle" };
  const SAY = { blocked: "needs you", error: "stopped", done: "done", working: "working", idle: "idle" };
  const SEEN_KEY = "yardbell.tree.seen";
  const OPEN_KEY = "yardbell.tree.open";
  const FOLDED_KEY = "yardbell.tree.folded";
  const KEPT_KEY = "yardbell.ws.kept";
  const LONG_PRESS = 500;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (path) => String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const keyOf = (s) => `${s.machine}/${s.tmux}`;
  const tail = (path) => String(path ?? "").split("/").filter(Boolean).pop() || String(path ?? "");

  function worst(states) {
    return states.filter(Boolean).sort((a, b) => RANK[a] - RANK[b])[0] || "";
  }

  function stored(key, fallback) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : fallback;
    } catch {
      return fallback;
    }
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function liveSessions(state) {
    return (state?.sessions || []).filter((s) => s.tmux && (s.attachable || s.stale));
  }

  // The config's order, with machines that are down at the end.
  function machinesOf(state) {
    const list = [...(state?.machines || [])];
    for (const s of liveSessions(state)) if (!list.some((m) => m.name === s.machine)) list.push({ name: s.machine, up: true });
    return list.map((m, i) => ({ m, i })).sort((a, b) => (b.m.up - a.m.up) || a.i - b.i).map(({ m }) => m);
  }

  // A project's own checkout comes first, then its worktrees and other folders by name.
  function linesOf(p, mine, stateOf) {
    const lines = new Map();
    for (const s of mine) {
      const folder = s.folder || "";
      if (!lines.has(folder)) lines.set(folder, { machine: s.machine, folder, path: s.path || "", branch: "", pull: null, sessions: [] });
      const line = lines.get(folder);
      line.sessions.push(s);
      line.branch ||= s.branch || "";
      line.pull ||= s.pull || null;
    }
    const label = (l) => l.branch || tail(l.folder);
    return [...lines.values()]
      .map((l) => ({ ...l, state: worst(l.sessions.map(stateOf)) }))
      .sort((a, b) => ((b.path === p.path) - (a.path === p.path)) || label(a).localeCompare(label(b)));
  }

  function build(state, { stateOf }) {
    const sessions = liveSessions(state);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const taken = new Set();
    const projects = (state?.projects || []).map((p) => {
      const mine = (p.sessions || []).map((id) => byId.get(id)).filter((s) => s && !taken.has(s));
      for (const s of mine) taken.add(s);
      return {
        id: p.id,
        machine: p.machine,
        path: p.path,
        name: p.name,
        repo: p.repo,
        lines: linesOf(p, mine, stateOf),
        sessions: mine,
        count: mine.filter((s) => !s.stale).length,
        state: worst(mine.map(stateOf)),
      };
    });
    return machinesOf(state).map((m) => {
      const own = projects.filter((p) => p.machine === m.name);
      const other = sessions.filter((s) => s.machine === m.name && !taken.has(s));
      return {
        name: m.name,
        up: Boolean(m.up),
        reason: m.reason || "",
        mem: window.YardbellMachines.memPct(m),
        tone: m.up ? window.YardbellMachines.tone(m) : "down",
        word: m.up ? window.YardbellMachines.word(m) : m.reason || "offline",
        projects: own,
        other,
        sessions: [...own.flatMap((p) => p.sessions), ...other],
      };
    });
  }

  function readSeen() {
    return stored(SEEN_KEY, null);
  }

  function look(key, st) {
    const map = readSeen();
    if (!map || map[key] === st) return;
    map[key] = st;
    store(SEEN_KEY, map);
  }

  // Only the Workspace knows a session is done; elsewhere the same session reads idle.
  const settled = (st) => (st === "done" ? "idle" : st);

  function unseen(key, st) {
    if (!st) return false;
    const map = readSeen();
    return map !== null && settled(map[key]) !== settled(st);
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

  function say(s, st) {
    if (s.stale) return "last known";
    const resets = s.resets ? new Date(s.resets) : null;
    if (st === "error" && resets > Date.now()) return `limit ${resets.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    return SAY[st] || "idle";
  }

  const svg = (cls, body) => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const STAR = svg("tree-agent claude", '<path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2M5.5 2.1l5 11.8M10.5 2.1l-5 11.8M2.1 5.5l11.8 5M13.9 5.5l-11.8 5"/>');
  const PROMPT = svg("tree-agent", '<path d="M3 4.5 6.5 8 3 11.5M8 11.5h5"/>');
  const CHEVRON = svg("icon chevron", '<path d="M6 4l4 4-4 4"/>');
  const MORE = svg("icon", '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>');
  const agentIcon = (agent) => (/claude/i.test(agent || "") ? STAR : PROMPT);

  const stateMark = (st) => `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;

  function pullMark(p) {
    if (!p) return "";
    const { word, tone } = window.YardbellPull.status(p);
    const ref = window.YardbellPull.ref(p);
    return `<span class="tree-pr ${tone}" title="${esc(window.YardbellPull.describe(p))}" aria-label="${esc(window.YardbellPull.noun(p))} ${esc(ref)}, ${esc(word)}">${esc(ref)}</span>`;
  }

  // A session under Other says where it runs instead of its state, which its icon and colour show.
  function sessionRow(s, opts, where = "") {
    const key = keyOf(s);
    const st = opts.stateOf(s);
    const current = opts.selected?.key === key;
    const cls = ["tree-row", "tree-session", where && "other", unseen(key, st) && "unseen", s.stale && "stale", current && "current"].filter(Boolean).join(" ");
    const label = name(s, opts.agents);
    const word = say(s, st);
    const since = age(opts.ageOf?.(key));
    const title = `${label}${where ? ` in ${short(s.cwd || s.path || s.folder)}` : ""}, ${word}${since && since !== "now" ? ` for ${since}` : ""}`;
    const shown = where || word;
    const words = `<span class="tree-word${st === "blocked" ? " needs" : ""}">${esc(shown)}</span>`;
    return `<button type="button" class="${cls}" data-key="${esc(key)}" data-state="${esc(st)}" title="${esc(title)}"${s.stale ? " disabled" : ""}${current ? ' aria-current="true"' : ""}>${agentIcon(s.agent)}<span class="tree-name">${esc(label)}</span>${words}${stateMark(st)}</button>`;
  }

  function lineRow(l, opts) {
    const current = !opts.selected?.key && opts.selected?.machine === l.machine && opts.selected?.folder === l.folder;
    return `<button type="button" class="tree-row tree-branch${current ? " current" : ""}" data-machine="${esc(l.machine)}" data-folder="${esc(l.folder)}" title="${esc(`${short(l.path || l.folder)} on ${l.machine}`)}"${current ? ' aria-current="true"' : ""}><span class="tree-branch-name">${esc(l.branch || tail(l.folder))}</span>${pullMark(l.pull)}</button>${l.sessions.map((s) => sessionRow(s, opts)).join("")}`;
  }

  function holdsCurrent(p, selected) {
    if (!selected) return false;
    if (selected.key) return p.sessions.some((s) => keyOf(s) === selected.key);
    return p.lines.some((l) => l.machine === selected.machine && l.folder === selected.folder);
  }

  function isOpen(p, opts) {
    const choice = stored(OPEN_KEY, {})[p.id];
    return typeof choice === "boolean" ? choice : p.sessions.length > 0 || holdsCurrent(p, opts.selected);
  }

  function projectBlock(p, opts) {
    const open = isOpen(p, opts);
    const inside = holdsCurrent(p, opts.selected);
    const count = `<span class="tree-count" title="${esc(`${p.count} running`)}">${p.count}</span>`;
    const mark = p.state ? `<span class="tree-pdot ${p.state}" title="${esc(WORD[p.state])}"></span>` : "";
    const head = `<div class="tree-prow${inside ? " inside" : ""}"><button type="button" class="tree-row tree-proj" data-toggle="${esc(p.id)}" aria-expanded="${open}" title="${esc(`${p.name}, ${short(p.path)}`)}">${CHEVRON}<span class="tree-name">${esc(p.name)}</span>${count}${mark}</button><button type="button" class="tree-more" data-more="${esc(p.id)}" aria-label="${esc(`More for ${p.name}`)}" title="More" aria-haspopup="menu" aria-expanded="false">${MORE}</button></div>`;
    if (!open) return `<section class="tree-project" data-project="${esc(p.id)}">${head}</section>`;
    const body = p.lines.length
      ? p.lines.map((l) => lineRow(l, opts)).join("")
      : `<button type="button" class="tree-row tree-start" data-start="${esc(p.id)}">No sessions, start one</button>`;
    return `<section class="tree-project" data-project="${esc(p.id)}">${head}<div class="tree-body">${body}</div></section>`;
  }

  function otherBlock(m, opts) {
    if (!m.other.length) return "";
    const rows = m.other.map((s) => sessionRow(s, opts, tail(s.cwd || s.path || s.folder) || "Other")).join("");
    return `<section class="tree-other"><div class="tree-other-label">Other</div><div class="tree-body">${rows}</div></section>`;
  }

  function machineBlock(m, opts, folded) {
    const empty = !m.projects.length && !m.other.length;
    const open = !folded.has(m.name);
    const meta = m.up ? (m.mem === null ? "" : `${m.mem}%`) : "offline";
    const label = `<span class="tree-name">${esc(m.name)}</span><span class="tree-meta">${esc(meta)}</span>`;
    const tone = m.up ? (m.tone === "warn" ? "warn" : "") : "down";
    const cls = ["tree-machine", tone, empty && "empty"].filter(Boolean).join(" ");
    const foldWord = `${open ? "Hide" : "Show"} what runs on ${m.name}`;
    let head;
    if (opts.onMachine) {
      const picked = opts.machine === m.name;
      const pickWord = picked ? "Show every machine" : `Show only ${m.name}`;
      head = `<div class="${cls} split${picked ? " current" : ""}" data-machine-head="${esc(m.name)}"><button type="button" class="tree-fold" data-fold="${esc(m.name)}" aria-expanded="${open}" aria-label="${esc(foldWord)}" title="${esc(foldWord)}">${CHEVRON}</button><button type="button" class="tree-pick" data-pick="${esc(m.name)}" title="${esc(`${m.name}: ${m.word}. ${pickWord}`)}"${picked ? ' aria-current="true"' : ""}>${label}</button></div>`;
    } else {
      head = `<button type="button" class="${cls}" data-fold="${esc(m.name)}" data-machine-head="${esc(m.name)}" aria-expanded="${open}" title="${esc(`${m.name}: ${m.word}`)}">${CHEVRON}${label}</button>`;
    }
    if (!open || empty) return `<section class="tree-group" data-machine-group="${esc(m.name)}">${head}</section>`;
    return `<section class="tree-group" data-machine-group="${esc(m.name)}">${head}<div class="tree-machine-body">${m.projects.map((p) => projectBlock(p, opts)).join("")}${otherBlock(m, opts)}</div></section>`;
  }

  function markup(state, opts) {
    const machines = build(state, { stateOf: opts.stateOf });
    const folded = new Set(Object.keys(stored(FOLDED_KEY, {})));
    const list = machines.length ? machines.map((m) => machineBlock(m, opts, folded)).join("") : '<p class="tree-empty">No machines yet.</p>';
    return `<div class="tree${opts.phone ? " phone" : ""}">${list}</div>`;
  }

  const painted = new WeakMap();
  const latest = new WeakMap();
  const bound = new WeakSet();
  let renaming = null;
  let migrated = false;

  function selectorFor(node) {
    for (const attr of ["data-key", "data-toggle", "data-more", "data-fold", "data-pick", "data-start"]) {
      if (node.hasAttribute(attr)) return `[${attr}="${CSS.escape(node.getAttribute(attr))}"]`;
    }
    if (node.hasAttribute("data-folder")) return `[data-machine="${CSS.escape(node.dataset.machine)}"][data-folder="${CSS.escape(node.dataset.folder)}"]`;
    return "";
  }

  function paint(el, html) {
    if (painted.get(el) === html) return;
    painted.set(el, html);
    const kept = el.contains(document.activeElement) ? selectorFor(document.activeElement) : "";
    el.innerHTML = html;
    if (kept) el.querySelector(kept)?.focus({ preventScroll: true });
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Yardbell answered ${res.status}`);
    return data;
  }

  function fail(opts, err) {
    if (opts.toast) opts.toast(err.message);
    else console.warn(err);
  }

  // Projects this browser once kept for itself move to the server, which every device reads.
  function migrate(opts) {
    if (migrated) return;
    migrated = true;
    let raw = null;
    try { raw = localStorage.getItem(KEPT_KEY); } catch { return; }
    if (raw === null) return;
    const forget = () => { try { localStorage.removeItem(KEPT_KEY); } catch {} };
    let list = [];
    try { list = JSON.parse(raw); } catch {}
    const items = (Array.isArray(list) ? list : [])
      .filter((k) => k && typeof k.machine === "string" && typeof k.path === "string" && k.path)
      .map((k) => ({ machine: k.machine, path: k.path }));
    if (!items.length) {
      forget();
      return;
    }
    post("/api/projects/import", { items })
      .then(() => {
        forget();
        opts.reload?.();
      })
      .catch((err) => console.warn("could not move the kept projects to the server", err));
  }

  let menuEl = null;

  function closeMenu(refocus = false) {
    if (!menuEl) return;
    const trigger = menuEl.trigger;
    menuEl.remove();
    menuEl = null;
    trigger?.setAttribute("aria-expanded", "false");
    if (refocus && trigger?.isConnected) trigger.focus();
  }

  function openMenu(trigger, items, point = null) {
    closeMenu();
    const el = document.createElement("div");
    el.className = "menu tree-menu";
    el.setAttribute("role", "menu");
    el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}>${esc(it.label)}</button>`).join("");
    el.trigger = trigger;
    el.addEventListener("click", (e) => {
      const item = e.target.closest("[data-i]");
      if (!item) return;
      const run = items[Number(item.dataset.i)].run;
      closeMenu(e.detail === 0);
      run();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = [...el.querySelectorAll("[role=menuitem]")];
      const at = all.indexOf(document.activeElement);
      all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
    });
    document.body.append(el);
    menuEl = el;
    trigger.setAttribute("aria-expanded", "true");
    const r = trigger.getBoundingClientRect();
    const x = point ? point.x : r.right - el.offsetWidth;
    const y = point ? point.y : r.bottom + 4;
    el.style.left = `${Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8))}px`;
    el.querySelector("[role=menuitem]").focus();
  }

  document.addEventListener("pointerdown", (e) => {
    if (menuEl && !menuEl.contains(e.target) && !menuEl.trigger?.contains(e.target)) closeMenu();
  }, true);
  addEventListener("resize", () => closeMenu());

  function projectOf(state, id) {
    return (state?.projects || []).find((p) => p.id === id) || null;
  }

  function projectMenu(el, trigger, id, point) {
    const { state, opts } = latest.get(el);
    const p = projectOf(state, id);
    if (!p) return;
    openMenu(trigger, [
      { label: "New session", run: () => opts.onNew?.({ machine: p.machine, path: p.path }) },
      { label: "Rename", run: () => startRename(el, p) },
      { label: "Delete", danger: true, run: () => remove(el, p) },
    ], point);
  }

  function machineMenu(el, trigger, machine, point) {
    const { state, opts } = latest.get(el);
    const m = (state?.machines || []).find((x) => x.name === machine);
    const items = [{ label: "Open on the Dashboard", run: () => (opts.onMachineOpen ? opts.onMachineOpen(machine) : location.assign(`/?machine=${encodeURIComponent(machine)}`)) }];
    if (!m || m.up) {
      items.unshift({ label: "Add a project here", run: () => addProject(el, machine) });
      items.unshift({ label: "New session on this machine", run: () => opts.onNew?.({ machine, path: "" }) });
    }
    openMenu(trigger, items, point);
  }

  async function remove(el, p) {
    const { opts } = latest.get(el);
    const ok = await window.YardbellShell.confirm(
      `Delete ${p.name}?`,
      `It comes off the sidebar on every device. The folder ${short(p.path)} and its files stay where they are, and sessions running there move to Other.`,
      { confirm: "Delete", danger: true },
    );
    if (!ok) return;
    try {
      await post("/api/projects/delete", { id: p.id });
      opts.reload?.();
    } catch (err) {
      fail(opts, err);
    }
  }

  function startRename(el, p) {
    const row = el.querySelector(`[data-toggle="${CSS.escape(p.id)}"]`);
    if (!row) return;
    const { opts } = latest.get(el);
    renaming = el;
    const holder = document.createElement("div");
    holder.className = "tree-row tree-proj renaming";
    holder.innerHTML = `${CHEVRON}<input class="tree-rename" type="text" maxlength="80" aria-label="Project name" autocomplete="off" spellcheck="false">`;
    const input = holder.querySelector("input");
    input.value = p.name;
    row.replaceWith(holder);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (keep) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      renaming = null;
      painted.delete(el);
      const last = latest.get(el);
      render(el, last.state, last.opts);
      el.querySelector(`[data-toggle="${CSS.escape(p.id)}"]`)?.focus({ preventScroll: true });
      if (!keep || value === p.name) return;
      try {
        await post("/api/projects/rename", { id: p.id, name: value });
        opts.reload?.();
      } catch (err) {
        fail(opts, err);
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  function addProject(el, machine = "") {
    const { state, opts } = latest.get(el) || {};
    if (!opts) return;
    const up = (state?.machines || []).filter((m) => m.up).map((m) => m.name);
    if (!up.length) {
      fail(opts, new Error("No machine is connected right now"));
      return;
    }
    window.YardbellNewSession.addProject({
      machines: up,
      machine: machine || opts.machine || opts.selected?.machine || "",
      onAdd: async ({ machine: at, path }) => {
        try {
          const res = await post("/api/projects/add", { machine: at, path });
          const open = stored(OPEN_KEY, {});
          open[res.id] = true;
          store(OPEN_KEY, open);
          const folded = stored(FOLDED_KEY, {});
          delete folded[at];
          store(FOLDED_KEY, folded);
          await opts.reload?.();
        } catch (err) {
          fail(opts, err);
        }
      },
    });
  }

  function toggleProject(el, id) {
    const { state, opts } = latest.get(el);
    const p = build(state, { stateOf: opts.stateOf }).flatMap((m) => m.projects).find((x) => x.id === id);
    if (!p) return;
    const map = stored(OPEN_KEY, {});
    map[id] = !isOpen(p, opts);
    store(OPEN_KEY, map);
    render(el, state, opts);
  }

  function toggleMachine(el, name) {
    const folded = stored(FOLDED_KEY, {});
    if (folded[name]) delete folded[name];
    else folded[name] = true;
    store(FOLDED_KEY, folded);
    const last = latest.get(el);
    render(el, last.state, last.opts);
  }

  function bind(el) {
    if (bound.has(el)) return;
    bound.add(el);
    let press = null;
    let pressed = false;
    const cancelPress = () => {
      clearTimeout(press);
      press = null;
    };
    el.addEventListener("pointerdown", (e) => {
      pressed = false;
      const head = e.target.closest("[data-machine-head]");
      if (!head || e.pointerType === "mouse") return;
      cancelPress();
      press = setTimeout(() => {
        press = null;
        pressed = true;
        machineMenu(el, head.querySelector("[data-pick]") || head, head.dataset.machineHead);
      }, LONG_PRESS);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(type, cancelPress);
    el.addEventListener("contextmenu", (e) => {
      const head = e.target.closest("[data-machine-head]");
      const prow = e.target.closest(".tree-prow");
      if (!head && !prow) return;
      e.preventDefault();
      cancelPress();
      // A long press on a touch screen ends in a click that must not also fold or pick.
      pressed = true;
      if (menuEl) return;
      const point = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
      if (head) machineMenu(el, head.querySelector("[data-pick]") || head, head.dataset.machineHead, point);
      else {
        const more = prow.querySelector("[data-more]");
        projectMenu(el, more, more.dataset.more, point);
      }
    });
    el.addEventListener("click", (e) => {
      const { opts } = latest.get(el);
      const head = e.target.closest("[data-machine-head]");
      if (head && pressed) {
        pressed = false;
        return;
      }
      const fold = e.target.closest("[data-fold]");
      if (fold) {
        toggleMachine(el, fold.dataset.fold);
        return;
      }
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const name = pick.dataset.pick;
        opts.onMachine?.(opts.machine === name ? "" : name);
        return;
      }
      const more = e.target.closest("[data-more]");
      if (more) {
        if (menuEl?.trigger === more) closeMenu();
        else projectMenu(el, more, more.dataset.more);
        return;
      }
      const toggle = e.target.closest("[data-toggle]");
      if (toggle) {
        toggleProject(el, toggle.dataset.toggle);
        return;
      }
      const start = e.target.closest("[data-start]");
      if (start) {
        const p = projectOf(latest.get(el).state, start.dataset.start);
        if (p) opts.onNew?.({ machine: p.machine, path: p.path });
        return;
      }
      const session = e.target.closest("[data-key]");
      if (session) {
        if (!session.disabled) opts.onSession?.(session.dataset.key);
        return;
      }
      const folder = e.target.closest("[data-folder]");
      if (folder) opts.onFolder?.({ machine: folder.dataset.machine, folder: folder.dataset.folder });
    });
    el.addEventListener("keydown", (e) => {
      const toggle = e.target.closest("[data-toggle], [data-fold]");
      if (toggle && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if ((toggle.getAttribute("aria-expanded") === "true") !== (e.key === "ArrowRight")) {
          e.preventDefault();
          if (toggle.dataset.toggle) toggleProject(el, toggle.dataset.toggle);
          else toggleMachine(el, toggle.dataset.fold);
        }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = [...el.querySelectorAll(".tree-row:not(:disabled), .tree-machine:not(.split), .tree-pick")].filter((r) => r.matches("button"));
      const at = rows.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    });
  }

  function render(el, state, opts) {
    latest.set(el, { state, opts: { ...opts, agents: state?.agents || [] } });
    bind(el);
    if (state && Array.isArray(state.projects)) migrate(opts);
    if (renaming === el) return;
    const sessions = liveSessions(state);
    if (state && Array.isArray(state.sessions) && readSeen() === null) {
      store(SEEN_KEY, Object.fromEntries(sessions.map((s) => [keyOf(s), opts.stateOf(s)]).filter(([, st]) => st)));
    }
    paint(el, markup(state, latest.get(el).opts));
  }

  window.YardbellTree = { RANK, WORD, build, render, addProject, worst, look, unseen };
})();
