(function () {
  const mac = /Mac/.test(navigator.platform);
  const PAGES = [
    { name: "Dashboard", href: "/" },
    { name: "Workspace", href: "/workspace" },
    { name: "Pipelines", href: "/pipeline" },
    { name: "Diagrams", href: "/diagrams" },
    { name: "Dispatch", href: "/dispatch" },
    { name: "Proposals", href: "/proposals" },
    { name: "Settings", href: "/settings" },
  ];
  const SOURCES = [
    { name: "state", url: "/state", noun: "sessions" },
    { name: "pipelines", url: "/api/pipelines", noun: "pipelines" },
    { name: "runs", url: "/api/runs", noun: "runs" },
    { name: "conversations", url: "/dispatch/conversations", noun: "conversations" },
  ];

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (path) => String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const keyOf = (s) => `${s.machine}/${s.tmux}`;
  const refsOf = (number) => (number ? [`#${number}`, `!${number}`] : []);
  const isPaletteKey = (e) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyK";

  const dialog = document.createElement("dialog");
  dialog.className = "palette";
  dialog.id = "palette";
  dialog.setAttribute("aria-label", "Jump to");
  dialog.innerHTML = `
    <div class="palette-head">
      <input id="palette-q" type="search" autocomplete="off" spellcheck="false" placeholder="Jump to a session, folder, pipeline, run or page" aria-label="Jump to" aria-controls="palette-list" role="combobox" aria-expanded="true" aria-autocomplete="list">
      <button class="btn quiet icon-btn palette-close" type="button" aria-label="Close" title="Close (Esc)"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>
    <ul id="palette-list" role="listbox" aria-label="Places"></ul>
    <p class="palette-note" hidden></p>`;
  document.body.append(dialog);
  const input = dialog.querySelector("#palette-q");
  const list = dialog.querySelector("#palette-list");
  const note = dialog.querySelector(".palette-note");

  let data = null;
  let failed = [];
  let shown = [];
  let selected = 0;
  let moved = false;
  let returnTo = null;
  let generation = 0;

  async function load(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("signed out");
    }
    if (!res.ok) throw new Error(`Yardbell answered ${res.status}`);
    return res.json();
  }

  // The page's own state function, when it has one, knows more than /state does, such as which
  // idle sessions finished out of sight, and the tree's seen map stores what that function says.
  function stateOf(s) {
    const own = window.YardbellShell?.stateOf;
    if (own) return own(s);
    if (s.stale) return "";
    if (s.activity === "blocked") return "blocked";
    if (s.activity === "active") return "working";
    return s.stopped ? "error" : "idle";
  }

  function treeSessions(state) {
    const live = (state.sessions || []).filter((s) => s.tmux && s.attachable && !s.stale);
    const T = window.YardbellTree;
    if (!T || !Array.isArray(state.projects)) return live;
    const ordered = T.build(state, { stateOf }).flatMap((p) => p.sessions);
    return ordered.filter((s) => live.includes(s));
  }

  function sessionItems(state) {
    const agent = (name) => (state.agents || []).find((a) => a.name === name)?.label || name;
    return treeSessions(state).map((s) => {
      const key = keyOf(s);
      const st = stateOf(s);
      const folder = short(s.folder).split("/").pop() || s.tmux;
      return {
        kind: "session",
        id: key,
        label: s.ticket && s.ticket !== "-" ? `${s.ticket} · ${folder}` : folder,
        detail: `${agent(s.agent)} · ${s.machine}`,
        extra: [s.machine, s.folder, s.tmux, ...refsOf(s.pull?.number)],
        href: `/workspace?open=${encodeURIComponent(key)}`,
        blocked: st === "blocked",
        warn: st === "blocked",
        unseen: Boolean(window.YardbellTree?.unseen(key, st)),
      };
    });
  }

  function folderItems(state) {
    const pairs = [];
    const add = (machine, label) => {
      if (label && !pairs.some((p) => p.machine === machine && p.label === label)) pairs.push({ machine, label });
    };
    for (const s of treeSessions(state)) add(s.machine, s.folder);
    for (const f of state.folders || []) add(f.machine, f.label);
    return pairs.map(({ machine, label }) => ({
      kind: "folder",
      id: { machine, folder: label },
      label: short(label),
      detail: machine,
      extra: [machine, label],
      href: `/workspace?folder=${encodeURIComponent(`${machine}/${label}`)}`,
    }));
  }

  function pipelineItems(body) {
    return (body.pipelines || []).map((p) => {
      const waiting = p.runs?.waiting || 0;
      return {
        kind: "pipeline",
        id: p.definition.id,
        label: p.definition.name || p.definition.id,
        detail: waiting ? `${waiting} waiting` : "",
        warn: waiting > 0,
        extra: [],
        href: `/pipeline?p=${encodeURIComponent(p.definition.id)}`,
      };
    });
  }

  function subjectOf(run) {
    const { ticket, pr } = run.subject || {};
    if (ticket?.title) return ticket.title;
    if (ticket?.id) return ticket.id;
    if (pr) return `${pr.forge === "gitlab" ? "!" : "#"}${pr.number}`;
    return "no item";
  }

  function runItems(body) {
    return (body.runs || []).map((r) => ({
      kind: "run",
      id: r.id,
      label: `${r.pipeline_name}: ${subjectOf(r)}`,
      detail: r.state,
      extra: [r.subject?.ticket?.id, r.place?.folder, ...refsOf(r.subject?.pr?.number)],
      href: `/pipeline?p=${encodeURIComponent(r.pipeline)}&tab=runs&run=${encodeURIComponent(r.id)}`,
      at: Date.parse(r.started) || 0,
      waiting: r.state === "waiting",
      warn: r.state === "waiting",
    }));
  }

  function conversationItems(body) {
    return (Array.isArray(body) ? body : []).map((c) => ({
      kind: "conversation",
      id: c.id,
      label: c.title || "New conversation",
      detail: c.waiting > 0 ? "waiting" : "",
      extra: [],
      href: `/dispatch?c=${encodeURIComponent(c.id)}`,
      at: Date.parse(c.updated) || 0,
      waiting: c.waiting > 0,
      warn: c.waiting > 0,
    }));
  }

  const pageItems = () => PAGES.map((p) => ({ kind: "page", id: p.href, label: p.name, detail: "", extra: [], href: p.href }));

  // Sessions carry no time in /state, so the ones that need nothing keep the tree's order.
  function ordered() {
    const sessions = data.state ? sessionItems(data.state) : [];
    const folders = data.state ? folderItems(data.state) : [];
    const runs = data.runs ? runItems(data.runs) : [];
    const conversations = data.conversations ? conversationItems(data.conversations) : [];
    const pipelines = data.pipelines ? pipelineItems(data.pipelines) : [];
    const newest = (a, b) => b.at - a.at;
    const blocked = sessions.filter((s) => s.blocked);
    const unseen = sessions.filter((s) => !s.blocked && s.unseen);
    const restSessions = sessions.filter((s) => !s.blocked && !s.unseen);
    const timed = [...runs.filter((r) => !r.waiting), ...conversations.filter((c) => !c.waiting)].sort(newest);
    return [
      ...blocked,
      ...runs.filter((r) => r.waiting).sort(newest),
      ...conversations.filter((c) => c.waiting).sort(newest),
      ...unseen,
      ...restSessions,
      ...timed,
      ...folders,
      ...pipelines,
      ...pageItems(),
    ];
  }

  function matching(items, query) {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const found = [];
    items.forEach((item, order) => {
      const at = item.label.toLowerCase().indexOf(q);
      if (at >= 0) {
        found.push({ item, group: 0, at, order });
        return;
      }
      const others = [item.detail, ...item.extra].filter(Boolean).map((v) => String(v).toLowerCase().indexOf(q)).filter((i) => i >= 0);
      if (others.length) found.push({ item, group: 1, at: Math.min(...others), order });
    });
    return found.sort((a, b) => a.group - b.group || a.at - b.at || a.order - b.order).map((f) => f.item);
  }

  function render() {
    if (!data) return;
    const keep = moved ? shown[selected]?.href : null;
    shown = matching(ordered(), input.value);
    const at = keep ? shown.findIndex((i) => i.href === keep) : -1;
    selected = at >= 0 ? at : 0;
    if (at < 0) moved = false;
    list.innerHTML = shown.map((item, i) => `<li role="option" id="palette-${i}" data-href="${esc(item.href)}" data-kind="${item.kind}" aria-selected="${i === selected}"><span class="palette-label">${esc(item.label)}</span>${item.detail ? `<span class="palette-detail${item.warn ? " warn" : ""}">${esc(item.detail)}</span>` : ""}</li>`).join("")
      || '<li class="palette-empty" role="presentation">Nothing matches</li>';
    input.setAttribute("aria-activedescendant", shown.length ? `palette-${selected}` : "");
    note.textContent = failed.map((noun) => `Couldn't load ${noun}`).join(". ");
    note.hidden = !failed.length;
  }

  function select(i) {
    if (!shown.length) return;
    selected = (i + shown.length) % shown.length;
    moved = true;
    list.querySelectorAll("[role=option]").forEach((li, n) => li.setAttribute("aria-selected", String(n === selected)));
    input.setAttribute("aria-activedescendant", `palette-${selected}`);
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  }

  function fetchAll() {
    const mine = ++generation;
    const own = window.YardbellShell?.lastState;
    if (own) data.state = own;
    for (const source of SOURCES) {
      if (source.name === "state" && own) continue;
      load(source.url).then((body) => {
        if (mine !== generation) return;
        data[source.name] = body;
        render();
      }, () => {
        if (mine !== generation) return;
        failed.push(source.noun);
        render();
      });
    }
  }

  function open() {
    if (dialog.open) {
      input.focus();
      input.select();
      return;
    }
    returnTo = document.activeElement;
    data = {};
    failed = [];
    moved = false;
    input.value = "";
    dialog.showModal();
    input.focus();
    fetchAll();
    render();
  }

  function refocusOn(back) {
    if (!back || back === document.body || !back.isConnected) return;
    back.focus({ preventScroll: true });
    if (back.tagName === "IFRAME") back.contentWindow?.postMessage({ yardbell: "focus" }, location.origin);
  }

  function close({ refocus = true } = {}) {
    if (!dialog.open) return;
    generation++;
    data = null;
    shown = [];
    const back = returnTo;
    returnTo = null;
    dialog.close();
    if (refocus) refocusOn(back);
  }

  function jump(item) {
    close({ refocus: false });
    const event = new CustomEvent("yardbell-jump", { cancelable: true, detail: { href: item.href, kind: item.kind, id: item.id } });
    if (window.dispatchEvent(event)) location.href = item.href;
  }

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target.closest(".palette-close")) {
      close();
      return;
    }
    const li = e.target.closest("li[role=option]");
    if (li) jump(shown[[...list.children].indexOf(li)]);
  });
  input.addEventListener("input", () => {
    moved = false;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(selected + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[selected]) jump(shown[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!isPaletteKey(e)) return;
    e.preventDefault();
    open();
  });

  window.YardbellPalette = { open, close: () => close(), isOpen: () => dialog.open };
})();
