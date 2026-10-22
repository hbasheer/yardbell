const $ = (id) => document.getElementById(id);
const form = $("relay-form");
const log = $("relay-log");
let busy = false;

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

function scrollDown() {
  window.scrollTo({ top: document.body.scrollHeight });
}

function add(html) {
  $("relay-intro")?.remove();
  log.insertAdjacentHTML("beforeend", html);
  $("relay-new").hidden = false;
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
  $("relay-send").disabled = on;
  $("relay-stop").hidden = !on;
  $("relay-new").disabled = on;
  $("relay-status").textContent = on ? "Working…" : "";
  if (!on) log.querySelectorAll(".tool.running").forEach((t) => t.classList.remove("running"));
}

async function load() {
  const res = await fetch("/relay/history", { headers: { Accept: "application/json" } });
  if (res.status === 401) { location.href = "/login"; return; }
  const history = await res.json();
  history.events.forEach(show);
  setBusy(history.busy);
  if (history.busy) poll();
}

async function poll() {
  while (busy) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch("/relay/history", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const history = await res.json();
    if (!history.busy) location.reload();
  }
}

async function ask(text) {
  setBusy(true);
  show({ role: "user", text });
  try {
    const res = await fetch("/relay/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
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
      for (const line of lines) if (line.trim()) show(JSON.parse(line));
    }
  } catch (err) {
    show({ role: "error", text: err.message });
  } finally {
    setBusy(false);
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

$("relay-stop").addEventListener("click", () => {
  fetch("/relay/stop", { method: "POST" }).catch((err) => toast(err.message));
});

$("relay-new").addEventListener("click", async () => {
  const res = await fetch("/relay/new", { method: "POST" });
  if (!res.ok) {
    const out = await res.json().catch(() => ({}));
    toast(out.error || "Couldn't start a new chat");
    return;
  }
  location.reload();
});

load().catch((err) => toast(err.message));
