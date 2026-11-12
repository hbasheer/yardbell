(() => {
  const VIEW = "workspace.diff.view";
  const NOTES = "workspace.notes";
  const POLL_MS = 5000;
  const WHOLE = 100000;
  const AROUND = 3;
  const FOLD_MIN = 4;
  const MAX_PAGES = 20;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (p) => String(p ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const base = (p) => String(p).split("/").pop();
  const dirOf = (p) => (String(p).includes("/") ? String(p).slice(0, String(p).lastIndexOf("/")) : "");
  const mac = /Mac/.test(navigator.platform);
  const LETTER = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };
  const WORDS = { modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed", untracked: "Untracked" };
  const GROUPS = [
    { id: "staged", label: "Staged", test: (f) => f.staged },
    { id: "changes", label: "Changes", test: (f) => !f.staged && f.status !== "untracked" },
    { id: "untracked", label: "Untracked", test: (f) => f.status === "untracked" },
  ];

  const $ = (id) => document.getElementById(id);
  let ctx = null;
  let place = null;
  let placeKey = "";
  let active = false;
  let list = null;
  let seq = 0;
  let timer = 0;
  let busy = false;
  let following = false;
  const watchers = [];
  const bodies = new Map();

  // The Files tree marks what changed from the same list, so it hears every new one.
  function notify() {
    for (const fn of watchers) fn(list && list.files ? list : null);
  }

  function stored(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  let view = stored(VIEW, "unified") === "split" ? "split" : "unified";
  let notes = stored(NOTES, {});
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) notes = {};

  async function call(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The request failed (${res.status})`);
    return data;
  }

  const q = (params) => new URLSearchParams(params).toString();
  const api = (machine, what, params) => `/machines/${encodeURIComponent(machine)}/changes${what}?${q(params)}`;

  // Notes, kept per diff until they are sent

  const diffKey = (d) => [d.machine, d.root, d.path, d.staged ? "staged" : "worktree"].join("\n");

  function notesOf(key) {
    return Array.isArray(notes[key]) ? notes[key] : [];
  }

  function setNotes(key, list) {
    if (list.length) notes[key] = list;
    else delete notes[key];
    store(NOTES, notes);
  }

  function notesIn(machine, root) {
    const out = [];
    for (const [key, list] of Object.entries(notes)) {
      const [m, r, path, side] = key.split("\n");
      if (m !== machine || r !== root || !Array.isArray(list)) continue;
      for (const n of list) out.push({ ...n, key, path, staged: side === "staged" });
    }
    return out;
  }

  function where(n) {
    return n.side === "old" ? `${n.path}:${n.line} (removed line)` : `${n.path}:${n.line}`;
  }

  function compose(list) {
    return list.map((n) => {
      const code = String(n.code ?? "").split("\n").map((l) => `> ${l}`).join("\n");
      return `${where(n)}\n${code}\n${String(n.text).trim()}`;
    }).join("\n\n");
  }

  // Changes tab

  function count(files) {
    return new Set((files || []).map((f) => f.path)).size;
  }

  function paintBadge() {
    const badge = $("side-changes-count");
    const n = list?.files ? count(list.files) : 0;
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
    const tab = badge.closest("[data-side-tab]");
    tab.setAttribute("aria-label", n ? `Changes, ${n} ${n === 1 ? "file" : "files"}` : "Changes");
  }

  function stats(f) {
    if (f.binary) return '<span class="chg-bin">binary</span>';
    const add = f.added ?? null;
    const del = f.removed ?? null;
    if (add === null && del === null) return "";
    return `<span class="chg-add">+${add ?? 0}</span><span class="chg-del">-${del ?? 0}</span>`;
  }

  function paintList() {
    paintBadge();
    paintSendAll();
    paintCommit();
    const el = $("chg-list");
    const branch = $("chg-branch");
    if (!place) {
      branch.textContent = "";
      el.innerHTML = '<div class="side-note">Open a session or pick a worktree to see its changes.</div>';
      return;
    }
    if (!list || list.loading) {
      if (!list?.files) el.innerHTML = '<div class="side-note">Reading the changes…</div>';
      return;
    }
    if (list.error) {
      branch.textContent = "";
      el.innerHTML = `<div class="side-note bad" role="alert">${esc(list.error)}</div>`;
      return;
    }
    const ab = [list.ahead ? `↑${list.ahead}` : "", list.behind ? `↓${list.behind}` : ""].filter(Boolean).join(" ");
    branch.innerHTML = `<span class="chg-branch-name">${esc(list.branch || "no branch")}</span>${ab ? `<span class="chg-ab" title="${esc(`${list.ahead || 0} ahead of and ${list.behind || 0} behind ${list.upstream}`)}">${esc(ab)}</span>` : ""}`;
    branch.title = list.upstream ? `${list.branch} tracks ${list.upstream}` : `${list.branch || "Detached"}, no upstream`;
    if (!list.files.length) {
      el.innerHTML = '<div class="side-note">No changes. The working tree matches the last commit.</div>';
      return;
    }
    const noted = new Map();
    for (const n of notesIn(place.machine, place.path)) noted.set(`${n.path}\n${n.staged}`, (noted.get(`${n.path}\n${n.staged}`) || 0) + 1);
    const out = [];
    for (const g of GROUPS) {
      const files = list.files.filter(g.test);
      if (!files.length) continue;
      out.push(`<div class="chg-group" role="presentation"><span>${g.label}</span><span class="chg-group-n">${files.length}</span></div>`);
      for (const f of files) {
        const dir = dirOf(f.path);
        const n = noted.get(`${f.path}\n${f.staged}`);
        const was = f.old_path ? ` (was ${f.old_path})` : "";
        out.push(`<button type="button" class="side-row chg-row" role="treeitem" data-path="${esc(f.path)}" data-staged="${f.staged}" title="${esc(`${WORDS[f.status]}: ${f.path}${was}`)}">
          <span class="chg-st ${esc(f.status)}" aria-label="${esc(WORDS[f.status])}">${LETTER[f.status] || "?"}</span>
          <span class="side-name">${esc(base(f.path))}</span>${dir ? `<span class="side-dir">&lrm;${esc(dir)}&lrm;</span>` : '<span class="chg-fill"></span>'}
          ${n ? `<span class="chg-noted" title="${n} ${n === 1 ? "note" : "notes"} waiting">${n}</span>` : ""}<span class="chg-stats">${stats(f)}</span>
        </button>`);
      }
    }
    if (list.truncated) out.push(`<div class="side-note">Only the first ${list.files.length} changes are shown.</div>`);
    el.innerHTML = out.join("");
  }

  function paintSendAll() {
    const b = $("chg-send-all");
    const n = place ? notesIn(place.machine, place.path).length : 0;
    b.hidden = !n;
    b.textContent = `Send notes (${n})`;
  }

  function paintCommit() {
    const n = list?.files ? count(list.files) : 0;
    const go = $("chg-commit-go");
    go.textContent = n ? `Commit ${n} ${n === 1 ? "file" : "files"}` : "Commit";
    go.disabled = busy || !n || !$("chg-message").value.trim();
    $("chg-draft").disabled = busy || !n;
    go.title = `${go.textContent} (${mac ? "⌘↵" : "Ctrl+Enter"})`;
  }

  async function load() {
    if (!place) {
      list = null;
      paintList();
      return;
    }
    const key = placeKey;
    const my = ++seq;
    if (!list) list = { loading: true };
    else list.loading = true;
    paintList();
    try {
      const data = await call(api(place.machine, "", { root: place.path }));
      if (my !== seq || key !== placeKey) return;
      const same = list?.files && JSON.stringify({ ...list, loading: undefined }) === JSON.stringify(data);
      list = data;
      if (same) return;
    } catch (err) {
      if (my !== seq || key !== placeKey) return;
      list = { error: err.message };
    }
    paintList();
    notify();
  }

  function poll() {
    clearInterval(timer);
    timer = 0;
    if ((!active && !following) || document.hidden || !place) return;
    timer = setInterval(() => { if (!busy) load(); }, POLL_MS);
  }

  function show(on) {
    const was = active;
    active = on;
    if (on && !was) load();
    poll();
  }

  function follow(on) {
    const was = following;
    following = on;
    if (on && !was && !active) load();
    poll();
  }

  function watch(fn) {
    watchers.push(fn);
  }

  function setPlace(next, open) {
    const key = next ? `${next.machine}\n${next.path}` : "";
    if (key === placeKey) {
      if (open && !list) load();
      return;
    }
    place = next;
    placeKey = key;
    list = null;
    seq++;
    $("chg-message").value = "";
    paintList();
    notify();
    if (open || active || following) load();
    poll();
  }

  async function draft() {
    if (!place) return;
    const button = $("chg-draft");
    button.disabled = true;
    try {
      const data = await call(api(place.machine, "/draft", { root: place.path }));
      const box = $("chg-message");
      box.value = data.message || "";
      box.focus();
      if (data.from === "files") ctx.toast("Drafted from the file names. Edit it before you commit.");
    } catch (err) {
      ctx.toast(err.message);
    }
    paintCommit();
  }

  async function commit() {
    if (!place || busy || !list?.files?.length) return;
    const message = $("chg-message").value;
    if (!message.trim()) {
      ctx.toast("Write a commit message first");
      $("chg-message").focus();
      return;
    }
    const body = { root: place.path, message };
    if (!list.truncated) body.paths = [...new Set(list.files.map((f) => f.path))];
    busy = true;
    paintCommit();
    const at = place;
    try {
      const data = await call(`/machines/${encodeURIComponent(at.machine)}/changes/commit`, { method: "POST", body: JSON.stringify(body) });
      if (at === place) $("chg-message").value = "";
      ctx.toast(`Committed ${data.short}`);
    } catch (err) {
      ctx.toast(err.message);
    } finally {
      busy = false;
      await load();
    }
  }

  // Sending notes to the session that runs in the folder

  function sendTo(machine, root, list, onSent) {
    if (!list.length) return;
    const owners = ctx.sessionsIn(machine, root);
    if (!owners.length) {
      ctx.toast("No session runs in this folder. Start one, then send it the notes.");
      return;
    }
    const dlg = $("chg-send");
    const text = compose(list);
    $("chg-send-title").textContent = `Send ${list.length} ${list.length === 1 ? "note" : "notes"} to the agent`;
    $("chg-send-who").innerHTML = owners.length === 1
      ? `<p class="chg-send-one">To <b>${esc(owners[0].label)}</b> <span class="chg-send-tmux">${esc(owners[0].tmux)} on ${esc(owners[0].machine)}</span></p>`
      : `<p class="chg-send-ask">Several sessions run in ${esc(short(root))}. Which one gets the notes?</p>${owners.map((o, i) => `<label class="chg-send-opt"><input type="radio" name="chg-send-to" value="${i}" data-tmux="${esc(o.tmux)}"${i ? "" : " checked"}><span>${esc(o.label)}</span><span class="chg-send-tmux">${esc(o.tmux)}</span></label>`).join("")}`;
    $("chg-send-text").textContent = text;
    $("chg-send-now").checked = false;
    const done = async (e) => {
      const v = e.target.closest("button")?.value;
      if (!v) return;
      if (v === "cancel") {
        dlg.close();
        return;
      }
      const picked = owners.length === 1 ? owners[0] : owners[Number(dlg.querySelector("input[name=chg-send-to]:checked")?.value || 0)];
      const enter = $("chg-send-now").checked;
      const go = dlg.querySelector("button[value=send]");
      go.disabled = true;
      try {
        await call(`/sessions/${encodeURIComponent(picked.machine)}/${encodeURIComponent(picked.tmux)}/text`, { method: "POST", body: JSON.stringify({ text, enter }) });
        dlg.close();
        onSent();
        ctx.toast(enter ? `Sent the notes to ${picked.label}` : `Pasted the notes into ${picked.label}'s prompt`);
      } catch (err) {
        ctx.toast(err.message);
      } finally {
        go.disabled = false;
      }
    };
    dlg.onclick = done;
    dlg.showModal();
  }

  function dropSent(sent) {
    const ids = new Set(sent.map((n) => n.id));
    const keys = new Set(sent.map((n) => n.key));
    for (const key of keys) setNotes(key, notesOf(key).filter((n) => !ids.has(n.id)));
    paintList();
    for (const [body, st] of bodies) {
      if (!body.isConnected) bodies.delete(body);
      else if (keys.has(st.key)) paint(body);
    }
  }

  // Diff tab

  function crumbs(leaf) {
    const parts = [base(String(leaf.root || "").replace(/\/$/, "")) || leaf.root, ...String(leaf.path || "").split("/")];
    return parts.map((p, i) => (i === parts.length - 1 ? `<b>${esc(p)}</b>` : esc(p))).join('<span class="ws-file-crumb">/</span>');
  }

  // Each side is coloured as one text, so a comment or string opened on one line carries on.
  function colour(lines, path) {
    const side = (keep) => {
      const at = [];
      const text = [];
      lines.forEach((l, i) => { if (keep(l.k)) { at.push(i); text.push(l.t); } });
      const out = new Map();
      if (!text.length) return out;
      const { lines: html } = window.YardbellHighlight.highlight(`${text.join("\n")}\n`, path);
      at.forEach((i, j) => out.set(i, html[j] ?? esc(text[j])));
      return out;
    };
    const fresh = side((k) => k === "add" || k === "ctx");
    const old = side((k) => k === "del");
    return lines.map((l, i) => (l.k === "del" ? old.get(i) : fresh.get(i)) ?? esc(l.t));
  }

  function anchorOf(l) {
    if (l.k === "del") return `old:${l.o}`;
    if (l.k === "add" || l.k === "ctx") return `new:${l.n}`;
    return "";
  }

  // Runs of unchanged lines far from any change or note fold away behind "Show N lines".
  function folds(lines, noted) {
    const near = new Array(lines.length).fill(false);
    lines.forEach((l, i) => {
      const at = anchorOf(l);
      const hot = l.k === "add" || l.k === "del" || (at && noted.has(at));
      if (!hot) return;
      for (let j = Math.max(0, i - AROUND); j <= Math.min(lines.length - 1, i + AROUND); j++) near[j] = true;
    });
    const out = new Map();
    let start = -1;
    const close = (end) => {
      if (start >= 0 && end - start >= FOLD_MIN) out.set(start, end);
      start = -1;
    };
    lines.forEach((l, i) => {
      if (l.k === "ctx" && !near[i]) { if (start < 0) start = i; }
      else close(i);
    });
    close(lines.length);
    return out;
  }

  function noteCard(n, editing) {
    if (editing) return editorHtml(n.text, n.id);
    return `<div class="dnote" data-note="${esc(n.id)}"><p class="dnote-text">${esc(n.text)}</p><div class="dnote-acts"><button type="button" data-act="edit-note">Edit</button><button type="button" data-act="remove-note">Remove</button></div></div>`;
  }

  function editorHtml(text, id = "") {
    return `<div class="dnote editing"${id ? ` data-note="${esc(id)}"` : ""}><textarea class="dnote-box" rows="3" placeholder="Leave a note for the agent on this line" aria-label="Note">${esc(text)}</textarea><div class="dnote-acts"><span class="dnote-hint">${mac ? "⌘↵" : "Ctrl+Enter"} to save</span><button type="button" data-act="cancel-note">Cancel</button><button type="button" class="on" data-act="save-note">${id ? "Save" : "Add note"}</button></div></div>`;
  }

  function numCell(v, cls) {
    return `<td class="dn ${cls}">${v ?? ""}</td>`;
  }

  function plusCell(anchor) {
    return anchor ? `<td class="dp"><button type="button" class="dplus" data-act="add-note" data-at="${anchor}" aria-label="Add a note on this line" title="Add a note">+</button></td>` : '<td class="dp"></td>';
  }

  function codeCell(l, html, cls = "") {
    const mark = l.k === "add" ? "+" : l.k === "del" ? "-" : " ";
    return `<td class="dc ${cls}"><span class="dmark" aria-hidden="true">${mark}</span>${html}</td>`;
  }

  function paint(body) {
    const st = bodies.get(body);
    if (!st?.data) return;
    const { data, leaf } = st;
    const lines = st.lines;
    const list = notesOf(st.key);
    const byAnchor = new Map();
    for (const n of list) {
      const a = `${n.side}:${n.line}`;
      if (!byAnchor.has(a)) byAnchor.set(a, []);
      byAnchor.get(a).push(n);
    }
    const html = colour(lines, leaf.path);
    const fold = folds(lines, new Set([...byAnchor.keys(), st.adding || ""]));
    const cols = view === "split" ? 6 : 4;
    const placed = new Set();
    const notesRow = (anchors) => {
      const parts = [];
      for (const a of anchors) {
        if (!a) continue;
        for (const n of byAnchor.get(a) || []) {
          placed.add(n.id);
          parts.push(noteCard(n, st.editing === n.id));
        }
        if (st.adding === a) parts.push(editorHtml("", ""));
      }
      return parts.length ? `<tr class="dnote-row"><td colspan="${cols}">${parts.join("")}</td></tr>` : "";
    };
    const rows = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (fold.has(i) && !st.open.has(i)) {
        const end = fold.get(i);
        rows.push(`<tr class="dfold"><td colspan="${cols}"><button type="button" data-act="unfold" data-at="${i}">Show ${end - i} ${end - i === 1 ? "line" : "lines"}</button></td></tr>`);
        i = end;
        continue;
      }
      if (l.k === "hunk") {
        if (i > 0) rows.push(`<tr class="dhunk"><td colspan="${cols}">${esc(l.t)}</td></tr>`);
        i++;
        continue;
      }
      if (l.k === "meta") {
        rows.push(`<tr class="dmeta"><td colspan="${cols}">${esc(l.t)}</td></tr>`);
        i++;
        continue;
      }
      if (view === "unified" || l.k === "ctx") {
        const a = anchorOf(l);
        if (view === "unified") {
          rows.push(`<tr class="dl ${l.k}">${numCell(l.o, "o")}${numCell(l.n, "n")}${plusCell(a)}${codeCell(l, html[i])}</tr>`);
        } else {
          rows.push(`<tr class="dl ctx">${numCell(l.o, "o")}${plusCell(a)}${codeCell(l, html[i], "left")}${numCell(l.n, "n")}${plusCell(a)}${codeCell(l, html[i], "right")}</tr>`);
        }
        rows.push(notesRow([a]));
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < lines.length && lines[i].k === "del") dels.push(i++);
      while (i < lines.length && lines[i].k === "add") adds.push(i++);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        const d = dels[j] !== undefined ? lines[dels[j]] : null;
        const a = adds[j] !== undefined ? lines[adds[j]] : null;
        const left = d ? `${numCell(d.o, "o")}${plusCell(anchorOf(d))}${codeCell(d, html[dels[j]], "left")}` : '<td class="dn o dvoid"></td><td class="dp dvoid"></td><td class="dc left dvoid"></td>';
        const right = a ? `${numCell(a.n, "n")}${plusCell(anchorOf(a))}${codeCell(a, html[adds[j]], "right")}` : '<td class="dn n dvoid"></td><td class="dp dvoid"></td><td class="dc right dvoid"></td>';
        rows.push(`<tr class="dl pair${d ? " has-del" : ""}${a ? " has-add" : ""}">${left}${right}</tr>`);
        rows.push(notesRow([d && anchorOf(d), a && anchorOf(a)]));
      }
    }
    const lost = list.filter((n) => !placed.has(n.id));
    const lostRows = lost.length
      ? `<tr class="dnote-row lost"><td colspan="${cols}"><p class="dnote-lost">${lost.length === 1 ? "This note is" : "These notes are"} on lines no longer in the diff.</p>${lost.map((n) => `<div class="dnote" data-note="${esc(n.id)}"><p class="dnote-where">${esc(where({ ...n, path: leaf.path }))}</p><p class="dnote-text">${esc(n.text)}</p><div class="dnote-acts"><button type="button" data-act="remove-note">Remove</button></div></div>`).join("")}</td></tr>`
      : "";
    const empty = data.binary
      ? `<p class="ws-file-error">${esc(base(leaf.path))} is a binary file, so its changes are not shown.</p>`
      : !lines.some((l) => l.k !== "hunk")
        ? `<p class="ws-file-error">${esc(data.notes?.join(". ") || "No line changed.")}</p>`
        : "";
    const colgroup = view === "split"
      ? '<colgroup><col class="cn"><col class="cp"><col class="cc"><col class="cn"><col class="cp"><col class="cc"></colgroup>'
      : '<colgroup><col class="cn"><col class="cn"><col class="cp"><col class="cc"></colgroup>';
    const scroll = body.querySelector(".ws-diff-scroll");
    const top = scroll.scrollTop;
    scroll.innerHTML = empty || `${data.notes?.length ? `<p class="ws-diff-notes">${esc(data.notes.join(". "))}</p>` : ""}<table class="ws-diff-table ${view}">${colgroup}<tbody>${lostRows}${rows.join("")}</tbody></table>${data.cut ? '<p class="ws-diff-notes">The diff is too large, so only its start is shown.</p>' : ""}`;
    scroll.scrollTop = top;
    paintHead(body);
    const box = scroll.querySelector(".dnote.editing textarea");
    if (box && st.focus) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      st.focus = false;
    }
  }

  function paintHead(body) {
    const st = bodies.get(body);
    const n = notesOf(st.key).length;
    const send = body.querySelector("[data-act=send-notes]");
    send.hidden = !n;
    send.textContent = `Send notes to agent (${n})`;
    body.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    const d = st.data;
    if (d) {
      const counts = d.binary ? "binary" : `<span class="chg-add">+${d.added ?? 0}</span><span class="chg-del">-${d.removed ?? 0}</span>`;
      body.querySelector(".ws-diff-counts").innerHTML = counts;
    }
  }

  async function fetchDiff(leaf) {
    const params = { root: leaf.root, path: leaf.path, staged: leaf.staged ? "true" : "false", context: WHOLE };
    let data = await call(api(leaf.machine, "/diff", { ...params, from: 0 }));
    const lines = [...data.lines];
    for (let page = 1; data.next < data.total && page < MAX_PAGES; page++) {
      data = await call(api(leaf.machine, "/diff", { ...params, from: data.next }));
      lines.push(...data.lines);
    }
    return { data: { ...data, cut: data.cut || data.next < data.total }, lines };
  }

  async function fillDiff(body, leaf, { reload = false } = {}) {
    const key = diffKey(leaf);
    if (!reload && body.dataset.diff === key && bodies.get(body)?.data) return;
    body.dataset.diff = key;
    const side = leaf.staged ? "Staged" : "Working tree";
    body.innerHTML = `<div class="ws-diff">
      <div class="ws-file-bar ws-diff-bar">
        <span class="ws-file-path" title="${esc(`${leaf.root}/${leaf.path} on ${leaf.machine}`)}">${crumbs(leaf)}</span>
        <span class="ws-diff-side">${side}</span>
        <span class="ws-diff-counts"></span>
        <button type="button" class="ws-diff-send" data-act="send-notes" hidden></button>
        <span class="ws-diff-views" role="tablist" aria-label="Diff layout"><button type="button" role="tab" data-view="unified">Unified</button><button type="button" role="tab" data-view="split">Split</button></span>
      </div>
      <div class="ws-diff-scroll"><p class="ws-file-error">Loading the diff…</p></div>
    </div>`;
    const st = { key, leaf, data: null, lines: [], open: new Set(), adding: "", editing: "", focus: false };
    bodies.set(body, st);
    paintHead(body);
    try {
      if (!leaf.machine || !leaf.root || !leaf.path) throw new Error("This tab does not say which change it shows.");
      const got = await fetchDiff(leaf);
      if (body.dataset.diff !== key || bodies.get(body) !== st) return;
      st.data = got.data;
      st.lines = got.lines;
    } catch (err) {
      if (body.dataset.diff !== key || bodies.get(body) !== st) return;
      body.querySelector(".ws-diff-scroll").innerHTML = `<p class="ws-file-error" role="alert">${esc(err.message)}</p>`;
      return;
    }
    paint(body);
  }

  function lineAt(st, anchor) {
    const [side, num] = anchor.split(":");
    const n = Number(num);
    return st.lines.find((l) => (side === "old" ? l.k === "del" && l.o === n : (l.k === "add" || l.k === "ctx") && l.n === n));
  }

  function onDiffClick(e) {
    const body = e.target.closest(".ws-pane-body");
    const st = body && bodies.get(body);
    if (!st) return;
    const v = e.target.closest("[data-view]");
    if (v && v.closest(".ws-diff-views")) {
      if (v.dataset.view === view) return;
      view = v.dataset.view === "split" ? "split" : "unified";
      store(VIEW, view);
      for (const [b] of bodies) {
        if (!b.isConnected) bodies.delete(b);
        else paint(b);
      }
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const card = b.closest(".dnote");
    if (act === "unfold") {
      st.open.add(Number(b.dataset.at));
      paint(body);
    } else if (act === "add-note") {
      st.adding = b.dataset.at;
      st.editing = "";
      st.focus = true;
      paint(body);
    } else if (act === "cancel-note") {
      st.adding = "";
      st.editing = "";
      paint(body);
    } else if (act === "save-note") {
      saveNote(body, st, card);
    } else if (act === "edit-note") {
      st.editing = card.dataset.note;
      st.adding = "";
      st.focus = true;
      paint(body);
    } else if (act === "remove-note") {
      setNotes(st.key, notesOf(st.key).filter((n) => n.id !== card.dataset.note));
      paint(body);
      paintList();
    } else if (act === "send-notes") {
      const list = notesOf(st.key).map((n) => ({ ...n, key: st.key, path: st.leaf.path, staged: Boolean(st.leaf.staged) }));
      sendTo(st.leaf.machine, st.leaf.root, list, () => dropSent(list));
    }
  }

  function saveNote(body, st, card) {
    const text = card.querySelector("textarea").value.trim();
    if (!text) {
      card.querySelector("textarea").focus();
      return;
    }
    const list = notesOf(st.key);
    if (card.dataset.note) {
      setNotes(st.key, list.map((n) => (n.id === card.dataset.note ? { ...n, text } : n)));
      st.editing = "";
    } else {
      const [side, num] = st.adding.split(":");
      const line = lineAt(st, st.adding);
      list.push({ id: Math.random().toString(36).slice(2, 10), side, line: Number(num), code: line?.t ?? "", text, at: Date.now() });
      setNotes(st.key, list);
      st.adding = "";
    }
    paint(body);
    paintList();
  }

  function onDiffKey(e) {
    if (!e.target.matches(".dnote-box")) return;
    const body = e.target.closest(".ws-pane-body");
    const st = body && bodies.get(body);
    if (!st) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveNote(body, st, e.target.closest(".dnote"));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      st.adding = "";
      st.editing = "";
      paint(body);
    }
  }

  function init(context) {
    ctx = context;
    paintList();
    $("chg-list").addEventListener("click", (e) => {
      const row = e.target.closest("[data-path]");
      if (row && place) ctx.openDiff({ machine: place.machine, root: place.path, path: row.dataset.path, staged: row.dataset.staged === "true" });
    });
    $("chg-refresh").addEventListener("click", () => load());
    $("chg-draft").addEventListener("click", draft);
    $("chg-message").addEventListener("input", paintCommit);
    $("chg-message").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    });
    $("chg-commit").addEventListener("submit", (e) => {
      e.preventDefault();
      commit();
    });
    $("chg-send-all").addEventListener("click", () => {
      if (!place) return;
      const list = notesIn(place.machine, place.path);
      sendTo(place.machine, place.path, list, () => dropSent(list));
    });
    document.getElementById("panes").addEventListener("click", onDiffClick);
    document.getElementById("panes").addEventListener("keydown", onDiffKey);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && (active || following)) load();
      poll();
    });
  }

  window.YardbellChanges = { init, show, follow, watch, place: setPlace, fillDiff, refresh: load, compose };
})();
