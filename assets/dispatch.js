import { html, nothing, render } from "/vendor/lit-html/lit-html.js";
import * as steps from "/dispatch-review.js";
import * as pulls from "/dispatch-pull.js";
import * as scans from "/dispatch-scan.js";
import * as groups from "/dispatch-group.js";
import { openHistory, proposedPrompt } from "/dispatch-tasks.js";
import { repeat } from "/vendor/lit-html/directives/repeat.js";
import { composer } from "/composer.js";

const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
const form = $("dispatch-form");
const log = $("dispatch-log");
const narrow = window.matchMedia("(max-width: 900px)");
let current = new URLSearchParams(location.search).get("c");
let conversations = [];
let busy = false;
let events = [];
let shownEvents = 0;
let shownUpdated = "";
let tracked = [];
let lastState = null;
let savedTasks = [];
let answers = new Map();
const screens = new Set();
let view = 0;
let trigger = null;
let triggerInfo = null;
let backend = "claude";
let runsOn = null;

const AGENTS = { claude: "Claude Code", codex: "Codex" };
const CLAUDE_MODELS = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };

let editingTask = null;

const SESSION_STATES = {
  blocked: { badge: "blocked", word: "Waiting for you", hint: "The session is asking something. Pick an answer below or open it." },
  idle: { badge: "", word: "Stopped", hint: "Finished, or waiting for the next step." },
  ended: { badge: "", word: "Ended", hint: "The session is gone." },
};

const intro = () => html`<div class="dispatch-intro">
  <h2>What should your agents work on?</h2>
  <p>Describe a task in plain words. Dispatch finds the machine that has the repository and the most room, and offers to start an agent there. You approve each step before it runs, unless Settings lets Dispatch go ahead on its own.</p>
  <p class="help">Dispatch runs ${runsOnText(backend)} on this machine with Yardbell's own tools. It can start, read and answer sessions, but never edits files itself.</p>
  <p class="help">Type <kbd>/</kbd> to use one of your tasks, or <kbd>@</kbd> to name a machine, session or folder.</p>
</div>`;

const LABELS = {
  list_machines: "Checked machines",
  list_sessions: "Checked sessions",
  list_folders: "Looked for the repository",
  read_session: "Read a session",
};

const ICONS = {
  edit: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4z"/></svg>`,
  close: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  trigger: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.5" r="5"/><path d="M8 6v2.5l1.8 1.2M6.5 2h3"/></svg>`,
  pipeline: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="12.5" cy="8" r="1.5"/><path d="M5 8h1.5M9.5 8H11"/></svg>`,
};

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(html`<code>${m[1]}</code>`);
    else if (m[2] !== undefined) out.push(html`<strong>${inline(m[2])}</strong>`);
    else out.push(html`<a href=${m[4]} target="_blank" rel="noopener">${inline(m[3])}</a>`);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// The replies are Markdown; this covers what Dispatch writes: paragraphs, headings, lists, tables
// and code blocks.
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
      out.push(html`<pre class="md-code">${code.join("\n")}</pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(html`<h4 class="md-h">${inline(heading[2])}</h4>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(html`<div class="md-table"><table><thead><tr>${head.map((c) => html`<th>${inline(c)}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${inline(c)}</td>`)}</tr>`)}</tbody></table></div>`);
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
      const list = items.map((it) => html`<li>${inline(it)}</li>`);
      out.push(ordered ? html`<ol class="md-list">${list}</ol>` : html`<ul class="md-list">${list}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !lines[i].trim().startsWith("|") && !lines[i].trim().startsWith("```") && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    if (!para.length) { out.push(html`<p>${inline(lines[i++])}</p>`); continue; }
    out.push(html`<p>${para.map((l, n) => (n ? [html`<br>`, inline(l)] : inline(l)))}</p>`);
  }
  return out;
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

function convoItem(c) {
  const selected = c.id === current;
  return html`<li class="convo ${selected ? "selected" : ""}">
    <a href="/dispatch?c=${c.id}" aria-current=${selected ? "true" : nothing} @click=${(e) => switchTo(e, c)}>
      <span class="convo-title">${c.title}</span>
      <span class="convo-meta">${pipelined.has(c.id) ? html`<span class="convo-trigger" title="A pipeline run" aria-label="A pipeline run">${ICONS.pipeline}</span>` : nothing}${c.trigger ? html`<span class="convo-trigger" title="Started by the trigger ${c.trigger}" aria-label="Started by a trigger">${ICONS.trigger}</span>` : nothing}${c.busy ? html`<span class="dot ok"></span>working` : c.waiting ? html`<span class="dot warn"></span>${c.waiting} waiting for you` : ago(c.updated)}</span>
    </a>
    <button class="btn quiet danger delete" type="button" aria-label="Delete ${c.title}" title="Delete" @click=${() => deleteConvo(c)}>${ICONS.close}</button>
  </li>`;
}

function renderList() {
  $("clear-all").hidden = !conversations.length;
  countTab("convos", conversations.length);
  const open = conversations.find((c) => c.id === current);
  render(html`${open?.trigger ? html`<span class="convo-trigger" title="Started by the trigger ${open.trigger}" aria-label="Started by a trigger">${ICONS.trigger}</span>` : nothing}${open?.title || "New conversation"}`, $("chat-title"));
  render(conversations.length
    ? repeat(conversations, (c) => c.id, convoItem)
    : html`<li><p class="convo-empty">No conversations yet.</p></li>`, $("convo-list"));
}

function switchTo(e, c) {
  e.preventDefault();
  if (busy && c.id !== current) {
    toast("This conversation is still working. Stop it or wait, then switch.");
    return;
  }
  open(c.id);
}

async function deleteConvo(c) {
  if (!(await Nav.confirm("Delete this conversation?", c.title, { confirm: "Delete", danger: true }))) return;
  try {
    await api("POST", `/dispatch/conversations/${encodeURIComponent(c.id)}/delete`, {});
    await loadList();
    if (c.id === current) open(null);
  } catch (err) {
    toast(err.message);
  }
}

// Conversations a pipeline run keeps, one per run, get its mark in the list.
let pipelined = new Set();

async function loadList() {
  const [list, pipeline] = await Promise.all([
    api("GET", "/dispatch/conversations"),
    api("GET", "/api/runs").catch(() => ({ runs: [] })),
  ]);
  conversations = list;
  pipelined = new Set(pipeline.runs.map((r) => r.conversation).filter(Boolean));
  compose.keep(conversations.map((c) => c.id));
  renderList();
}

function scrollDown() {
  const s = scroller();
  s.scrollTo({ top: s.scrollHeight });
  window.scrollTo({ top: document.body.scrollHeight });
}

function target(input) {
  const where = [input?.machine, input?.folder || input?.path, input?.branch].filter(Boolean);
  return where.length ? ` · ${where.join(" · ")}` : "";
}

function short(path) {
  return String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
}

function folderOf(path) {
  return String(path ?? "").replace(/\/+$/, "").split("/").pop() || path;
}

function termUrl(machine, name) {
  return `/term/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`;
}

// A question with a preview draws the preview box beside the choices. Conversations saved before
// the server cut labels there still carry the box, so it is cut here too.
function optionLabel(label) {
  return String(label).split(/ {3}|[─-╿]/)[0].trim() || label;
}

// Rules drawn across the terminal carry no text and are the widest lines on screen, and the
// agent's own left margin only pushes every line right.
function readable(screen) {
  const lines = String(screen).split("\n")
    .filter((l) => !/^[\s─-╿]+$/.test(l) || !l.trim())
    .map((l) => l.replace(/\s*[│┃]?\s*$/, ""))
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n").replace(/^\n+|\n+$/g, "");
}

// The end of the screen is where an agent says what it did or asks, so a card shows only that
// until it is opened.
const SCREEN_TAIL = 4;

function screen(e, index) {
  const lines = readable(e.screen).split("\n");
  const key = `${view}:${index}`;
  const open = screens.has(key);
  const long = lines.length > SCREEN_TAIL;
  const toggle = () => { open ? screens.delete(key) : screens.add(key); draw(); };
  return html`${long ? html`<button class="link-btn session-screen-more" type="button" aria-expanded=${open ? "true" : "false"} @click=${toggle}>${open ? "Show the end only" : `Show all ${lines.length} lines`}</button>` : nothing}
    <pre class="session-screen">${(long && !open ? lines.slice(-SCREEN_TAIL) : lines).join("\n")}</pre>`;
}

// Tool calls in a row share one line of small chips, like an agent's tool calls in a terminal,
// and each result lands on the first chip of its name still waiting for one. Steps that change
// something are cards of their own, also the ones old conversations kept as plain tool calls.
function blocks(list) {
  const out = [];
  const waiting = [];
  const legacy = [];
  let group = null;
  list.forEach((e, i) => {
    if ((e.role === "tool" || e.role === "tool_result") && steps.CHANGING.has(e.name)) {
      let step = e.role === "tool_result" ? legacy.find((s) => s.tool === e.name && !s.result) : null;
      if (!step) {
        step = steps.legacyStep(e.name, e.role === "tool" ? e.input : null);
        legacy.push(step);
        out.push({ kind: "action", key: i, event: step });
      }
      if (e.role === "tool_result") steps.legacyResult(step, e);
      group = null;
      return;
    }
    if (e.role === "tool" || e.role === "tool_result") {
      let chip = e.role === "tool_result" ? waiting.find((c) => c.name === e.name && !c.result) : null;
      if (!chip) {
        if (!group) out.push(group = { kind: "tools", key: i, chips: [] });
        chip = { name: e.name, input: e.role === "tool" ? e.input : null, result: null };
        group.chips.push(chip);
        waiting.push(chip);
      }
      if (e.role === "tool_result") chip.result = e;
      return;
    }
    group = null;
    // A group's children are steps of their own, drawn inside the group's card.
    if (e.role === "action" && e.group) return;
    out.push({ kind: e.role, key: i, event: e });
  });
  return out;
}

function chip(c) {
  const tone = c.result ? (c.result.is_error ? "bad" : "ok") : busy ? "running" : "";
  return html`<details class="tool ${tone}"><summary><span class="mark"></span>${LABELS[c.name] || c.name}${target(c.input)}</summary>${c.result ? html`<pre>${c.result.text}</pre>` : nothing}</details>`;
}

function sessionCard(e, index) {
  const state = e.answer
    ? { badge: "", word: "Answered", hint: "You answered its question here." }
    : SESSION_STATES[e.state] || { badge: "", word: e.state, hint: "" };
  const answer = e.answer || answers.get(`${view}:${index}`);
  const options = (e.options || []).map((o) => {
    const label = optionLabel(o.label);
    return html`<button class="btn ${o.key === "1" ? "primary" : ""} ${answer?.key === o.key ? "picked" : ""}" type="button" title=${label} ?disabled=${Boolean(answer)} @click=${() => pick(e, index, o.key, label)}><span class="btn-label">${label}</span></button>`;
  });
  const reviewable = (e.state === "idle" || e.state === "ended") && !e.review;
  return html`<div class="session-card ${e.answer ? "answered" : e.state}">
    <header class="session-card-head">
      <div class="session-card-id">
        <strong>${e.name}</strong>
        <span class="session-card-where" title=${e.path ? short(e.path) : nothing}>on ${e.machine}${e.path ? html` · <code>${folderOf(e.path)}</code>` : nothing}</span>
      </div>
      <span class="badge ${state.badge}" title=${state.hint}>${state.word}</span>
    </header>
    ${e.screen ? html`<div class="session-screen-wrap">${screen(e, index)}</div>` : nothing}
    <div class="session-card-actions">
      ${options}
      ${reviewable ? html`<button class="btn" type="button" title="Start a reviewer in the same folder that runs the tests and changes nothing" @click=${() => requestReview(index)}>Review branch</button>` : nothing}
      ${reviewable && e.path ? html`<button class="btn scan-btn" type="button" aria-haspopup="menu" aria-expanded="false" title="Start a scanner in the same folder that reads all of its code and changes nothing" @click=${(ev) => scans.toggleMenu(ev.currentTarget, (kind) => requestScan({ card: index, kind }))}>Scan<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg></button>` : nothing}
      <button class="btn quiet" type="button" title="When it worked, waited and idled, and the tools and tests it ran" @click=${() => insights(e.machine, e.name, true)}>Insights</button>
      ${e.state === "ended" ? nothing : html`<a class="btn quiet" href=${termUrl(e.machine, e.name)} target="_blank" rel="noopener">Open</a>`}
      ${e.answer ? html`<span class="session-card-answer">You answered ${optionLabel(e.answer.label)}${e.answer.at ? ` at ${new Date(e.answer.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>` : nothing}
    </div>
  </div>`;
}

function block(b) {
  switch (b.kind) {
    case "tools":
      return html`<div class="tool-group">${b.chips.map(chip)}</div>`;
    case "action":
      return steps.stepCard(b.event);
    case "review":
      return steps.reviewCard(b.event, b.key);
    case "session":
      return sessionCard(b.event, b.key);
    case "pull":
      return pulls.pullCard(b.event, b.key);
    case "group":
      return groups.groupCard(b.event);
    case "results":
      return groups.resultsCard(b.event, b.key);
    case "user":
      if (b.event.by === "yardbell") return html`<div class="msg user by-yardbell"><span class="msg-by">Sent by Yardbell once the results were in</span>${b.event.text}</div>`;
      if (b.event.improve) return html`<div class="msg user marked"><span class="msg-by">Suggest a better prompt for ${b.event.improve.name} on ${b.event.improve.machine}</span><details class="msg-more"><summary>What Dispatch was asked</summary>${b.event.text}</details></div>`;
      if (b.event.task) return html`<div class="msg user marked"><span class="msg-by">Task ${b.event.task.name} · version ${b.event.task.version}</span>${b.event.text}</div>`;
      return html`<p class="msg user">${b.event.text}</p>`;
    case "assistant":
      return html`<div class="msg md">${markdown(b.event.text)}${promptActions(b)}</div>`;
    case "error":
      return html`<p class="msg error">${b.event.text}</p>`;
    default:
      return nothing;
  }
}

// The server's wall clock, as written in the stamp, so a trigger's time reads as its schedule does.
function serverTime(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stamp || "");
  if (!m) return "";
  const day = new Date(`${m[1]}T12:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${day}, ${m[2]}`;
}

function triggerHead() {
  if (!trigger) return nothing;
  const known = triggerInfo?.triggers.find((v) => v.trigger.name === trigger.name);
  const on = known?.trigger.enabled;
  const late = trigger.slot && Date.parse(trigger.at) - Date.parse(trigger.slot) >= 120000;
  return html`<div class="trigger-head ${known && !on ? "off" : ""}">
    ${ICONS.trigger}
    <div class="trigger-head-text">
      <strong>Started by the trigger ${trigger.name}</strong>
      <span>${trigger.task ? html`Task ${trigger.task}${trigger.version ? `, version ${trigger.version}` : ""} · ` : nothing}${trigger.what} · ${serverTime(trigger.at)}${late ? `, late for ${serverTime(trigger.slot).split(", ")[1]}` : ""}${known && !on ? " · The trigger is off" : ""}${triggerInfo && !known ? " · The trigger was deleted" : ""}</span>
    </div>
    <div class="trigger-head-actions">
      ${trigger.url ? html`<a class="btn quiet" href=${trigger.url} target="_blank" rel="noopener">Open ticket</a>` : nothing}
      <a class="btn quiet" href="/settings#triggers">Triggers</a>
      ${known ? html`<button class="btn" type="button" @click=${() => setTrigger(!on)}>${on ? "Turn off" : "Turn on"}</button>` : nothing}
    </div>
  </div>`;
}

async function loadTriggerInfo() {
  triggerInfo = await api("GET", "/api/triggers").catch(() => triggerInfo);
  draw();
}

async function setTrigger(enabled) {
  try {
    triggerInfo = await api("POST", "/api/triggers/enable", { name: trigger.name, enabled });
    toast(enabled ? `The trigger ${trigger.name} is on.` : `The trigger ${trigger.name} is off. It starts nothing until you turn it on here or in Settings.`, "ok");
  } catch (err) {
    toast(err.message);
  }
  draw();
}

function agentOf(name) {
  const agent = runsOn?.agents?.[name];
  const model = agent?.model || "";
  return { label: agent?.label || AGENTS[name] || name, model: CLAUDE_MODELS[model] || model || "default model" };
}

function runsOnText(name) {
  const { label, model } = agentOf(name);
  return `${label} (${model})`;
}

// A conversation keeps the agent it started on, since one agent cannot pick up the other's.
function backendNote() {
  if (!current || !runsOn || backend === runsOn.runs_on) return nothing;
  return html`<p class="backend-note" role="note">This conversation runs on ${runsOnText(backend)}, so it carries on there. New conversations start on ${runsOnText(runsOn.runs_on)}. To switch, start a new conversation.</p>`;
}

// The model is read again at every turn, so this is what the next reply runs on.
function renderRunsOn() {
  const chip = $("runs-on");
  chip.hidden = !runsOn;
  if (!runsOn) return;
  const { label, model } = agentOf(backend);
  chip.textContent = `${label} · ${model}`;
  chip.title = `${current ? "This conversation runs" : "New conversations run"} on ${label} with ${model === "default model" ? "its default model" : model}. Change it in Settings.`;
}

function draw() {
  renderRunsOn();
  render(!current && !events.length
    ? intro()
    : html`${triggerHead()}${backendNote()}${repeat(blocks(events), (b) => `${view}:${b.key}`, block)}${steps.waitingBar(events)}`, log);
}

async function loadRunsOn() {
  runsOn = await api("GET", "/dispatch/runs-on").catch(() => runsOn);
  if (!current) backend = runsOn?.runs_on || backend;
  draw();
}

function show(event) {
  events.push(event);
  draw();
  scrollDown();
}

async function pick(e, index, key, label) {
  const local = `${view}:${index}`;
  answers.set(local, { key: null });
  draw();
  try {
    events[index] = await api("POST", `/dispatch/conversations/${encodeURIComponent(current)}/answers`, { card: index, key });
    toast(`Answered "${label}"`, "ok");
  } catch (err) {
    toast(err.message);
    if (/already/.test(err.message)) catchUp();
  }
  answers.delete(local);
  draw();
}

async function requestReview(index) {
  try {
    const step = await api("POST", `/dispatch/conversations/${encodeURIComponent(current)}/reviews`, { card: index });
    events.push(step);
    shownEvents = Math.max(shownEvents, events.length);
    draw();
    scrollDown();
  } catch (err) {
    toast(err.message);
  }
}

// A scan from a session card goes into this conversation; one of a folder picked in the composer
// goes into the open conversation, or a new one named after it.
async function requestScan(body) {
  try {
    const { conversation, step } = await api("POST", "/dispatch/scans", { conversation: current, ...body });
    if (conversation !== current) {
      await loadList();
      await open(conversation);
      return;
    }
    events.push(step);
    shownEvents = Math.max(shownEvents, events.length);
    draw();
    scrollDown();
  } catch (err) {
    if (body.card !== undefined) toast(err.message);
    else throw err;
  }
}

$("insert-scan").addEventListener("click", async () => {
  const state = lastState || (await loadState());
  scans.openDialog({ state, submit: (body) => requestScan(body) });
});

function setBusy(on) {
  busy = on;
  if (document.activeElement === $(on ? "dispatch-send" : "dispatch-stop")) form.text.focus();
  $("dispatch-send").hidden = on;
  $("dispatch-stop").hidden = !on;
  $("dispatch-thinking").hidden = !on;
  draw();
  if (on) scrollDown();
}

function setUrl() {
  history.replaceState(null, "", current ? `/dispatch?c=${encodeURIComponent(current)}` : "/dispatch");
}

async function open(id) {
  current = id;
  view++;
  setUrl();
  events = [];
  trigger = null;
  backend = runsOn?.runs_on || "claude";
  loadRunsOn();
  answers = new Map();
  screens.clear();
  steps.reset();
  groups.reset();
  setBusy(false);
  renderList();
  showTab("chat");
  tracked = [];
  shownEvents = 0;
  shownUpdated = "";
  renderTracked();
  compose.show(id);
  if (!id) {
    if (document.hasFocus()) form.text.focus();
    return;
  }
  try {
    const convo = await api("GET", `/dispatch/conversations/${encodeURIComponent(id)}`);
    if (current !== id) return;
    events = convo.events.slice();
    shownEvents = convo.events.length;
    shownUpdated = convo.updated;
    backend = convo.backend || "claude";
    trigger = convo.trigger || null;
    if (trigger) loadTriggerInfo();
    tracked = convo.sessions || [];
    renderTracked();
    setBusy(convo.busy);
    scrollDown();
    if (convo.busy) watch(id);
  } catch (err) {
    toast(err.message);
    current = null;
    setUrl();
    events = [];
    draw();
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
    if (convo.updated !== shownUpdated) {
      const grew = convo.events.length > shownEvents;
      events = convo.events.slice();
      shownEvents = convo.events.length;
      shownUpdated = convo.updated;
      draw();
      if (grew) scrollDown();
    }
  }
}

async function ask(text, marks = {}) {
  setBusy(true);
  loadRunsOn();
  show({ role: "user", text, ...marks });
  try {
    const res = await fetch("/dispatch/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation: current, text, ...marks }),
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
          compose.adopt(event.id);
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

// Session cards and review results arrive between turns, as the sessions Dispatch started change,
// and a step decided on another device changes in place.
async function catchUp(showNew = true) {
  if (!current || busy) return;
  const id = current;
  const convo = await api("GET", `/dispatch/conversations/${encodeURIComponent(id)}`).catch(() => null);
  if (!convo || current !== id || busy) return;
  const grew = convo.events.length > shownEvents;
  if (convo.updated !== shownUpdated || grew) {
    events = convo.events.slice();
    draw();
    if (showNew && grew) scrollDown();
  }
  shownEvents = convo.events.length;
  shownUpdated = convo.updated;
  tracked = convo.sessions || [];
  renderTracked();
}

function trackedItem(t, state) {
  const s = state?.sessions.find((x) => x.machine === t.machine && x.tmux === t.name && !x.stale);
  const word = !s ? "ended" : s.activity === "blocked" ? "needs you" : s.activity === "active" ? "working" : "idle";
  const tone = !s ? "" : s.activity === "blocked" ? "warn" : s.activity === "active" ? "ok" : "";
  return html`<span class="dispatch-session"><span class="dot ${tone}"></span>${s
    ? html`<a href=${termUrl(t.machine, t.name)} target="_blank" rel="noopener">${t.name}</a>`
    : t.name}<span class="muted">${t.machine} · ${word}</span></span>`;
}

async function loadState() {
  lastState = await api("GET", "/state").catch(() => lastState);
  return lastState;
}

async function renderTracked() {
  const box = $("dispatch-sessions");
  box.hidden = !tracked.length;
  if (!tracked.length) { render(nothing, box); return; }
  const state = await loadState();
  if (events.some((e) => e.role === "group")) draw();
  render(html`<span class="dispatch-sessions-label">Sessions</span>${repeat(tracked, (t) => `${t.machine}/${t.name}`, (t) => trackedItem(t, state))}`, box);
}

pulls.setup({
  api,
  toast,
  draw,
  termUrl,
  conversation: () => current,
  events: () => events,
  reload: () => catchUp(false),
  replaceAt(index, event) {
    events[index] = event;
  },
  addStep(step) {
    const i = events.findIndex((e) => e.role === "action" && e.id === step.id);
    if (i >= 0) events[i] = step;
    else events.push(step);
    shownEvents = Math.max(shownEvents, events.length);
  },
});

steps.setup({
  api,
  toast,
  draw,
  termUrl,
  short,
  folderOf,
  conversation: () => current,
  state: () => lastState,
  loadState,
  reload: () => catchUp(false),
  decided: () => loadList().catch(() => {}),
  addStep(step) {
    events.push(step);
    shownEvents = Math.max(shownEvents, events.length);
    requestAnimationFrame(scrollDown);
  },
  replaceStep(step) {
    const i = events.findIndex((e) => e.role === "action" && e.id === step.id);
    if (i >= 0) events[i] = step;
  },
  replaceAt(index, event) {
    events[index] = event;
  },
});

groups.setup({
  api,
  toast,
  draw,
  termUrl,
  short,
  conversation: () => current,
  events: () => events,
  state: () => lastState,
  reload: () => catchUp(false),
  decided: () => loadList().catch(() => {}),
  addStep(step) {
    events.push(step);
    shownEvents = Math.max(shownEvents, events.length);
    requestAnimationFrame(scrollDown);
  },
  replaceStep(step) {
    const i = events.findIndex((e) => e.role === "action" && e.id === step.id);
    if (i >= 0) events[i] = step;
  },
});

function taskItem(t) {
  return html`<li class="convo task">
    <button type="button" class="task-run" title=${t.text} @click=${() => runTask(t)}>
      <span class="convo-title">${t.name}</span>
      <span class="convo-meta">${t.text}</span>
    </button>
    <button class="btn quiet delete" type="button" aria-label="Edit ${t.name}" title="Edit" @click=${() => editTask(t)}>${ICONS.edit}</button>
    <button class="btn quiet danger delete" type="button" aria-label="Delete ${t.name}" title="Delete" @click=${() => forgetTask(t)}>${ICONS.close}</button>
  </li>`;
}

function renderTasks() {
  const shown = savedTasks.filter((t) => !t.hidden);
  $("task-restore").hidden = !savedTasks.some((t) => t.hidden);
  countTab("tasks", shown.length);
  render(shown.length
    ? repeat(shown, (t) => t.name, taskItem)
    : html`<li><p class="convo-empty">No tasks yet.</p></li>`, $("task-list"));
}

async function loadTasks() {
  savedTasks = await api("GET", "/dispatch/tasks").catch(() => []);
  renderTasks();
}

function runTask(task) {
  if (busy) { toast("Dispatch is still working on the last message."); return; }
  showTab("chat");
  ask(task.text, { task: { name: task.name, version: task.version } });
}

// The reply to "Suggest a better prompt" ends with the proposal in a block marked prompt, which
// can become a task of its own or the next version of the task the session came from.
function promptActions(b) {
  const asked = events.slice(0, b.key).reverse().find((e) => e.role === "user");
  if (!asked?.improve) return nothing;
  const text = proposedPrompt(b.event.text);
  if (!text) return nothing;
  const from = asked.improve.task && savedTasks.find((t) => t.name === asked.improve.task.name && !t.hidden);
  return html`<div class="prompt-actions">
    <button class="btn" type="button" @click=${() => editTask(null, text)}>Save as a new task</button>
    ${from ? html`<button class="btn primary" type="button" @click=${() => saveVersion(from, text)}>Save as version ${from.version + 1} of ${from.name}</button>` : nothing}
  </div>`;
}

async function saveVersion(task, text) {
  try {
    savedTasks = await api("POST", "/dispatch/tasks", { name: task.name, text, replacing: task.name });
    const saved = savedTasks.find((t) => t.name === task.name);
    toast(saved && saved.version !== task.version ? `Saved as version ${saved.version} of "${task.name}"` : `"${task.name}" already has this text`, "ok");
    renderTasks();
    draw();
  } catch (err) {
    toast(err.message);
  }
}

function insights(machine, name, here) {
  window.YardbellInsights.open({ machine, name, onSuggest: (data) => suggest(data, here) });
}

// A normal turn the person starts, in this conversation when asked from one of its cards, or in a
// new one otherwise.
async function suggest(data, here = false) {
  if (busy) { toast("Dispatch is still working on the last message. Stop it or wait, then try again."); return; }
  if (!here && current) await open(null);
  const task = data.from ? { name: data.from.name, version: data.from.version } : undefined;
  ask(data.suggest, { improve: { machine: data.machine, name: data.name, ...(task ? { task } : {}) } });
}

async function suggestFor(machine, name) {
  try {
    suggest(await window.YardbellInsights.load(machine, name));
  } catch (err) {
    toast(err.message);
  }
}

async function forgetTask(task) {
  const note = task.builtin ? "It is a default task, so Restore default tasks brings it back." : "Conversations it started are kept.";
  if (!(await Nav.confirm(`Delete the task "${task.name}"?`, note, { confirm: "Delete", danger: true }))) return;
  savedTasks = await api("POST", "/dispatch/tasks/delete", { name: task.name }).catch((err) => { toast(err.message); return savedTasks; });
  renderTasks();
}

function editTask(task, text = "") {
  editingTask = task?.name || null;
  const f = $("task-form");
  f.hidden = false;
  f.name.value = task?.name || "";
  f.text.value = text || task?.text || "";
  $("task-version").hidden = !task;
  if (task) $("task-version-word").textContent = `Version ${task.version}${task.builtin ? (task.customised ? ", changed from the default" : ", the default") : ""}`;
  $("tasks").open = true;
  showTab("tasks");
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

$("task-history").addEventListener("click", () => {
  const task = savedTasks.find((t) => t.name === editingTask);
  if (!task) return;
  openHistory({
    name: task.name,
    customised: task.customised,
    api,
    toast,
    changed(tasks) {
      savedTasks = tasks;
      renderTasks();
      const now = savedTasks.find((t) => t.name === task.name);
      if (now && editingTask === now.name) editTask(now);
    },
  });
});

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

$("task-restore").addEventListener("click", async () => {
  savedTasks = await api("POST", "/dispatch/tasks/restore", {}).catch((err) => { toast(err.message); return savedTasks; });
  renderTasks();
});

$("save-as-task").addEventListener("click", () => {
  const text = form.text.value.trim();
  if (!text) { toast("Type the task first, then save it."); form.text.focus(); return; }
  editTask(null, text);
});

window.YardbellLive.follow(() => {
  catchUp(true);
  if (!busy) {
    loadList().catch(() => {});
    loadRunsOn();
  }
}, 5000);

// Wide, the chat column scrolls on its own; narrow, the page or its main area does.
function scroller() {
  for (const el of [$("dispatch-chat"), document.querySelector(".main")]) {
    if (getComputedStyle(el).overflowY !== "visible") return el;
  }
  return document.scrollingElement;
}

const compose = composer(form, {
  send(text) {
    if (busy) {
      toast("Dispatch is still working on the last message. Stop it or wait, then send.");
      return false;
    }
    ask(text);
    return true;
  },
  sent: () => events.filter((e) => e.role === "user").map((e) => e.text),
  tasks: () => savedTasks.filter((t) => !t.hidden),
  state: () => api("GET", "/state"),
  scroller,
  scrollDown,
});

$("dispatch-stop").addEventListener("click", () => {
  if (!current) return;
  api("POST", `/dispatch/conversations/${encodeURIComponent(current)}/stop`, {}).catch((err) => toast(err.message));
});

$("new-chat").addEventListener("click", () => {
  if (busy) { toast("This conversation is still working. Stop it or wait, then start a new one."); return; }
  open(null);
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

// The tabs pick what shows: narrow, the chat or one list; wide, which list sits beside the chat.
// Either way a list is always open, so its heading does not fold it.
for (const id of ["convos", "tasks"]) {
  $(id).open = true;
  $(id).querySelector("summary").addEventListener("click", (e) => {
    if (!e.target.closest("button")) e.preventDefault();
  });
}

function tabList() {
  return [...document.querySelectorAll("#dispatch-tabs [role=tab]")];
}

function showTab(name, focus = false) {
  const d = $("dispatch");
  d.dataset.tab = name;
  if (name !== "chat") d.dataset.list = name;
  paintTabs(focus ? name : "");
}

function paintTabs(focus = "") {
  const d = $("dispatch");
  const on = narrow.matches ? d.dataset.tab : d.dataset.list;
  for (const t of tabList()) {
    const picked = t.dataset.tab === on;
    t.setAttribute("aria-selected", String(picked));
    t.tabIndex = picked ? 0 : -1;
    if (picked && t.dataset.tab === focus) t.focus();
  }
}

function countTab(name, n) {
  $("dispatch-tabs").querySelector(`[data-tab=${name}] .seg-count`).textContent = n;
}

for (const t of tabList()) t.addEventListener("click", () => showTab(t.dataset.tab));
$("dispatch-tabs").addEventListener("keydown", (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  const tabs = tabList().filter((t) => t.getClientRects().length > 0);
  const at = tabs.indexOf(document.activeElement);
  if (!step || at < 0) return;
  e.preventDefault();
  showTab(tabs[(at + step + tabs.length) % tabs.length].dataset.tab, true);
});
$("tab-new").addEventListener("click", () => $("new-chat").click());
narrow.addEventListener("change", () => paintTabs());
$("dispatch").dataset.list = "convos";
showTab("chat");
const handedOver = window.YardbellInsights.takeOver();
loadRunsOn();
loadTasks();
loadState().then(() => draw());
loadList()
  .then(() => open(!handedOver && current && conversations.some((c) => c.id === current) ? current : null))
  .then(() => { if (handedOver) suggestFor(handedOver.machine, handedOver.name); })
  .catch((err) => toast(err.message));

// Inside the Workspace, Dispatch opens sessions as Workspace panes and other pages in the whole window.
if (window.top !== window.self) {
  const tell = (message) => window.parent.postMessage({ yardbell: "dispatch", ...message }, location.origin);
  $("hide-panel").addEventListener("click", () => tell({ action: "hide" }));
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.yardbell !== "suggest") return;
    if (typeof e.data.machine === "string" && typeof e.data.name === "string") suggestFor(e.data.machine, e.data.name);
  });
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
