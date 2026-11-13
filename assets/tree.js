(function () {
  const RANK = { blocked: 0, error: 0, done: 1, working: 2, idle: 3 };
  const WORD = { blocked: "blocked", error: "stopped on an error", done: "done", working: "working", idle: "idle" };
  const SAY = { blocked: "needs you", error: "stopped", done: "done", working: "working", idle: "idle" };
  const SEEN_KEY = "yardbell.tree.seen";
  const OPEN_KEY = "yardbell.tree.open";
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

  // The strip keeps the config's order, with machines that are down at the end.
  function machinesOf(state) {
    const list = [...(state?.machines || [])];
    for (const s of liveSessions(state)) if (!list.some((m) => m.name === s.machine)) list.push({ name: s.machine, up: true });
    return list.map((m, i) => ({ m, i })).sort((a, b) => (b.m.up - a.m.up) || a.i - b.i).map(({ m }) => m);
  }

  function build(state, { stateOf, machine = "" }) {
    const sessions = liveSessions(state);
    const projects = (state?.projects || []).map((p) => {
      const checkouts = p.checkouts.filter((c) => !machine || c.machine === machine).map((c) => {
        const mine = sessions.filter((s) => s.machine === c.machine && (s.folder || "") === c.folder);
        return { ...c, sessions: mine, pull: mine.find((s) => s.pull)?.pull || null, state: worst(mine.map(stateOf)) };
      });
      const all = checkouts.flatMap((c) => c.sessions);
      return {
        id: p.id,
        name: p.name,
        repo: p.repo,
        added: p.checkouts.every((c) => c.added),
        checkouts,
        sessions: all,
        count: all.filter((s) => !s.stale).length,
        state: worst(all.map(stateOf)),
      };
    }).filter((p) => p.checkouts.length);
    return projects.map((p, i) => ({ p, i })).sort((a, b) => (Boolean(b.p.sessions.length) - Boolean(a.p.sessions.length)) || a.i - b.i).map(({ p }) => p);
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
  const PLUS = svg("icon", '<path d="M8 3.5v9M3.5 8h9"/>');
  const agentIcon = (agent) => (/claude/i.test(agent || "") ? STAR : PROMPT);

  const stateMark = (st) => `<span class="ws-state ${st}" title="${esc(WORD[st] || "last known")}"></span>`;

  function pullMark(p) {
    if (!p) return "";
    const { word, tone } = window.YardbellPull.status(p);
    const ref = window.YardbellPull.ref(p);
    return `<span class="tree-pr ${tone}" title="${esc(window.YardbellPull.describe(p))}" aria-label="${esc(window.YardbellPull.noun(p))} ${esc(ref)}, ${esc(word)}">${esc(ref)}</span>`;
  }

  function chip(m, current) {
    const mem = window.YardbellMachines.memPct(m);
    const tone = m.up ? window.YardbellMachines.tone(m) : "down";
    const word = m.up ? window.YardbellMachines.word(m) : m.reason || "offline";
    const pressed = current === m.name;
    const hint = pressed ? "Click to show every machine" : `Click to show only projects on ${m.name}`;
    return `<button type="button" class="tree-chip ${tone}" data-machine-chip="${esc(m.name)}" aria-pressed="${pressed}" title="${esc(`${m.name}: ${word}. ${hint}. Right-click for more.`)}"><span class="tree-dot" aria-hidden="true"></span><span class="tree-chip-name">${esc(m.name)}</span>${mem === null ? "" : `<span class="tree-chip-mem">${mem}%</span>`}</button>`;
  }

  function sessionRow(s, opts) {
    const key = keyOf(s);
    const st = opts.stateOf(s);
    const current = opts.selected?.key === key;
    const cls = ["tree-row", "tree-session", unseen(key, st) && "unseen", s.stale && "stale", current && "current"].filter(Boolean).join(" ");
    const label = name(s, opts.agents);
    const word = say(s, st);
    const since = age(opts.ageOf?.(key));
    const title = `${label}, ${word}${since && since !== "now" ? ` for ${since}` : ""}`;
    return `<button type="button" class="${cls}" data-key="${esc(key)}" data-state="${esc(st)}" title="${esc(title)}"${s.stale ? " disabled" : ""}${current ? ' aria-current="true"' : ""}>${agentIcon(s.agent)}<span class="tree-name">${esc(label)}</span><span class="tree-word${st === "blocked" ? " needs" : ""}">${esc(word)}</span>${stateMark(st)}</button>`;
  }

  function checkoutRow(c, opts) {
    const current = !opts.selected?.key && opts.selected?.machine === c.machine && opts.selected?.folder === c.folder;
    const label = c.branch || tail(c.folder);
    return `<button type="button" class="tree-row tree-branch${current ? " current" : ""}" data-machine="${esc(c.machine)}" data-folder="${esc(c.folder)}" title="${esc(`${short(c.path || c.folder)} on ${c.machine}`)}"${current ? ' aria-current="true"' : ""}><span class="tree-branch-name">${esc(label)}</span><span class="tree-tag">${esc(c.machine)}</span>${pullMark(c.pull)}</button>${c.sessions.map((s) => sessionRow(s, opts)).join("")}`;
  }

  function holdsCurrent(p, selected) {
    if (!selected) return false;
    if (selected.key) return p.sessions.some((s) => keyOf(s) === selected.key);
    return p.checkouts.some((c) => c.machine === selected.machine && c.folder === selected.folder);
  }

  function isOpen(p, opts) {
    const choice = stored(OPEN_KEY, {})[p.id];
    return typeof choice === "boolean" ? choice : p.sessions.length > 0 || holdsCurrent(p, opts.selected);
  }

  function projectBlock(p, opts) {
    const open = isOpen(p, opts);
    const picked = opts.selected?.project === p.id;
    const inside = !picked && holdsCurrent(p, opts.selected);
    const count = `<span class="tree-count" title="${esc(`${p.count} running`)}">${p.count}</span>`;
    const mark = p.state ? `<span class="tree-pdot ${p.state}" title="${esc(WORD[p.state])}"></span>` : "";
    const head = `<div class="tree-prow${picked ? " current" : ""}${inside ? " inside" : ""}"><button type="button" class="tree-row tree-proj" data-toggle="${esc(p.id)}" aria-expanded="${open}" title="${esc(p.name === p.repo ? p.name : `${p.name} (${p.repo})`)}"${picked ? ' aria-current="true"' : ""}>${CHEVRON}<span class="tree-name">${esc(p.name)}</span>${count}${mark}</button><button type="button" class="tree-more" data-more="${esc(p.id)}" aria-label="${esc(`More for ${p.name}`)}" title="More" aria-haspopup="menu" aria-expanded="false">${MORE}</button></div>`;
    if (!open) return `<section class="tree-project" data-project="${esc(p.id)}">${head}</section>`;
    const empty = p.sessions.length ? "" : `<button type="button" class="tree-row tree-start" data-start="${esc(p.id)}">No sessions, start one</button>`;
    return `<section class="tree-project" data-project="${esc(p.id)}">${head}<div class="tree-body">${p.checkouts.map((c) => checkoutRow(c, opts)).join("")}${empty}</div></section>`;
  }

  function hiddenBlock(list, open) {
    if (!list.length) return "";
    const rows = open
      ? `<div class="tree-hidden-list">${list.map((p) => `<div class="tree-hidden-row"><span class="tree-name" title="${esc(p.repo)}">${esc(p.name)}</span><button type="button" class="btn quiet tree-show" data-show="${esc(p.id)}">Show again</button></div>`).join("")}</div>`
      : "";
    return `<div class="tree-hidden"><button type="button" class="tree-hidden-toggle" data-hidden-toggle aria-expanded="${open}">${CHEVRON}${list.length} hidden</button>${rows}</div>`;
  }

  function markup(state, opts) {
    const machines = machinesOf(state);
    const filter = machines.some((m) => m.name === opts.machine) ? opts.machine : "";
    const projects = build(state, { stateOf: opts.stateOf, machine: filter });
    const strip = machines.length
      ? `<div class="tree-head"><span class="tree-label">Machines</span></div><div class="tree-chips" role="group" aria-label="Machines">${machines.map((m) => chip(m, filter)).join("")}</div>`
      : '<p class="tree-empty">No machines yet.</p>';
    const head = `<div class="tree-head projects"><span class="tree-label">Projects</span><button type="button" class="tree-add" data-add-project aria-label="Add a project" title="Add a project" aria-haspopup="dialog">${PLUS}</button></div>`;
    const empty = filter
      ? `<p class="tree-empty">Nothing on ${esc(filter)} yet.</p>`
      : '<p class="tree-empty">No projects yet. Add one with the + above, or start a session.</p>';
    const list = projects.length ? projects.map((p) => projectBlock(p, opts)).join("") : empty;
    return `<div class="tree${opts.phone ? " phone" : ""}">${strip}${head}<div class="tree-projects">${list}</div>${hiddenBlock(state?.hidden_projects || [], hiddenOpen.has(opts.page || ""))}</div>`;
  }

  const painted = new WeakMap();
  const latest = new WeakMap();
  const bound = new WeakSet();
  const hiddenOpen = new Set();
  let renaming = null;
  let migrated = false;

  function selectorFor(node) {
    for (const attr of ["data-key", "data-toggle", "data-more", "data-machine-chip", "data-start", "data-show"]) {
      if (node.hasAttribute(attr)) return `[${attr}="${CSS.escape(node.getAttribute(attr))}"]`;
    }
    for (const attr of ["data-hidden-toggle", "data-add-project"]) if (node.hasAttribute(attr)) return `[${attr}]`;
    if (node.hasAttribute("data-folder")) return `[data-machine="${CSS.escape(node.dataset.machine)}"][data-folder="${CSS.escape(node.dataset.folder)}"]`;
    return "";
  }

  function paint(el, html) {
    if (painted.get(el) === html) return;
    painted.set(el, html);
    const kept = el.contains(document.activeElement) ? selectorFor(document.activeElement) : "";
    const left = el.querySelector(".tree-chips")?.scrollLeft || 0;
    el.innerHTML = html;
    const chips = el.querySelector(".tree-chips");
    if (chips) {
      chips.scrollLeft = left;
      fade(chips);
    }
    if (kept) el.querySelector(kept)?.focus({ preventScroll: true });
  }

  // Chips that run past the column fade out at the edge, until the strip is scrolled to its end.
  function fade(chips) {
    chips.classList.toggle("more", chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 1);
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

  function fullProject(state, id) {
    return (state?.projects || []).find((p) => p.id === id) || null;
  }

  // A place to start in: a checkout on a machine that is up, the main checkout before worktrees.
  function startPlace(state, p) {
    const up = new Set((state?.machines || []).filter((m) => m.up).map((m) => m.name));
    const c = p.checkouts.find((x) => up.has(x.machine)) || p.checkouts[0];
    return c ? { machine: c.machine, path: c.path || c.folder } : null;
  }

  function projectMenu(el, trigger, id, point) {
    const { state, opts } = latest.get(el);
    const p = build(state, { stateOf: opts.stateOf, machine: opts.machine }).find((x) => x.id === id);
    const whole = fullProject(state, id);
    if (!p || !whole) return;
    openMenu(trigger, [
      { label: "New session", run: () => { const at = startPlace(state, p); if (at) opts.onNew?.(at); } },
      { label: "Rename", run: () => startRename(el, whole) },
      { label: whole.checkouts.every((c) => c.added) ? "Remove" : "Hide", danger: true, run: () => remove(el, whole) },
      { label: "Show on Dashboard", run: () => (opts.onProject ? opts.onProject(id) : location.assign(`/?project=${encodeURIComponent(id)}`)) },
    ], point);
  }

  function machineMenu(el, trigger, machine, point) {
    const { state, opts } = latest.get(el);
    const m = (state?.machines || []).find((x) => x.name === machine);
    const items = [{ label: "Open on the Dashboard", run: () => (opts.onMachineOpen ? opts.onMachineOpen(machine) : location.assign(`/?machine=${encodeURIComponent(machine)}`)) }];
    if (!m || m.up) items.unshift({ label: "New session on this machine", run: () => opts.onNew?.({ machine, path: "" }) });
    openMenu(trigger, items, point);
  }

  async function remove(el, p) {
    const { opts } = latest.get(el);
    const deletes = p.checkouts.every((c) => c.added);
    const ok = await window.YardbellShell.confirm(
      deletes ? `Remove ${p.name}?` : `Hide ${p.name}?`,
      deletes
        ? "You added this project, so it comes off the list on every device. Its folder and files stay where they are."
        : "Yardbell finds this project in your workspace folders, so it is hidden rather than deleted. It stays under the hidden projects at the end of the list, where Show again brings it back.",
      { confirm: deletes ? "Remove" : "Hide", danger: deletes },
    );
    if (!ok) return;
    try {
      await post("/api/projects/remove", { id: p.id });
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

  function addProject(el) {
    const { state, opts } = latest.get(el);
    const up = (state?.machines || []).filter((m) => m.up).map((m) => m.name);
    if (!up.length) {
      fail(opts, new Error("No machine is connected right now"));
      return;
    }
    window.YardbellNewSession.addProject({
      machines: up,
      machine: opts.machine || opts.selected?.machine || "",
      onAdd: async ({ machine, path }) => {
        try {
          const res = await post("/api/projects/add", { machine, path });
          await opts.reload?.();
          opts.onAdded?.(res);
        } catch (err) {
          fail(opts, err);
        }
      },
    });
  }

  function toggle(el, id) {
    const { state, opts } = latest.get(el);
    const p = build(state, { stateOf: opts.stateOf, machine: opts.machine }).find((x) => x.id === id);
    if (!p) return;
    const map = stored(OPEN_KEY, {});
    map[id] = !isOpen(p, opts);
    store(OPEN_KEY, map);
    render(el, state, opts);
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
      const chipEl = e.target.closest("[data-machine-chip]");
      if (!chipEl || e.pointerType === "mouse") return;
      cancelPress();
      press = setTimeout(() => {
        press = null;
        pressed = true;
        machineMenu(el, chipEl, chipEl.dataset.machineChip);
      }, LONG_PRESS);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(type, cancelPress);
    el.addEventListener("scroll", (e) => {
      if (e.target.classList?.contains("tree-chips")) fade(e.target);
    }, { capture: true, passive: true });
    el.addEventListener("contextmenu", (e) => {
      const chipEl = e.target.closest("[data-machine-chip]");
      const prow = e.target.closest(".tree-prow");
      if (!chipEl && !prow) return;
      e.preventDefault();
      cancelPress();
      // A long press on a touch screen ends in a click that must not also flip the filter.
      pressed = true;
      if (menuEl) return;
      const point = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
      if (chipEl) machineMenu(el, chipEl, chipEl.dataset.machineChip, point);
      else {
        const more = prow.querySelector("[data-more]");
        projectMenu(el, more, more.dataset.more, point);
      }
    });
    el.addEventListener("click", (e) => {
      const { opts } = latest.get(el);
      const chipEl = e.target.closest("[data-machine-chip]");
      if (chipEl) {
        if (pressed) {
          pressed = false;
          return;
        }
        const name = chipEl.dataset.machineChip;
        opts.onMachine?.(opts.machine === name ? "" : name);
        return;
      }
      if (e.target.closest("[data-add-project]")) {
        addProject(el);
        return;
      }
      const more = e.target.closest("[data-more]");
      if (more) {
        if (menuEl?.trigger === more) closeMenu();
        else projectMenu(el, more, more.dataset.more);
        return;
      }
      const head = e.target.closest("[data-toggle]");
      if (head) {
        toggle(el, head.dataset.toggle);
        return;
      }
      const start = e.target.closest("[data-start]");
      if (start) {
        const { state } = latest.get(el);
        const p = build(state, { stateOf: opts.stateOf, machine: opts.machine }).find((x) => x.id === start.dataset.start);
        const at = p && startPlace(state, p);
        if (at) opts.onNew?.(at);
        return;
      }
      const session = e.target.closest("[data-key]");
      if (session) {
        if (!session.disabled) opts.onSession?.(session.dataset.key);
        return;
      }
      const folder = e.target.closest("[data-folder]");
      if (folder) {
        opts.onFolder?.({ machine: folder.dataset.machine, folder: folder.dataset.folder });
        return;
      }
      if (e.target.closest("[data-hidden-toggle]")) {
        const page = opts.page || "";
        if (hiddenOpen.has(page)) hiddenOpen.delete(page);
        else hiddenOpen.add(page);
        const last = latest.get(el);
        render(el, last.state, last.opts);
        return;
      }
      const show = e.target.closest("[data-show]");
      if (show) {
        show.disabled = true;
        post("/api/projects/show", { id: show.dataset.show }).then(() => opts.reload?.()).catch((err) => {
          show.disabled = false;
          fail(opts, err);
        });
      }
    });
    el.addEventListener("keydown", (e) => {
      const chipEl = e.target.closest("[data-machine-chip]");
      if (chipEl && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const chips = [...el.querySelectorAll("[data-machine-chip]")];
        const at = chips.indexOf(chipEl);
        e.preventDefault();
        chips[Math.max(0, Math.min(chips.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)))].focus();
        return;
      }
      const head = e.target.closest("[data-toggle]");
      if (head && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if ((head.getAttribute("aria-expanded") === "true") !== (e.key === "ArrowRight")) {
          e.preventDefault();
          toggle(el, head.dataset.toggle);
        }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = [...el.querySelectorAll(".tree-row:not(:disabled)")].filter((r) => r.matches("button"));
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

  window.YardbellTree = { RANK, WORD, build, render, worst, look, unseen };
})();
