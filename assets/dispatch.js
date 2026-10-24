const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
const form = $("dispatch-form");
const log = $("dispatch-log");
const narrow = window.matchMedia("(max-width: 900px)");
let current = new URLSearchParams(location.search).get("c");
let conversations = [];
let busy = false;

const INTRO = `<div class="empty dispatch-intro" id="dispatch-intro">
  <p>Describe a task. Dispatch finds the machines that have the repository, picks the one with the most room, and starts an agent there with your task.</p>
  <p class="help">Runs Claude Code on this machine with Yardbell's own tools only. It can start, read and answer sessions, but cannot edit files itself.</p>
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

function markdown(text) {
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
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

function show(event) {
  switch (event.role) {
    case "user":
      add(`<p class="msg user">${esc(event.text)}</p>`);
      break;
    case "assistant":
      add(`<p class="msg">${markdown(event.text)}</p>`);
      break;
    case "error":
      add(`<p class="msg error">${esc(event.text)}</p>`);
      break;
    case "tool":
      add(`<details class="tool running" data-tool="${esc(event.name)}"><summary><span class="mark"></span>${esc(LABELS[event.name] || event.name)}${target(event.input)}</summary></details>`);
      break;
    case "tool_result": {
      const open = [...log.querySelectorAll(".tool.running")].find((t) => t.dataset.tool === event.name);
      const box = open || add(`<details class="tool"><summary><span class="mark"></span>${esc(LABELS[event.name] || event.name)}</summary></details>`);
      box.classList.remove("running");
      box.classList.add(event.is_error ? "bad" : "ok");
      box.insertAdjacentHTML("beforeend", `<pre>${esc(event.text)}</pre>`);
      if (event.name === "start_session" && !event.is_error) {
        const link = terminalLink(event.text);
        if (link) box.insertAdjacentHTML("afterend", `<div class="tool ok">${link}</div>`);
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
  $("dispatch-status").textContent = on ? "Working…" : "";
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
  if (!id) {
    log.innerHTML = INTRO;
    form.text.focus();
    return;
  }
  try {
    const convo = await api("GET", `/dispatch/conversations/${encodeURIComponent(id)}`);
    if (current !== id) return;
    convo.events.forEach(show);
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
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = form.text.value.trim();
  if (!text || busy) return;
  form.text.value = "";
  ask(text);
});

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

if (narrow.matches) $("convos").open = false;
loadList()
  .then(() => open(current && conversations.some((c) => c.id === current) ? current : null))
  .catch((err) => toast(err.message));
