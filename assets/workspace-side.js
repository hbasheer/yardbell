(() => {
  const STORE = "workspace.side";
  const MIN_W = 240;
  const phone = matchMedia("(max-width: 760px)");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (p) => String(p ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const base = (p) => String(p).split("/").pop();

  const ICON = {
    files: '<path d="M9.5 1.5H5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 5 12.5h6a1.5 1.5 0 0 0 1.5-1.5V4.5z"/><path d="M9.5 1.5v3h3"/><path d="M3.5 4.5H3A1.5 1.5 0 0 0 1.5 6v7.5A1.5 1.5 0 0 0 3 15h6a1.5 1.5 0 0 0 1.5-1.5V13"/>',
    history: '<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
    folder: '<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z"/>',
    file: '<path d="M9 1.75H4.25c-.83 0-1.5.67-1.5 1.5v9.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5V6z"/><path d="M9 1.75V6h4.25"/>',
    refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
    collapse: '<path d="M2.5 4h11M5 8h8.5M7.5 12h6"/>',
    filter: '<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
    server: '<rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.75 4.75h.01M4.75 11.25h.01"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    play: '<path d="M5 3.5v9l7-4.5z"/>',
  };
  const svg = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
  const CLAUDE = `<svg class="ws-agent claude" viewBox="0 0 16 16" aria-hidden="true">${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a, n) => `<path d="M8 8V${n % 2 ? 2.2 : 1}" transform="rotate(${a} 8 8)"/>`).join("")}</svg>`;

  let ctx = null;
  let prefs = { open: false, tab: "files", width: 320 };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch {} };

  const $ = (id) => document.getElementById(id);
  const panel = $("ws-right");
  const toggle = $("panel-toggle");
  const ws = $("ws");

  let place = null;
  let placeKey = "";
  const dirs = new Map();
  const expanded = new Set();
  const marks = new Map();
  const markedDirs = new Set();
  let markedFiles = "";
  const LETTER = { modified: "M", added: "A", renamed: "R", untracked: "U" };
  let findMode = "names";
  let findText = "";
  let findTimer = 0;
  let found = null;
  let findSeq = 0;
  let scope = "folder";
  let history = null;
  let historyKey = "";
  let historySeq = 0;
  let historyText = "";

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The request failed (${res.status})`);
    return data;
  }

  function q(params) {
    return new URLSearchParams(params).toString();
  }

  function shown() {
    return prefs.open && !phone.matches;
  }

  function applyOpen() {
    const open = shown();
    panel.hidden = !open;
    ws.classList.toggle("side-open", open);
    ws.style.setProperty("--ws-right-w", `${clampWidth(prefs.width)}px`);
    toggle.setAttribute("aria-pressed", String(prefs.open));
    toggle.title = prefs.open ? "Hide files, changes and history" : "Show files, changes and history";
    panel.querySelectorAll("[data-side-tab]").forEach((b) => {
      const on = b.dataset.sideTab === prefs.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    panel.querySelectorAll("[data-side]").forEach((s) => { s.hidden = s.dataset.side !== prefs.tab; });
    window.YardbellChanges.show(open && prefs.tab === "changes");
    window.YardbellChanges.follow(open && prefs.tab === "files");
    if (open) refresh();
  }

  function clampWidth(w) {
    const most = Math.max(MIN_W, Math.min(720, innerWidth - 480));
    return Math.round(Math.min(most, Math.max(MIN_W, Number(w) || 320)));
  }

  function setTab(tab) {
    prefs.tab = tab;
    savePrefs();
    applyOpen();
  }

  function setOpen(open) {
    prefs.open = open;
    savePrefs();
    applyOpen();
  }

  // Files

  function dirEntry(path) {
    return dirs.get(path);
  }

  async function loadDir(path) {
    if (!place) return;
    const key = placeKey;
    dirs.set(path, { loading: true });
    paintTree();
    try {
      const data = await getJson(`/machines/${encodeURIComponent(place.machine)}/files?${q({ root: place.path, path })}`);
      if (key !== placeKey) return;
      dirs.set(path, { entries: data.entries, more: data.more });
    } catch (err) {
      if (key !== placeKey) return;
      dirs.set(path, { error: err.message });
    }
    paintTree();
  }

  // What git reports as changed, as file and folder marks for the tree; when the set of files
  // changes, the open folders are listed again so new files show up.
  function onChanges(list) {
    marks.clear();
    markedDirs.clear();
    for (const f of list?.files || []) {
      if (f.status !== "deleted") marks.set(f.path, f.status);
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) markedDirs.add(parts.slice(0, i).join("/"));
    }
    const names = [...marks.keys()].sort().join("\n");
    const grew = markedFiles !== "" && names !== markedFiles;
    markedFiles = names;
    if (grew) for (const [path, d] of dirs) if (d.entries) loadDir(path);
    paintTree();
  }

  function fileMark(rel) {
    const status = marks.get(rel);
    return status ? { cls: ` chg-${status}`, tag: `<span class="side-mark" aria-label="${status}">${LETTER[status] || ""}</span>` } : { cls: "", tag: "" };
  }

  function rowsOf(path, depth, out) {
    const d = dirEntry(path);
    if (!d || d.loading) {
      out.push(`<div class="side-note" style="--depth:${depth}">Loading…</div>`);
      return;
    }
    if (d.error) {
      out.push(`<div class="side-note bad" style="--depth:${depth}" role="alert">${esc(d.error)}</div>`);
      return;
    }
    if (!d.entries.length && depth === 0) out.push('<div class="side-note">This folder is empty.</div>');
    for (const e of d.entries) {
      const rel = path ? `${path}/${e.name}` : e.name;
      if (e.kind === "dir") {
        const open = expanded.has(rel);
        const inside = markedDirs.has(rel) ? " chg-inside" : "";
        out.push(`<button type="button" class="side-row dir${inside}" role="treeitem" aria-expanded="${open}" data-dir="${esc(rel)}" style="--depth:${depth}" title="${esc(rel)}">${svg("chevron", "icon side-chev")}${svg("folder")}<span class="side-name">${esc(e.name)}</span>${inside ? '<span class="side-dot" aria-label="has changes"></span>' : ""}</button>`);
        if (open) rowsOf(rel, depth + 1, out);
      } else {
        const m = fileMark(rel);
        out.push(`<button type="button" class="side-row file${m.cls}" role="treeitem" data-file="${esc(rel)}" style="--depth:${depth}" title="${esc(rel)}"><span class="side-chev-gap"></span>${svg("file")}<span class="side-name">${esc(e.name)}</span>${m.tag}</button>`);
      }
    }
    if (d.more) out.push(`<div class="side-note" style="--depth:${depth}">Only the first ${d.entries.length} entries are shown.</div>`);
  }

  function paintTree() {
    const tree = $("side-tree");
    if (!place) {
      tree.innerHTML = '<div class="side-note">Open a session or pick a worktree to see its files.</div>';
      return;
    }
    if (findText) {
      paintFound(tree);
      return;
    }
    const out = [];
    rowsOf("", 0, out);
    tree.innerHTML = out.join("");
  }

  function paintFound(tree) {
    if (!found || found.loading) {
      tree.innerHTML = `<div class="side-note">${findMode === "contents" ? "Searching file contents…" : "Finding files…"}</div>`;
      return;
    }
    if (found.error) {
      tree.innerHTML = `<div class="side-note bad" role="alert">${esc(found.error)}</div>`;
      return;
    }
    if (!found.matches.length) {
      tree.innerHTML = `<div class="side-note">${findMode === "contents" ? "No file contains" : "No file name has"} “${esc(findText)}”.</div>`;
      return;
    }
    tree.innerHTML = found.matches.map((rel) => {
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const m = fileMark(rel);
      return `<button type="button" class="side-row file found${m.cls}" data-file="${esc(rel)}" title="${esc(rel)}">${svg("file")}<span class="side-name">${esc(base(rel))}</span><span class="side-dir">&lrm;${esc(dir)}&lrm;</span>${m.tag}</button>`;
    }).join("") + (found.more ? `<div class="side-note">Only the first ${found.matches.length} matches are shown.</div>` : "");
  }

  async function runFind() {
    const text = findText;
    if (!text || !place) {
      found = null;
      paintTree();
      return;
    }
    const seq = ++findSeq;
    found = { loading: true };
    paintTree();
    try {
      const data = await getJson(`/machines/${encodeURIComponent(place.machine)}/files/search?${q({ root: place.path, q: text, mode: findMode })}`);
      if (seq !== findSeq) return;
      found = data;
    } catch (err) {
      if (seq !== findSeq) return;
      found = { error: err.message };
    }
    paintTree();
  }

  function paintPath() {
    const el = $("side-path");
    el.textContent = place ? `\u200e${short(place.path)}\u200e` : "";
    el.title = place ? `${place.path} on ${place.machine}` : "";
  }

  function resetFiles() {
    dirs.clear();
    expanded.clear();
    marks.clear();
    markedDirs.clear();
    markedFiles = "";
    found = null;
    findSeq++;
    paintPath();
    paintTree();
  }

  // History

  function ago(secs) {
    if (!secs) return "";
    const s = Math.max(0, Date.now() / 1000 - secs);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return `${Math.floor(s / (86400 * 30))}mo ago`;
  }

  async function loadHistory(force = false) {
    if (!place) {
      history = null;
      paintHistory();
      return;
    }
    const key = `${place.machine}\n${scope}\n${scope === "all" ? "" : place.path}`;
    if (!force && key === historyKey && history) return;
    historyKey = key;
    const seq = ++historySeq;
    history = { loading: true };
    paintHistory();
    const params = scope === "all" ? { scope: "all" } : { path: place.path };
    try {
      const data = await getJson(`/machines/${encodeURIComponent(place.machine)}/history?${q(params)}`);
      if (seq !== historySeq) return;
      history = { ...data, at: Date.now() };
    } catch (err) {
      if (seq !== historySeq) return;
      history = { error: err.message };
    }
    paintHistory();
  }

  function matches(s, text) {
    if (!text) return true;
    const hay = `${s.title}\n${s.prompt}\n${s.summary}\n${s.folder}`.toLowerCase();
    return text.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function paintHistory() {
    $("side-machine-name").textContent = place?.machine || "";
    $("side-machine").hidden = !place;
    panel.querySelectorAll("[data-scope]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.scope === scope)));
    const list = $("side-hist-list");
    const status = $("side-hist-status");
    const count = $("side-hist-count");
    if (!place) {
      status.hidden = count.hidden = true;
      list.innerHTML = '<div class="side-note">Open a session or pick a worktree to see its past sessions.</div>';
      return;
    }
    if (!history || history.loading) {
      status.hidden = count.hidden = true;
      list.innerHTML = '<div class="side-note">Reading Claude Code’s history…</div>';
      return;
    }
    if (history.error) {
      status.hidden = count.hidden = true;
      list.innerHTML = `<div class="side-note bad" role="alert">${esc(history.error)}</div>`;
      return;
    }
    const all = history.sessions || [];
    const shownList = all.filter((s) => matches(s, historyText));
    status.hidden = count.hidden = false;
    const read = all.length < history.scanned ? ` · newest ${all.length} read` : "";
    status.innerHTML = `${svg("check")}<span>Scanned <b>${history.scanned}</b> ${history.scanned === 1 ? "file" : "files"}${esc(read)}</span><span class="side-hist-when">${esc(ago(history.at / 1000))}</span>`;
    count.innerHTML = `<b>${shownList.length} ${shownList.length === 1 ? "session" : "sessions"}</b><span>Last updated</span>`;
    if (!all.length) {
      list.innerHTML = `<div class="side-note">${scope === "all" ? `No Claude Code sessions on ${esc(place.machine)} yet.` : "No Claude Code sessions in this folder yet."}</div>`;
      return;
    }
    if (!shownList.length) {
      list.innerHTML = `<div class="side-note">No session matches “${esc(historyText)}”.</div>`;
      return;
    }
    list.innerHTML = shownList.map((s) => {
      const folder = scope === "all" && s.folder ? `<span class="side-past-folder" title="${esc(s.folder)}">${svg("folder")}${esc(short(s.folder))}</span>` : "";
      const summary = s.summary ? `<p class="side-past-sum" title="${esc(s.summary)}"><b>Agent:</b> ${esc(s.summary)}</p>` : "";
      const can = Boolean(s.folder);
      return `<article class="side-past" data-id="${esc(s.id)}">
        <div class="side-past-top">
          <strong class="side-past-title" title="${esc(s.prompt || s.title)}">${esc(s.title || "No prompt yet")}</strong>
          <button type="button" class="btn quiet side-resume" data-resume="${esc(s.id)}"${can ? "" : " disabled"} title="${can ? `Resume in ${esc(short(s.folder))}` : "The transcript does not say which folder it ran in"}">${svg("play")}Resume</button>
        </div>
        ${summary}
        <div class="side-past-meta">${CLAUDE}<span>Claude</span><span>${s.messages} msgs</span><span class="side-sep">·</span><span>${esc(ago(s.updated))}</span>${folder}</div>
      </article>`;
    }).join("");
  }

  async function resume(id, button) {
    const s = (history?.sessions || []).find((x) => x.id === id);
    if (!s || !s.folder || !place) return;
    button.disabled = true;
    try {
      await ctx.resume({ machine: place.machine, path: s.folder, id });
    } finally {
      button.disabled = false;
    }
  }

  // Panel

  function refresh() {
    if (!shown()) return;
    if (prefs.tab === "history") loadHistory();
    else if (place && !dirs.has("")) {
      loadDir("");
      if (findText) runFind();
    }
  }

  function update() {
    if (!ctx) return;
    const next = ctx.where();
    const key = next ? `${next.machine}\n${next.path}` : "";
    if (key !== placeKey) {
      place = next;
      placeKey = key;
      history = null;
      historyKey = "";
      resetFiles();
      paintHistory();
    }
    window.YardbellChanges.place(place, shown());
    refresh();
  }

  async function fillFile(body, leaf, { reload = false } = {}) {
    const key = `${leaf.machine}\n${leaf.root}\n${leaf.path}`;
    if (!reload && body.dataset.file === key) return;
    body.dataset.file = key;
    const parts = [base(String(leaf.root || "").replace(/\/$/, "")) || leaf.root, ...String(leaf.path || "").split("/")];
    const crumbs = parts.map((p, i) => (i === parts.length - 1 ? `<b>${esc(p)}</b>` : esc(p))).join('<span class="ws-file-crumb">/</span>');
    body.innerHTML = `<div class="ws-file"><div class="ws-file-bar"><span class="ws-file-path" title="${esc(`${leaf.root}/${leaf.path} on ${leaf.machine}`)}">${crumbs}</span><span class="ws-file-meta">Loading…</span></div><div class="ws-file-scroll"></div></div>`;
    let data;
    try {
      if (!leaf.machine || !leaf.root || !leaf.path) throw new Error("This tab does not say which file it shows.");
      data = await getJson(`/machines/${encodeURIComponent(leaf.machine)}/file?${q({ root: leaf.root, path: leaf.path })}`);
    } catch (err) {
      if (body.dataset.file !== key) return;
      body.querySelector(".ws-file-meta").textContent = "";
      body.querySelector(".ws-file-scroll").innerHTML = `<p class="ws-file-error" role="alert">${esc(err.message)}</p>`;
      return;
    }
    if (body.dataset.file !== key) return;
    const { lang, lines } = window.YardbellHighlight.highlight(data.text, leaf.path);
    const size = data.size >= 1024 ? `${(data.size / 1024).toFixed(data.size >= 10240 ? 0 : 1)} KB` : `${data.size} bytes`;
    body.querySelector(".ws-file-meta").textContent = `${lang ? `${lang} · ` : ""}${lines.length} ${lines.length === 1 ? "line" : "lines"} · ${size} · read only`;
    const nums = lines.map((_, i) => i + 1).join("\n");
    body.querySelector(".ws-file-scroll").innerHTML = `<div class="ws-file-code"><pre class="ws-file-gutter" aria-hidden="true">${nums}</pre><pre class="ws-file-text" tabindex="0" aria-label="${esc(leaf.path)}">${lines.join("\n")}\n</pre></div>`;
  }

  function init(context) {
    ctx = context;
    window.YardbellChanges.init(context);
    window.YardbellChanges.watch(onChanges);
    applyOpen();
    update();
  }

  toggle.addEventListener("click", () => setOpen(!prefs.open));

  panel.querySelector(".ws-right-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-side-tab]");
    if (b) setTab(b.dataset.sideTab);
  });
  panel.querySelector(".ws-right-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...panel.querySelectorAll("[data-side-tab]")];
    const i = tabs.findIndex((t) => t.dataset.sideTab === prefs.tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.sideTab);
    next.focus();
  });

  $("side-tree").addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]");
    if (dir) {
      const rel = dir.dataset.dir;
      if (expanded.has(rel)) expanded.delete(rel);
      else {
        expanded.add(rel);
        if (!dirs.has(rel) || dirs.get(rel).error) loadDir(rel);
      }
      paintTree();
      panel.querySelector(`[data-dir="${CSS.escape(rel)}"]`)?.focus();
      return;
    }
    const file = e.target.closest("[data-file]");
    if (file && place) ctx.openFile({ machine: place.machine, root: place.path, path: file.dataset.file });
  });

  panel.querySelector('[data-side="files"] .side-seg').addEventListener("click", (e) => {
    const b = e.target.closest("[data-find]");
    if (!b || b.dataset.find === findMode) return;
    findMode = b.dataset.find;
    panel.querySelectorAll("[data-find]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("side-find").placeholder = findMode === "contents" ? "Search file contents" : "Find files";
    runFind();
  });

  $("side-find").addEventListener("input", (e) => {
    findText = e.target.value.trim();
    clearTimeout(findTimer);
    if (!findText) {
      findSeq++;
      found = null;
      paintTree();
      return;
    }
    findTimer = setTimeout(runFind, findMode === "contents" ? 400 : 200);
  });

  $("side-refresh").addEventListener("click", () => {
    const keep = [...expanded];
    dirs.clear();
    loadDir("");
    for (const rel of keep) loadDir(rel);
    if (findText) runFind();
  });
  $("side-collapse").addEventListener("click", () => {
    expanded.clear();
    paintTree();
  });

  panel.querySelector('[data-side="history"] .side-seg').addEventListener("click", (e) => {
    const b = e.target.closest("[data-scope]");
    if (!b || b.dataset.scope === scope) return;
    scope = b.dataset.scope;
    loadHistory();
  });
  $("side-hist-refresh").addEventListener("click", () => loadHistory(true));
  $("side-hist-find").addEventListener("input", (e) => {
    historyText = e.target.value.trim();
    paintHistory();
  });
  $("side-hist-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-resume]");
    if (b) resume(b.dataset.resume, b);
  });

  $("ws-right-grip").addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    const move = (ev) => {
      prefs.width = clampWidth(startW + (startX - ev.clientX));
      ws.style.setProperty("--ws-right-w", `${prefs.width}px`);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      savePrefs();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  $("ws-right-grip").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    prefs.width = clampWidth(prefs.width + (e.key === "ArrowLeft" ? 16 : -16));
    ws.style.setProperty("--ws-right-w", `${prefs.width}px`);
    savePrefs();
  });

  phone.addEventListener("change", applyOpen);
  window.addEventListener("resize", () => ws.style.setProperty("--ws-right-w", `${clampWidth(prefs.width)}px`));

  window.YardbellSide = { init, update, fillFile, setOpen, setTab };
})();
