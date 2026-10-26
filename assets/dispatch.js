const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
const form = $("dispatch-form");
const log = $("dispatch-log");
const narrow = window.matchMedia("(max-width: 900px)");
let current = new URLSearchParams(location.search).get("c");
let conversations = [];
let busy = false;
let shownEvents = 0;
let tracked = [];
let savedTasks = [];

let editingTask = null;

const SESSION_WORDS = {
  blocked: "is waiting for you",
  idle: "stopped: finished, or waiting for the next step",
  ended: "ended",
};

const INTRO = `<div class="dispatch-intro" id="dispatch-intro">
  <h2>What should your agents work on?</h2>
  <p>Describe a task in plain words. Dispatch finds the machine that has the repository and the most room, and starts an agent there.</p>
  <p class="help">Dispatch runs Claude Code on this machine with Yardbell's own tools. It can start, read and answer sessions, but never edits files itself.</p>
</div>`;

const LABELS = {
  list_machines: "Checked machines",
  list_sessions: "Checked sessions",
  list_folders: "Looked for the repository",
  start_session: "Started a session",
  read_session: "Read a session",
  send_to_session: "Answered a session",
  stop_session: "Stopped a session",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// The replies are Markdown; this covers what Dispatch writes: paragraphs, headings, lists, tables
// and code blocks. Everything is escaped before any tag is added.
function markdown(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code">${esc(code.join("\n"))}</pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(`<h4 class="md-h">${inline(heading[2])}</h4>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const number = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line);
      const marker = ordered ? number : bullet;
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ""));
        else if (items.length && /^\s+/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} class="md-list">${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !lines[i].trim().startsWith("|") && !lines[i].trim().startsWith("```") && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    if (!para.length) { out.push(`<p>${inline(lines[i++])}</p>`); continue; }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

// Steps in a row share one line of small chips, like an agent's tool calls in a terminal.
function toolGroup() {
  const last = log.lastElementChild;
  return last?.classList.contains("tool-group") ? last : add(`<div class="tool-group"></div>`);
}

function toast(message, kind = "error") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("logged out"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

function ago(stamp) {
  const secs = Math.max(0, (Date.now() - Date.parse(stamp)) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return new Date(stamp).toLocaleDateString();
}

function renderList() {
  $("clear-all").hidden = !conversations.length;
  $("convo-list").innerHTML = conversations.length
    ? conversations.map((c) => `<li class="convo${c.id === current ? " selected" : ""}">
        <a href="/dispatch?c=${esc(c.id)}" data-open="${esc(c.id)}"${c.id === current ? ' aria-current="true"' : ""}>
          <span class="convo-title">${esc(c.title)}</span>
          <span class="convo-meta">${c.busy ? '<span class="dot ok"></span>working' : esc(ago(c.updated))}</span>
        </a>
        <button class="btn quiet danger delete" type="button" data-delete="${esc(c.id)}" aria-label="Delete ${esc(c.title)}" title="Delete">
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button></li>`).join("")
    : '<li><p class="convo-empty">No conversations yet.</p></li>';
}

async function loadList() {
  conversations = await api("GET", "/dispatch/conversations");
  renderList();
}

function scrollDown() {
  const main = document.querySelector(".main");
  main.scrollTo({ top: main.scrollHeight });
  window.scrollTo({ top: document.body.scrollHeight });
}

function add(html) {
  $("dispatch-intro")?.remove();
  log.insertAdjacentHTML("beforeend", html);
  scrollDown();
  return log.lastElementChild;
}

function target(input) {
  const where = [input?.machine, input?.folder || input?.path, input?.branch].filter(Boolean);
  return where.length ? ` · ${esc(where.join(" · "))}` : "";
}

function terminalLink(text) {
  try {
    const started = JSON.parse(text);
    if (!started.machine || !started.name) return "";
    const url = `/term/${encodeURIComponent(started.machine)}/${encodeURIComponent(started.name)}`;
    return `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open ${esc(started.name)}</a>`;
  } catch {
    return "";
  }
}

function termUrl(machine, name) {
  return `/term/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`;
}

function sessionCard(event) {
  const where = `data-machine="${esc(event.machine)}" data-name="${esc(event.name)}"`;
  const options = (event.options || []).map((o) =>
    `<button class="btn${o.key === "1" ? " primary" : ""}" type="button" data-keys="${esc(o.key)}" ${where}>${esc(o.label)}</button>`).join("");
  const review = event.state === "idle"
    ? `<button class="btn" type="button" data-review ${where} data-path="${esc(event.path || "")}">Review branch</button>` : "";
  const open = event.state === "ended" ? "" : `<a class="btn quiet" href="${esc(termUrl(event.machine, event.name))}" target="_blank" rel="noopener">Open</a>`;
  return `<div class="session-card ${esc(event.state)}">
    <p class="session-card-head"><span class="dot ${event.state === "blocked" ? "warn" : event.state === "ended" ? "" : "ok"}"></span><strong>${esc(event.name)}</strong> on ${esc(event.machine)} ${esc(SESSION_WORDS[event.state] || event.state)}</p>
    ${event.screen ? `<pre>${esc(event.screen)}</pre>` : ""}
    <div class="session-card-actions">${options}${review}${open}</div>
  </div>`;
}

function show(event) {
  switch (event.role) {
    case "session":
      add(sessionCard(event));
      break;
    case "user":
      add(`<p class="msg user">${esc(event.text)}</p>`);
      break;
    case "assistant":
      add(`<div class="msg md">${markdown(event.text)}</div>`);
      break;
    case "error":
      add(`<p class="msg error">${esc(event.text)}</p>`);
      break;
    case "tool":
      toolGroup().insertAdjacentHTML("beforeend", `<details class="tool running" data-tool="${esc(event.name)}"><summary><span class="mark"></span>${esc(LABELS[event.name] || event.name)}${target(event.input)}</summary></details>`);
      scrollDown();
      break;
    case "tool_result": {
      const open = [...log.querySelectorAll(".tool.running")].find((t) => t.dataset.tool === event.name);
      if (!open) toolGroup().insertAdjacentHTML("beforeend", `<details class="tool"><summary><span class="mark"></span>${esc(LABELS[event.name] || event.name)}</summary></details>`);
      const box = open || log.lastElementChild.lastElementChild;
      box.classList.remove("running");
      box.classList.add(event.is_error ? "bad" : "ok");
      box.insertAdjacentHTML("beforeend", `<pre>${esc(event.text)}</pre>`);
      if (event.name === "start_session" && !event.is_error) {
        const link = terminalLink(event.text);
        if (link) add(`<div class="started">${link}</div>`);
      }
      scrollDown();
      break;
    }
  }
}

function setBusy(on) {
  busy = on;
  $("dispatch-send").disabled = on;
  $("dispatch-stop").hidden = !on;
  $("dispatch-thinking").hidden = !on;
  if (on) scrollDown();
  if (!on) log.querySelectorAll(".tool.running").forEach((t) => t.classList.remove("running"));
}

function setUrl() {
  history.replaceState(null, "", current ? `/dispatch?c=${encodeURIComponent(current)}` : "/dispatch");
}

async function open(id) {
  current = id;
  setUrl();
  log.innerHTML = "";
  setBusy(false);
  renderList();
  if (narrow.matches) $("convos").open = false;
  tracked = [];
  shownEvents = 0;
  renderTracked();
  if (!id) {
    log.innerHTML = INTRO;
    if (document.hasFocus()) form.text.focus();
    return;
  }
  try {
    const convo = await api("GET", `/dispatch/conversations/${encodeURIComponent(id)}`);
    if (current !== id) return;
    convo.events.forEach(show);
    shownEvents = convo.events.length;
    tracked = convo.sessions || [];
    renderTracked();
    setBusy(convo.busy);
    if (convo.busy) watch(id);
  } catch (err) {
    toast(err.message);
    current = null;
    setUrl();
    log.innerHTML = INTRO;
  }
}

async function watch(id) {
  while (current === id && busy) {
    await new Promise((r) => setTimeout(r, 2000));
    const convo = await api("GET", `/dispatch/conversations/${encodeURIComponent(id)}`).catch(() => null);
    if (!convo || current !== id) return;
    if (!convo.busy) {
      await loadList();
      open(id);
      return;
    }
  }
}

async function ask(text) {
  setBusy(true);
  show({ role: "user", text });
  try {
    const res = await fetch("/dispatch/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation: current, text }),
    });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw new Error(out.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.role === "conversation") {
          current = event.id;
          setUrl();
          loadList().catch(() => {});
        } else {
          show(event);
        }
      }
    }
  } catch (err) {
    show({ role: "error", text: err.message });
  } finally {
    setBusy(false);
    loadList().catch(() => {});
    window.YardbellNav.loadUsage();
    catchUp(false);
  }
}

// Session cards arrive between turns, as the sessions Dispatch started change.
async function catchUp(showNew = true) {
  if (!current || busy) return;
  const id = current;
  const convo = await api("GET", `/dispatch/conversations/${encodeURIComponent(id)}`).catch(() => null);
  if (!convo || current !== id || busy) return;
  if (showNew) convo.events.slice(shownEvents).forEach(show);
  shownEvents = convo.events.length;
  tracked = convo.sessions || [];
  renderTracked();
}

async function renderTracked() {
  const box = $("dispatch-sessions");
  box.hidden = !tracked.length;
  if (!tracked.length) { box.innerHTML = ""; return; }
  const state = await api("GET", "/state").catch(() => null);
  const live = (t) => state?.sessions.find((s) => s.machine === t.machine && s.tmux === t.name && !s.stale);
  box.innerHTML = `<span class="dispatch-sessions-label">Sessions</span>` + tracked.map((t) => {
    const s = live(t);
    const word = !s ? "ended" : s.activity === "blocked" ? "needs you" : s.activity === "active" ? "working" : "idle";
    const tone = !s ? "" : s.activity === "blocked" ? "warn" : s.activity === "active" ? "ok" : "";
    const name = s ? `<a href="${esc(termUrl(t.machine, t.name))}" target="_blank" rel="noopener">${esc(t.name)}</a>` : esc(t.name);
    return `<span class="dispatch-session"><span class="dot ${tone}"></span>${name}<span class="muted">${esc(t.machine)} · ${word}</span></span>`;
  }).join("");
}

function renderTasks() {
  const shown = savedTasks.filter((t) => !t.hidden);
  $("task-restore").hidden = !savedTasks.some((t) => t.hidden);
  $("task-list").innerHTML = shown.length
    ? shown.map((t) => `<li class="convo task">
        <button type="button" class="task-run" data-run="${esc(t.name)}" title="${esc(t.text)}">
          <span class="convo-title">${esc(t.name)}</span>
          <span class="convo-meta">${esc(t.text)}</span>
        </button>
        <button class="btn quiet delete" type="button" data-edit-task="${esc(t.name)}" aria-label="Edit ${esc(t.name)}" title="Edit">
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4z"/></svg>
        </button>
        <button class="btn quiet danger delete" type="button" data-forget-task="${esc(t.name)}" aria-label="Delete ${esc(t.name)}" title="Delete">
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button></li>`).join("")
    : '<li><p class="convo-empty">No tasks yet.</p></li>';
}

async function loadTasks() {
  savedTasks = await api("GET", "/dispatch/tasks").catch(() => []);
  renderTasks();
}

function editTask(task, text = "") {
  editingTask = task?.name || null;
  const f = $("task-form");
  f.hidden = false;
  f.name.value = task?.name || "";
  f.text.value = task?.text || text;
  $("tasks").open = true;
  f.name.focus();
}

function closeTaskForm() {
  editingTask = null;
  $("task-form").hidden = true;
}

$("task-new").addEventListener("click", (e) => {
  e.preventDefault();
  editTask(null);
});

$("task-cancel").addEventListener("click", closeTaskForm);

$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    savedTasks = await api("POST", "/dispatch/tasks", { name: f.name.value, text: f.text.value, replacing: editingTask });
    toast(`Saved "${f.name.value.trim()}"`, "ok");
    closeTaskForm();
    renderTasks();
  } catch (err) {
    toast(err.message);
  }
});

$("task-list").addEventListener("click", async (e) => {
  const run = e.target.closest("[data-run]");
  if (run) {
    const task = savedTasks.find((t) => t.name === run.dataset.run);
    if (!task) return;
    if (busy) { toast("Dispatch is still working on the last message."); return; }
    if (narrow.matches) $("tasks").open = false;
    ask(task.text);
    return;
  }
  const edit = e.target.closest("[data-edit-task]");
  if (edit) {
    editTask(savedTasks.find((t) => t.name === edit.dataset.editTask));
    return;
  }
  const forget = e.target.closest("[data-forget-task]");
  if (forget) {
    const builtin = savedTasks.find((t) => t.name === forget.dataset.forgetTask)?.builtin;
    const note = builtin ? "It is a default task, so Restore default tasks brings it back." : "Conversations it started are kept.";
    if (!(await Nav.confirm(`Delete the task "${forget.dataset.forgetTask}"?`, note, { confirm: "Delete", danger: true }))) return;
    savedTasks = await api("POST", "/dispatch/tasks/delete", { name: forget.dataset.forgetTask }).catch((err) => { toast(err.message); return savedTasks; });
    renderTasks();
  }
});

$("task-restore").addEventListener("click", async () => {
  savedTasks = await api("POST", "/dispatch/tasks/restore", {}).catch((err) => { toast(err.message); return savedTasks; });
  renderTasks();
});

$("save-as-task").addEventListener("click", () => {
  const text = form.text.value.trim();
  if (!text) { toast("Type the task first, then save it."); form.text.focus(); return; }
  editTask(null, text);
});

log.addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-keys]");
  if (pick) {
    const card = pick.closest(".session-card");
    card.querySelectorAll("[data-keys]").forEach((b) => { b.disabled = true; });
    try {
      await api("POST", `/sessions/${encodeURIComponent(pick.dataset.machine)}/${encodeURIComponent(pick.dataset.name)}/keys`, { keys: pick.dataset.keys });
      pick.classList.add("picked");
      toast(`Answered "${pick.textContent}"`, "ok");
    } catch (err) {
      card.querySelectorAll("[data-keys]").forEach((b) => { b.disabled = false; });
      toast(err.message);
    }
    return;
  }
  const review = e.target.closest("[data-review]");
  if (review) {
    if (busy) { toast("Dispatch is still working on the last message."); return; }
    const { machine, name, path } = review.dataset;
    ask(`Review the branch that session ${name} on ${machine} worked on${path ? `, in ${path}` : ""}: start a review session as instructed and tell me what it finds.`);
  }
});

setInterval(() => catchUp(true), 5000);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = form.text.value.trim();
  if (!text || busy) return;
  form.text.value = "";
  fitCompose();
  ask(text);
});

function fitCompose() {
  form.text.style.height = "auto";
  form.text.style.height = `${form.text.scrollHeight}px`;
}

form.text.addEventListener("input", fitCompose);

form.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

$("dispatch-stop").addEventListener("click", () => {
  if (!current) return;
  api("POST", `/dispatch/conversations/${encodeURIComponent(current)}/stop`, {}).catch((err) => toast(err.message));
});

$("new-chat").addEventListener("click", () => {
  if (busy) { toast("This conversation is still working. Stop it or wait, then start a new one."); return; }
  open(null);
});

$("convo-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-delete]");
  if (del) {
    const c = conversations.find((x) => x.id === del.dataset.delete);
    if (!c) return;
    if (!(await Nav.confirm("Delete this conversation?", c.title, { confirm: "Delete", danger: true }))) return;
    try {
      await api("POST", `/dispatch/conversations/${encodeURIComponent(c.id)}/delete`, {});
      await loadList();
      if (c.id === current) open(null);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const link = e.target.closest("[data-open]");
  if (!link) return;
  e.preventDefault();
  if (busy && link.dataset.open !== current) {
    toast("This conversation is still working. Stop it or wait, then switch.");
    return;
  }
  open(link.dataset.open);
});

$("clear-all").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!(await Nav.confirm("Delete every conversation?", "Conversations that are still working are kept. Sessions they started keep running.", { confirm: "Delete all", danger: true }))) return;
  try {
    const { kept } = await api("POST", "/dispatch/clear", {});
    await loadList();
    if (!conversations.some((c) => c.id === current)) open(null);
    if (kept) toast(`${kept} conversation${kept === 1 ? " is" : "s are"} still working and ${kept === 1 ? "was" : "were"} kept.`, "ok");
  } catch (err) {
    toast(err.message);
  }
});

const WIDTH_KEY = "yardbell.dispatch.width";
const SIDE_WIDTH = { min: 220, normal: 260, max: 560 };

function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function setSideWidth(px, save) {
  const width = Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, px)));
  document.querySelector(".dispatch").style.setProperty("--dispatch-side", `${width}px`);
  $("dispatch-resize").setAttribute("aria-valuenow", width);
  if (save) remember(WIDTH_KEY, width === SIDE_WIDTH.normal ? null : String(width));
}

const resizer = $("dispatch-resize");
resizer.setAttribute("aria-valuemin", SIDE_WIDTH.min);
resizer.setAttribute("aria-valuemax", SIDE_WIDTH.max);
resizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const start = e.clientX;
  const from = $("dispatch-side").getBoundingClientRect().width;
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  const move = (ev) => setSideWidth(from + ev.clientX - start, false);
  const done = () => {
    resizer.removeEventListener("pointermove", move);
    document.body.classList.remove("resizing");
    setSideWidth($("dispatch-side").getBoundingClientRect().width, true);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", done, { once: true });
  resizer.addEventListener("pointercancel", done, { once: true });
});
resizer.addEventListener("dblclick", () => setSideWidth(SIDE_WIDTH.normal, true));
resizer.addEventListener("keydown", (e) => {
  const step = { ArrowLeft: -20, ArrowRight: 20 }[e.key];
  if (!step) return;
  e.preventDefault();
  setSideWidth($("dispatch-side").getBoundingClientRect().width + step, true);
});

setSideWidth(Number(remembered(WIDTH_KEY)) || SIDE_WIDTH.normal, false);

const FOLDED_KEY = "yardbell.dispatch.folded";
const folded = new Set((remembered(FOLDED_KEY) || "").split(",").filter(Boolean));
for (const id of ["convos", "tasks"]) {
  $(id).open = !narrow.matches && !folded.has(id);
  $(id).addEventListener("toggle", () => {
    if (narrow.matches) return;
    if ($(id).open) folded.delete(id);
    else folded.add(id);
    remember(FOLDED_KEY, folded.size ? [...folded].join(",") : null);
  });
}
loadTasks();
loadList()
  .then(() => open(current && conversations.some((c) => c.id === current) ? current : null))
  .catch((err) => toast(err.message));

// Inside the Workspace, Dispatch opens sessions as Workspace panes and other pages in the whole window.
if (window.top !== window.self) {
  const tell = (message) => window.parent.postMessage({ yardbell: "dispatch", ...message }, location.origin);
  $("hide-panel").addEventListener("click", () => tell({ action: "hide" }));
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[href]");
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname === "/dispatch") return;
    e.preventDefault();
    const [first, machine, name] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (first === "term" && machine && name) tell({ action: "open", key: `${machine}/${name}` });
    else window.top.location.href = url.href;
  });
}
