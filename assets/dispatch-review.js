import { html, nothing, render } from "/vendor/lit-html/lit-html.js";

// Dispatch's steps that change something (start, stop or type into a session) and the results of
// reviews, drawn as cards the person approves, edits, rejects or acts on.

export const CHANGING = new Set(["start_session", "send_to_session", "stop_session", "review_session", "scan_folder"]);

const ICONS = {
  start_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9l7-4.5z"/></svg>`,
  send_to_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8.5 12h5"/></svg>`,
  stop_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`,
  review: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg>`,
  scan: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M2.5 8h11"/></svg>`,
  file: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>`,
  check: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`,
  edit: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4z"/></svg>`,
  chevron: html`<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>`,
};

const TITLES = {
  start_session: "Start a session",
  send_to_session: "Type into a session",
  stop_session: "Stop a session",
};

const SEVERITY = { high: "High", medium: "Medium", low: "Low" };

const SCANS = { dead_code: "Dead code scan", test_gaps: "Test gap scan", security: "Security scan" };
const SCAN_WHAT = {
  dead_code: "unused functions, modules, routes, assets and config",
  test_gaps: "important code without tests, and runs the tests",
  security: "secrets, injection, unsafe input, missing auth checks and advisories",
};
const scanOf = (of) => (of && SCANS[of.scan] ? of.scan : null);

const CHANGE = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Unmerged" };

let ctx = null;
const drafts = new Map();
const working = new Map();
const expanded = new Set();
const picks = new Map();
const sending = new Set();
const diffs = new Map();
const targets = new Map();

export function setup(context) {
  ctx = context;
}

export function reset() {
  drafts.clear();
  working.clear();
  expanded.clear();
  picks.clear();
  sending.clear();
  diffs.clear();
  targets.clear();
}

function clock(stamp) {
  if (!stamp) return "";
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString()} ${time}`;
}

function agentLabel(name) {
  const agents = ctx.state()?.agents || [];
  if (!name) {
    const fallback = agents.find((a) => a.name === ctx.state()?.default_agent);
    return fallback ? fallback.label : "the default agent";
  }
  return agents.find((a) => a.name === name)?.label || name;
}

// Old conversations recorded these steps as plain tool calls, which ran without asking.
export function legacyStep(tool, input) {
  return { role: "action", legacy: true, tool, input: input || {}, status: "auto", by: "dispatch" };
}

export function legacyResult(step, e) {
  let session = null;
  try {
    const s = JSON.parse(e.text);
    if (s.machine && s.name) session = s;
  } catch {}
  step.result = { ok: !e.is_error, text: e.text, session };
}

function stateOf(e) {
  if (working.has(e.id) || ((e.status === "approved" || e.status === "edited") && !e.result)) return "running";
  if (e.status === "pending") return "pending";
  if (e.status === "rejected" || e.status === "withdrawn") return e.status;
  return e.result && !e.result.ok ? "failed" : "done";
}

function badge(e, state) {
  const mine = e.by === "you";
  switch (state) {
    case "pending": return html`<span class="badge blocked">${mine ? mineWords(e).waiting : "Waiting for you"}</span>`;
    case "running": return html`<span class="badge busy">Running</span>`;
    case "failed": return html`<span class="badge failed">Failed</span>`;
    case "rejected": return html`<span class="badge">${mine ? "Cancelled" : "Rejected"}</span>`;
    case "withdrawn": return html`<span class="badge">Withdrawn</span>`;
    default: return html`<span class="badge done">Done</span>`;
  }
}

function where(e) {
  const i = e.input || {};
  if (scanOf(e.review)) {
    return html`<code>${ctx.short(e.review.path || i.path)}</code> on ${i.machine} · ${agentLabel(i.agent)}`;
  }
  if (e.review) {
    const of = e.review;
    return html`of <strong>${of.name}</strong> on ${i.machine}${of.branch ? html` · <code>${of.branch}</code>` : nothing} · ${agentLabel(i.agent)}`;
  }
  if (e.tool === "start_session") {
    const folder = i.folder || ctx.short(i.path);
    const branch = i.branch ? html` · <code>${i.branch}</code>${i.new_branch ? ` new${i.base ? ` from ${i.base}` : ""}` : ""}` : nothing;
    return html`${i.machine}${folder ? html` · <code>${folder}</code>` : nothing}${branch} · ${agentLabel(i.agent)}`;
  }
  return html`<strong>${i.name}</strong> on ${i.machine}`;
}

// Claude Code and Codex start without a way to edit files; other agents are only asked not to.
function readOnlyNote(i) {
  const state = ctx.state();
  const agent = (state?.agents || []).find((a) => a.name === (i.agent || state?.default_agent));
  if (!agent) return nothing;
  return agent.read_only
    ? html`<p class="step-card-text muted">${agent.label} starts with file editing turned off.</p>`
    : html`<p class="step-card-text muted read-only-note">Read-only by instruction: ${agent.label} cannot be started with file editing turned off, so it is only asked to change nothing.</p>`;
}

function longText(id, text) {
  const long = text.length > 420 || text.split("\n").length > 6;
  const open = expanded.has(id);
  return html`<p class="step-card-text ${long && !open ? "clamped" : ""}">${text}</p>
    ${long ? html`<button class="link-btn" type="button" @click=${() => { open ? expanded.delete(id) : expanded.add(id); ctx.draw(); }}>${open ? "Show less" : "Show all"}</button>` : nothing}`;
}

function body(e) {
  const i = e.input || {};
  const scan = scanOf(e.review);
  if (scan) {
    return html`<div class="step-card-body">
      <p class="step-card-text">A new session in <code>${ctx.short(i.path)}</code> looks through all of its code for ${SCAN_WHAT[scan]}. It changes no files, and its findings come back here.</p>
      ${readOnlyNote(i)}
      <details class="step-card-more"><summary>Instructions for the scanner</summary><p class="step-card-text step-card-mono">${i.prompt}</p></details>
    </div>`;
  }
  if (e.review) {
    return html`<div class="step-card-body">
      <p class="step-card-text">A new session in <code>${ctx.short(i.path)}</code> reviews this branch, runs the tests and changes no files. Its findings come back here.</p>
      ${readOnlyNote(i)}
      <details class="step-card-more"><summary>Instructions for the reviewer</summary><p class="step-card-text step-card-mono">${i.prompt}</p></details>
    </div>`;
  }
  switch (e.tool) {
    case "start_session":
      return i.prompt ? html`<div class="step-card-body"><p class="step-card-label">Task</p>${longText(e.id || i.prompt, i.prompt)}</div>` : nothing;
    case "send_to_session":
      return html`<div class="step-card-body"><p class="step-card-label">Text</p><p class="step-card-text step-card-mono">${i.text}</p></div>`;
    case "stop_session":
      return html`<div class="step-card-body"><p class="step-card-text muted">Ends the tmux session and the agent in it.</p></div>`;
    default:
      return nothing;
  }
}

function field(draft, key, label, attrs = {}) {
  return html`<label>${label}<input type="text" .value=${draft[key] ?? ""} placeholder=${attrs.placeholder || ""} ?disabled=${attrs.disabled} @input=${(ev) => { draft[key] = ev.target.value; }}></label>`;
}

function editor(e) {
  const draft = drafts.get(e.id);
  const state = ctx.state();
  if (e.tool === "send_to_session") {
    return html`<div class="step-card-form">
      <label>Text<textarea rows="3" .value=${draft.text ?? ""} @input=${(ev) => { draft.text = ev.target.value; }}></textarea></label>
    </div>`;
  }
  const machines = state?.machines?.map((m) => m.name) || [draft.machine];
  const agents = state?.agents || [];
  const inFolder = draft.path === undefined || draft.folder;
  const agent = html`<label>Agent<select @change=${(ev) => { draft.agent = ev.target.value; }}>
    <option value="" ?selected=${!draft.agent}>Default agent</option>
    ${agents.map((a) => html`<option value=${a.name} ?selected=${a.name === draft.agent}>${a.label}</option>`)}
  </select></label>`;
  return html`<div class="step-card-form">
    <div class="grid2">
      ${e.review ? nothing : html`<label>Machine<select @change=${(ev) => { draft.machine = ev.target.value; }}>
        ${machines.map((m) => html`<option value=${m} ?selected=${m === draft.machine}>${m}</option>`)}
      </select></label>`}
      ${agent}
    </div>
    ${e.review ? nothing : html`<div class="grid2">
      ${inFolder ? field(draft, "folder", "Folder") : field(draft, "path", "Path")}
      ${field(draft, "branch", "Branch", { placeholder: "Keep the current branch" })}
    </div>
    <div class="step-card-form-row">
      <label class="check"><input type="checkbox" .checked=${Boolean(draft.new_branch)} @change=${(ev) => { draft.new_branch = ev.target.checked; ctx.draw(); }}>Create the branch</label>
      ${draft.new_branch ? field(draft, "base", "From", { placeholder: "main" }) : nothing}
    </div>`}
    <label>${scanOf(e.review) ? "Instructions for the scanner" : e.review ? "Instructions for the reviewer" : "Task"}<textarea rows=${e.review ? 9 : 6} .value=${draft.prompt ?? ""} @input=${(ev) => { draft.prompt = ev.target.value; }}></textarea></label>
  </div>`;
}

function edited(e) {
  const draft = { ...drafts.get(e.id) };
  for (const key of Object.keys(draft)) {
    if (draft[key] === "" && !(key in e.input)) delete draft[key];
    if (draft[key] === false && !(key in e.input)) delete draft[key];
  }
  if (!draft.new_branch) delete draft.base;
  return draft;
}

async function decide(e, decision) {
  const input = decision === "approve" && drafts.has(e.id) ? edited(e) : null;
  working.set(e.id, decision);
  ctx.draw();
  try {
    const step = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/actions/${e.id}`, { decision, ...(input ? { input } : {}) });
    drafts.delete(e.id);
    ctx.replaceStep(step);
    ctx.decided();
    if (step.result && !step.result.ok) ctx.toast(step.result.text);
  } catch (err) {
    ctx.toast(err.message);
    if (/already|withdrawn/.test(err.message)) ctx.reload();
  } finally {
    working.delete(e.id);
    ctx.draw();
  }
}

async function decideAll(decision, pending) {
  for (const e of pending) working.set(e.id, decision);
  ctx.draw();
  try {
    const steps = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/actions`, { decision });
    for (const step of steps) ctx.replaceStep(step);
    ctx.decided();
    const failed = steps.filter((s) => s.result && !s.result.ok).length;
    if (failed) ctx.toast(`${failed} of ${steps.length} ${steps.length === 1 ? "step" : "steps"} failed. Each card says why.`);
  } catch (err) {
    ctx.toast(err.message);
  } finally {
    for (const e of pending) working.delete(e.id);
    ctx.draw();
  }
}

function startEditing(e) {
  drafts.set(e.id, { ...e.input });
  if (!ctx.state()) ctx.loadState().then(() => ctx.draw());
  ctx.draw();
}

function outcome(e, state) {
  const r = e.result;
  if (state === "failed") return html`<p class="step-card-outcome step-card-error">${r.text}</p>`;
  if (state !== "done" || !r) return nothing;
  const s = r.session;
  if (e.tool === "start_session" && s) {
    return html`<p class="step-card-outcome">${ICONS.check}<span>Started <strong>${s.name}</strong> on ${s.machine}</span>
      <a class="btn" href=${ctx.termUrl(s.machine, s.name)} target="_blank" rel="noopener" title="Open ${s.name}"><span class="btn-label">Open</span></a></p>`;
  }
  const word = { send_to_session: "Sent", stop_session: "Stopped" }[e.tool] || "Done";
  return html`<p class="step-card-outcome">${ICONS.check}<span>${word}</span></p>`;
}

const RULE_STEPS = { start_session: "start sessions", stop_session: "stop sessions", send_to_session: "type into sessions", review_session: "start reviews", scan_folder: "start scans" };

function ruleText(r) {
  const machine = !r.machine || r.machine === "any" ? "any machine" : r.machine;
  return `${RULE_STEPS[r.action] || "any step"} on ${machine}${r.folder ? ` in ${r.folder}` : ""}`;
}

// A step the person asked for goes ahead in its own words: a review or a scan starts, a message is
// sent.
const MINE = {
  review: { go: "Start review", done: "Started", edited: "started", waiting: "Not started" },
  scan: { go: "Start scan", done: "Started", edited: "started", waiting: "Not started" },
  start_session: { go: "Start session", done: "Started", edited: "started", waiting: "Not started" },
  send_to_session: { go: "Send", done: "Sent", edited: "sent", waiting: "Not sent" },
};
const mineWords = (e) => MINE[scanOf(e.review) ? "scan" : e.review ? "review" : e.tool] || MINE.start_session;

function trail(e, state) {
  if (e.legacy) return "Ran without asking";
  const parts = [];
  const mine = e.by === "you";
  if (e.status === "auto") parts.push(`Ran without asking ${clock(e.at)}`);
  else parts.push(`${mine ? "You asked for this" : "Proposed by Dispatch"} ${clock(e.at)}`);
  if (e.rule) parts.push(`Your rule: ${ruleText(e.rule)}`);
  if (e.status === "approved") parts.push(`${mine ? mineWords(e).done : "Approved"} ${clock(e.decided)}`);
  if (e.status === "edited") parts.push(`Edited and ${mine ? mineWords(e).edited : "approved"} ${clock(e.decided)}`);
  if (e.status === "rejected") parts.push(`${mine ? "Cancelled" : "Rejected"} ${clock(e.decided)}`);
  if (e.status === "withdrawn") parts.push(`Withdrawn ${clock(e.decided)} when you sent a new message`);
  if (state === "running" && working.get(e.id) !== "reject") parts.push("Running…");
  return parts.map((p) => p.trim()).join(" · ");
}

function actions(e, state) {
  if (state !== "pending" && !(state === "running" && working.has(e.id))) return nothing;
  const busy = working.has(e.id);
  const mine = e.by === "you";
  const editingNow = drafts.has(e.id);
  if (editingNow) {
    return html`<div class="step-card-actions">
      <button class="btn quiet" type="button" ?disabled=${busy} @click=${() => { drafts.delete(e.id); ctx.draw(); }}>Cancel</button>
      <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decide(e, "approve")}>${ICONS.check}${mine ? mineWords(e).go : "Approve with changes"}</button>
    </div>`;
  }
  const editable = e.tool !== "stop_session";
  return html`<div class="step-card-actions">
    <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => decide(e, "reject")}>${mine ? "Cancel" : "Reject"}</button>
    ${editable ? html`<button class="btn" type="button" ?disabled=${busy} @click=${() => startEditing(e)}>${ICONS.edit}Edit</button>` : nothing}
    <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decide(e, "approve")}>${ICONS.check}${mine ? mineWords(e).go : "Approve"}</button>
  </div>`;
}

function stepTitle(e) {
  const scan = scanOf(e.review);
  if (scan) return `Start a ${SCANS[scan].toLowerCase()}`;
  return e.review ? "Start a review" : TITLES[e.tool] || e.tool;
}

export function stepCard(e) {
  const state = stateOf(e);
  const icon = scanOf(e.review) ? ICONS.scan : e.review ? ICONS.review : ICONS[e.tool] || ICONS.start_session;
  return html`<article class="step-card ${state}" aria-label=${stepTitle(e)}>
    <header class="step-card-head">
      <span class="step-card-icon">${icon}</span>
      <div class="step-card-title">
        <strong>${stepTitle(e)}</strong>
        <span class="step-card-where">${where(e)}</span>
      </div>
      ${badge(e, state)}
    </header>
    ${drafts.has(e.id) && state === "pending" ? editor(e) : body(e)}
    ${editNote(e)}
    <footer class="step-card-foot">
      ${outcome(e, state)}
      <span class="step-card-trail">${trail(e, state)}</span>
      ${actions(e, state)}
    </footer>
  </article>`;
}

// What the person changed, said against what was proposed: "the agent (was Codex) and the task".
function changes(e) {
  const was = (k) => e.original[k] || "";
  const fields = [];
  if (was("machine") !== (e.input.machine || "")) fields.push(`machine (was ${was("machine")})`);
  if (was("folder") !== (e.input.folder || "") || was("path") !== (e.input.path || "")) fields.push(`folder (was ${was("folder") || ctx.short(was("path")) || "none"})`);
  if (was("branch") !== (e.input.branch || "") || Boolean(e.original.new_branch) !== Boolean(e.input.new_branch)) fields.push(`branch (was ${was("branch") || "the current one"})`);
  if (was("agent") !== (e.input.agent || "")) fields.push(`agent (was ${agentLabel(was("agent"))})`);
  if (was("prompt") !== (e.input.prompt || "")) fields.push(e.review ? "instructions" : "task");
  if (was("text") !== (e.input.text || "")) fields.push("text");
  return fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}` : fields[0] || "";
}

function editNote(e) {
  if (e.status !== "edited" || !e.original) return nothing;
  const what = changes(e);
  const proposed = e.original.prompt ?? e.original.text;
  const differs = proposed !== undefined && proposed !== (e.input.prompt ?? e.input.text);
  return html`<div class="step-card-note">
    <p>Edited before it ran${what ? `: you changed the ${what}` : ""}.</p>
    ${differs ? html`<details class="step-card-more"><summary>${e.by === "you" ? "What it started with" : "What Dispatch proposed"}</summary><p class="step-card-text step-card-mono">${proposed}</p></details>` : nothing}
  </div>`;
}

export function waitingBar(events) {
  const pending = events.filter((e) => e.role === "action" && e.status === "pending");
  if (!pending.length) return nothing;
  const busy = pending.some((e) => working.has(e.id));
  const one = pending.length === 1;
  return html`<div class="steps-bar" role="group" aria-label="Steps waiting for you">
    <span><strong>${one ? "1 step" : `${pending.length} steps`}</strong> ${one ? "waits" : "wait"} for your approval. Sending a new message withdraws ${one ? "it" : "them"}, so Dispatch can propose again.</span>
    ${one ? nothing : html`<span class="step-card-actions">
      <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => decideAll("reject", pending)}>Reject all</button>
      <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decideAll("approve", pending)}>${ICONS.check}Approve all</button>
    </span>`}
  </div>`;
}

function picked(e, index) {
  if (e.outcome) return new Set(e.outcome.findings || []);
  if (!picks.has(index)) picks.set(index, new Set((e.findings || []).map((_, i) => i)));
  return picks.get(index);
}

async function settle(e, index, decision, to) {
  const findings = [...picked(e, index)].sort((a, b) => a - b);
  const words = `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`;
  sending.add(index);
  ctx.draw();
  try {
    const answer = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/reviews/${index}`, { decision, findings, ...(to ? { to } : {}) });
    if (decision === "start") {
      ctx.replaceAt(index, answer.card);
      ctx.addStep(answer.step);
      ctx.toast(`A new session for ${words} waits below for you to start it`, "ok");
    } else {
      ctx.replaceAt(index, answer);
      if (decision === "send") ctx.toast(`Sent ${words} to ${to || e.of.name}`, "ok");
    }
  } catch (err) {
    ctx.toast(err.message);
    if (/already/.test(err.message)) ctx.reload();
  } finally {
    sending.delete(index);
    ctx.draw();
  }
}

function diffOf(index) {
  if (!diffs.has(index)) diffs.set(index, { open: false, list: null, error: "", loading: null, files: new Map(), hit: null, scan: false });
  return diffs.get(index);
}

// A review reads its branch's diff; a scan reads the files its findings point at.
function diffUrl(index, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
  const what = diffOf(index).scan ? "files" : "diff";
  return `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/reviews/${index}/${what}${query ? `?${query}` : ""}`;
}

function loadList(index) {
  const d = diffOf(index);
  if (d.list) return Promise.resolve(d.list);
  if (d.loading) return d.loading;
  d.error = "";
  d.loading = ctx.api("GET", diffUrl(index))
    .then((list) => { d.list = list; return list; })
    .catch((err) => { d.error = err.message; return null; })
    .finally(() => { d.loading = null; ctx.draw(); });
  ctx.draw();
  return d.loading;
}

function fileOf(d, path) {
  if (!d.files.has(path)) d.files.set(path, { open: false, lines: null, next: 0, total: 0, loading: false, error: "" });
  return d.files.get(path);
}

async function loadFile(index, path, line) {
  const f = fileOf(diffOf(index), path);
  if (f.loading) return;
  f.loading = true;
  f.error = "";
  ctx.draw();
  try {
    const page = await ctx.api("GET", diffUrl(index, { file: path, from: f.next, line }));
    f.lines = [...(f.lines || []), ...page.lines];
    Object.assign(f, { next: page.next, total: page.total, binary: page.binary, notes: page.notes, cut: page.cut });
  } catch (err) {
    f.error = err.message;
  } finally {
    f.loading = false;
    ctx.draw();
  }
}

function toggleDiff(index) {
  const d = diffOf(index);
  d.open = !d.open;
  if (d.open) loadList(index);
  ctx.draw();
}

function toggleFile(index, path) {
  const f = fileOf(diffOf(index), path);
  f.open = !f.open;
  if (f.open && !f.lines) loadFile(index, path);
  ctx.draw();
}

// "src/a.rs:88", "src/a.rs:88-92" or "src/a.rs", matched to a changed file even when the
// reviewer wrote a longer or shorter path than git does.
function placeOf(place) {
  const m = String(place).match(/^(.+?)(?::(\d+)(?:[-:,]\d+)*)?$/);
  if (!m) return null;
  return { path: m[1].replace(/^\.\//, ""), line: m[2] ? Number(m[2]) : null };
}

function safePath(path) {
  return Boolean(path) && !path.startsWith("/") && !/[\u0000-\u001f]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== "..");
}

// The files a scan's findings point at, each once, with how many findings name it. The server
// shows only these.
function scanFiles(e) {
  const seen = new Map();
  for (const f of e.findings || []) {
    const at = f.place ? placeOf(f.place) : null;
    if (at && safePath(at.path)) seen.set(at.path, (seen.get(at.path) || 0) + 1);
  }
  return [...seen].map(([path, count]) => ({ path, count }));
}

function fileFor(list, path) {
  const files = list?.files || [];
  const exact = files.find((f) => f.path === path);
  if (exact) return exact;
  const near = files.filter((f) => f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`));
  return near.length === 1 ? near[0] : null;
}

function rowId(index, path, line) {
  return `diff-${index}-${encodeURIComponent(path)}-L${line}`;
}

async function jump(index, place) {
  const at = placeOf(place);
  if (!at) return;
  const d = diffOf(index);
  d.open = true;
  let path = at.path;
  if (!d.scan) {
    const list = await loadList(index);
    if (!list) { ctx.draw(); return; }
    const file = fileFor(list, at.path);
    if (!file) {
      ctx.toast(`${at.path} is not in this review's changes`);
      ctx.draw();
      return;
    }
    path = file.path;
  }
  const f = fileOf(d, path);
  f.open = true;
  d.hit = { path, line: at.line };
  const reached = () => (f.lines && !at.line) || (f.lines || []).some((l) => l.n >= at.line) || (f.lines && f.next >= f.total);
  if (!reached()) await loadFile(index, path, at.line ?? undefined);
  ctx.draw();
  requestAnimationFrame(() => {
    const row = at.line
      ? document.getElementById(rowId(index, path, (f.lines || []).find((l) => l.n >= at.line)?.n))
      : null;
    (row || document.getElementById(`diff-${index}-${encodeURIComponent(path)}`))?.scrollIntoView({ block: "center" });
  });
}

function stats(f) {
  if (f.binary) return html`<span class="diff-stat muted">binary</span>`;
  if (f.added == null && f.removed == null) return nothing;
  if (!f.added && !f.removed) return nothing;
  return html`<span class="diff-stat"><span class="add">+${f.added ?? 0}</span> <span class="del">−${f.removed ?? 0}</span></span>`;
}

function fileBody(index, d, file, f) {
  if (f.error) return html`<p class="diff-msg error">${f.error} <button class="link-btn" type="button" @click=${() => loadFile(index, file.path)}>Try again</button></p>`;
  if (!f.lines) return html`<p class="diff-msg">${d.scan ? "Loading the file…" : "Loading the diff…"}</p>`;
  const notes = (f.notes || []).map((n) => html`<p class="diff-msg">${n}.</p>`);
  if (f.binary) return html`${notes}<p class="diff-msg">A binary file, so there is nothing to show.</p>`;
  if (!f.lines.length) return html`${notes}${notes.length ? nothing : html`<p class="diff-msg">${d.scan ? "The file is empty." : "No changes inside the file."}</p>`}`;
  const hit = d.hit?.path === file.path ? d.hit.line : null;
  const hitRow = hit ? f.lines.find((l) => l.n >= hit)?.n : null;
  const left = f.total - f.next;
  const row = (l) => d.scan
    ? html`<tr class="ctx ${l.n === hitRow ? "hit" : ""}" id=${rowId(index, file.path, l.n)}>
        <td class="ln">${l.n}</td><td class="code">${l.t}</td>
      </tr>`
    : html`<tr class="${l.k} ${l.n && l.n === hitRow && l.k !== "del" ? "hit" : ""}" id=${l.n && l.k !== "del" ? rowId(index, file.path, l.n) : nothing}>
        <td class="ln">${l.o ?? ""}</td><td class="ln">${l.n ?? ""}</td>
        <td class="code"><span class="mark" aria-hidden="true">${l.k === "add" ? "+" : l.k === "del" ? "−" : " "}</span>${l.t}</td>
      </tr>`;
  return html`${notes}<div class="diff-scroll"><table class="diff-table ${d.scan ? "file-table" : ""}">
    <tbody>${f.lines.map((l) => l.k === "hunk"
      ? html`<tr class="hunk"><td class="ln"></td><td class="ln"></td><td class="code">${l.t}</td></tr>`
      : row(l))}</tbody>
  </table></div>
  ${left > 0 ? html`<button class="link-btn diff-more" type="button" ?disabled=${f.loading} @click=${() => loadFile(index, file.path)}>${f.loading ? "Loading…" : `Show ${Math.min(left, 400)} more lines (${left} left)`}</button>` : nothing}
  ${f.cut && left <= 0 ? html`<p class="diff-msg">The rest of this ${d.scan ? "file" : "diff"} is over 2 MB, so it is not shown.</p>` : nothing}`;
}

function fileRow(index, d, file) {
  const f = fileOf(d, file.path);
  const word = file.untracked ? "New, not committed" : CHANGE[file.status] || file.status;
  return html`<li class="diff-file ${f.open ? "open" : ""}">
    <button class="diff-file-head" type="button" id=${`diff-${index}-${encodeURIComponent(file.path)}`} aria-expanded=${f.open ? "true" : "false"} @click=${() => toggleFile(index, file.path)}>
      ${ICONS.chevron}
      <span class="diff-status" title=${word}><span aria-hidden="true">${file.untracked ? "?" : file.status}</span><span class="visually-hidden">${word}</span></span>
      <span class="diff-path">${file.old_path ? html`<span class="muted">${file.old_path} → </span>` : nothing}${file.path}</span>
      ${stats(file)}
    </button>
    ${f.open ? html`<div class="diff-file-body">${fileBody(index, d, file, f)}</div>` : nothing}
  </li>`;
}

function diffNote(e, list) {
  const base = list.base || e.diff?.base;
  const parts = [];
  if (!base) parts.push(html`Yardbell found no base branch, so these are the changes not yet committed.`);
  else if (list.merge_base === list.head) parts.push(html`No commits beyond <code>${base}</code>, so these are the changes not yet committed.`);
  else parts.push(html`Against <code>${base}</code> from <code>${list.merge_base.slice(0, 7)}</code>, with changes not yet committed.`);
  parts.push(html` Read from the folder as it is now.`);
  return html`<p class="diff-msg">${parts}${list.moved ? html` <strong>The branch has new commits since this review.</strong>` : nothing}</p>`;
}

function diffPanel(e, index) {
  const d = diffOf(index);
  const list = d.list;
  const files = list?.files || [];
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  const count = list ? html`<span class="review-diff-count">${files.length} ${files.length === 1 ? "file" : "files"}${files.length ? html` <span class="add">+${added}</span> <span class="del">−${removed}</span>` : nothing}</span>` : nothing;
  let body = nothing;
  if (d.open) {
    if (d.error) body = html`<p class="diff-msg error">${d.error} <button class="link-btn" type="button" @click=${() => loadList(index)}>Try again</button></p>`;
    else if (!list) body = html`<p class="diff-msg">Reading the changes on ${e.machine}…</p>`;
    else body = html`${diffNote(e, list)}
      ${files.length ? html`<ul class="diff-files">${files.map((f) => fileRow(index, d, f))}</ul>` : html`<p class="diff-msg">No changes.</p>`}
      ${list.truncated ? html`<p class="diff-msg">Only part of a very large change is listed.</p>` : nothing}`;
  }
  return html`<section class="review-diff">
    <button class="review-diff-toggle" type="button" aria-expanded=${d.open ? "true" : "false"} @click=${() => toggleDiff(index)}>${ICONS.chevron}<span>Changes</span>${count}</button>
    ${d.open ? html`<div class="review-diff-body">${body}</div>` : nothing}
  </section>`;
}

function scanFileRow(index, d, file) {
  const f = fileOf(d, file.path);
  return html`<li class="diff-file ${f.open ? "open" : ""}">
    <button class="diff-file-head" type="button" id=${`diff-${index}-${encodeURIComponent(file.path)}`} aria-expanded=${f.open ? "true" : "false"} @click=${() => toggleFile(index, file.path)}>
      ${ICONS.chevron}
      <span class="diff-status" aria-hidden="true">${ICONS.file}</span>
      <span class="diff-path">${file.path}</span>
      <span class="diff-stat muted">${file.count} ${file.count === 1 ? "finding" : "findings"}</span>
    </button>
    ${f.open ? html`<div class="diff-file-body">${fileBody(index, d, file, f)}</div>` : nothing}
  </li>`;
}

// A scan has no branch diff, so the card shows the files its findings point at instead, read
// from the folder as it is now.
function filesPanel(e, index) {
  const d = diffOf(index);
  d.scan = true;
  const files = scanFiles(e);
  if (!files.length) return nothing;
  const folder = e.of?.path || e.path;
  return html`<section class="review-diff">
    <button class="review-diff-toggle" type="button" aria-expanded=${d.open ? "true" : "false"} @click=${() => { d.open = !d.open; ctx.draw(); }}>${ICONS.chevron}<span>Files</span><span class="review-diff-count">${files.length} ${files.length === 1 ? "file" : "files"}</span></button>
    ${d.open ? html`<div class="review-diff-body">
      <p class="diff-msg">The files the findings point at, read from <code>${ctx.short(folder)}</code> as it is now.</p>
      <ul class="diff-files">${files.map((f) => scanFileRow(index, d, f))}</ul>
    </div>` : nothing}
  </section>`;
}

function shotUrl(index, file) {
  return `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/reviews/${index}/evidence/${encodeURIComponent(file)}`;
}

function viewer() {
  let dialog = document.getElementById("shot-view");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "shot-view";
    dialog.className = "shot-view";
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  return dialog;
}

function openShot(index, shot) {
  const dialog = viewer();
  const url = shotUrl(index, shot.file);
  const zoom = (ev) => ev.currentTarget.closest(".shot-view-body").classList.toggle("actual");
  render(html`<div class="shot-view-head">
      <strong>${shot.name}</strong>
      <span class="muted">${shot.width} × ${shot.height}</span>
      <button class="btn" type="button" @click=${() => dialog.close()}>Close</button>
    </div>
    <div class="shot-view-body"><img src=${url} alt=${`Screenshot ${shot.name}`} width=${shot.width} height=${shot.height} title="Click to switch between fitting the window and the actual size" @click=${zoom}></div>`, dialog);
  dialog.querySelector(".shot-view-body").classList.remove("actual");
  dialog.showModal();
}

function shots(e, index, i) {
  const mine = (e.evidence || []).filter((s) => s.finding === i);
  if (!mine.length) return nothing;
  const kept = mine.filter((s) => s.file);
  const lost = mine.filter((s) => !s.file);
  return html`${kept.length ? html`<span class="finding-shots">${kept.map((s) => html`<button class="shot" type="button" aria-label=${`Open the screenshot ${s.name} full size`} title=${s.name} @click=${(ev) => { ev.preventDefault(); openShot(index, s); }}>
      <img src=${shotUrl(index, s.file)} alt="" loading="lazy" width=${s.width} height=${s.height}>
    </button>`)}</span>` : nothing}
    ${lost.map((s) => html`<span class="finding-shot-error">${s.name} was not attached: ${s.error}.</span>`)}`;
}

function place(e, index, f) {
  if (!f.place) return nothing;
  const at = placeOf(f.place);
  const scan = scanOf(e.of);
  const list = diffOf(index).list;
  const linked = at && (scan ? safePath(at.path) : !list || fileFor(list, at.path));
  if (!linked) return html`<code class="finding-place">${f.place}</code>`;
  return html`<button class="finding-place link" type="button" title=${scan ? "Show this in the file" : "Show this in the changes"} @click=${(ev) => { ev.preventDefault(); jump(index, f.place); }}>${f.place}</button>`;
}

function finding(e, index, f, i, chosen) {
  const decided = Boolean(e.outcome);
  const toggle = (ev) => {
    if (ev.target.checked) chosen.add(i);
    else chosen.delete(i);
    ctx.draw();
  };
  return html`<li><label class="finding ${decided && !chosen.has(i) ? "left-out" : ""}">
    <input type="checkbox" .checked=${chosen.has(i)} ?disabled=${decided || sending.has(index)} @change=${toggle}>
    <span class="sev ${f.severity}">${SEVERITY[f.severity] || f.severity}</span>
    <span class="finding-text">${place(e, index, f)}<span>${f.text}</span>${shots(e, index, i)}</span>
  </label></li>`;
}

function targetsOf(e, index) {
  if (!targets.has(index)) {
    const t = { list: null, pick: "" };
    targets.set(index, t);
    ctx.api("GET", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/reviews/${index}/sessions`)
      .then((r) => {
        t.list = r.sessions || [];
        t.pick = t.list.some((s) => s.name === e.of?.name) ? e.of.name : t.list[0]?.name || "";
      })
      .catch(() => { t.list = []; })
      .finally(() => ctx.draw());
  }
  return targets.get(index);
}

function scanVerdict(e) {
  const n = (e.findings || []).length;
  if (e.verdict === "clean" || !n) return { tone: "done", word: e.verdict === "clean" ? "Clean" : "Issues found" };
  return { tone: "blocked", word: `${n} ${n === 1 ? "issue" : "issues"} found` };
}

function scanCard(e, index) {
  const findings = e.findings || [];
  const chosen = picked(e, index);
  const of = e.of || {};
  const busy = sending.has(index);
  const done = e.outcome;
  const count = chosen.size;
  const verdict = scanVerdict(e);
  const title = SCANS[of.scan];
  const decidedWords = (o) => {
    const n = `${o.findings?.length || 0} ${o.findings?.length === 1 ? "finding" : "findings"}`;
    if (o.decision === "sent") return `Sent ${n} to ${o.to} ${clock(o.at)}`;
    if (o.decision === "started") return `Asked for a new session to fix ${n} ${clock(o.at)}`;
    return `Dismissed ${clock(o.at)}`;
  };
  let send = nothing;
  if (!done && findings.length) {
    const t = targetsOf(e, index);
    const sessions = t.list || [];
    send = html`${sessions.length ? html`<label class="scan-target"><span class="visually-hidden">Send the findings to</span>
        <select ?disabled=${busy} @change=${(ev) => { t.pick = ev.target.value; ctx.draw(); }}>
          ${sessions.map((s) => html`<option value=${s.name} ?selected=${t.pick === s.name}>${s.name}</option>`)}
          <option value="" ?selected=${!t.pick}>A new session</option>
        </select></label>` : nothing}
      <button class="btn primary" type="button" ?disabled=${busy || !count || !t.list}
        title=${t.pick ? `Type the chosen findings into ${t.pick} so it fixes them` : "Prepare a new session in this folder with the chosen findings as its task"}
        @click=${() => settle(e, index, t.pick ? "send" : "start", t.pick)}><span class="btn-label">${t.pick ? `Send ${count} to ${t.pick}` : `Fix ${count} in a new session`}</span></button>`;
  }
  const foot = done
    ? html`<span class="step-card-trail">${decidedWords(done)}</span>`
    : html`<span class="step-card-trail">Finished ${clock(e.at)}</span>
      <div class="step-card-actions">
        <button class="btn" type="button" ?disabled=${busy} @click=${() => settle(e, index, "dismiss")}>Dismiss</button>
        ${send}
      </div>`;
  const folder = String(of.path || "").replace(/\/+$/, "").split("/").pop() || of.path;
  return html`<article class="step-card review scan ${done ? "done" : verdict.tone === "done" ? "ready" : "pending"}" aria-label="${title} of ${folder}">
    <header class="step-card-head">
      <span class="step-card-icon">${ICONS.scan}</span>
      <div class="step-card-title">
        <strong>${title} of <code>${folder}</code></strong>
        <span class="step-card-where">by <a href=${ctx.termUrl(e.machine, e.name)} target="_blank" rel="noopener">${e.name}</a> on ${e.machine} · <code>${ctx.short(of.path)}</code>${of.branch ? html` · <code>${of.branch}</code>` : nothing}</span>
      </div>
      <span class="badge ${verdict.tone}">${verdict.word}</span>
    </header>
    <div class="step-card-body">
      ${e.summary ? html`<p class="step-card-text">${e.summary}</p>` : nothing}
      ${findings.length
        ? html`<ul class="findings">${findings.map((f, i) => finding(e, index, f, i, chosen))}</ul>`
        : html`<p class="step-card-text muted">No issues found.</p>`}
      ${filesPanel(e, index)}
    </div>
    <footer class="step-card-foot">${foot}</footer>
  </article>`;
}

export function reviewCard(e, index) {
  if (scanOf(e.of)) return scanCard(e, index);
  const findings = e.findings || [];
  const chosen = picked(e, index);
  const ready = e.verdict === "ready";
  const of = e.of || {};
  const busy = sending.has(index);
  const done = e.outcome;
  const count = chosen.size;
  const decided = done
    ? html`<span class="step-card-trail">${done.decision === "sent"
      ? `Sent ${done.findings.length} ${done.findings.length === 1 ? "finding" : "findings"} to ${done.to} ${clock(done.at)}`
      : `Dismissed ${clock(done.at)}`}</span>`
    : html`<span class="step-card-trail">Finished ${clock(e.at)}</span>
      <div class="step-card-actions">
        <button class="btn" type="button" ?disabled=${busy} @click=${() => settle(e, index, "dismiss")}>Dismiss</button>
        ${findings.length ? html`<button class="btn primary" type="button" ?disabled=${busy || !count} title=${`Type the chosen findings into ${of.name} so it fixes them`} @click=${() => settle(e, index, "send")}><span class="btn-label">Send ${count} to ${of.name}</span></button>` : nothing}
      </div>`;
  return html`<article class="step-card review ${done ? "done" : ready ? "ready" : "pending"}" aria-label="Review of ${of.branch || of.name}">
    <header class="step-card-head">
      <span class="step-card-icon">${ICONS.review}</span>
      <div class="step-card-title">
        <strong>Review of ${of.branch ? html`<code>${of.branch}</code>` : of.name}</strong>
        <span class="step-card-where">by <a href=${ctx.termUrl(e.machine, e.name)} target="_blank" rel="noopener">${e.name}</a> on ${e.machine}${of.path ? html` · <code>${ctx.short(of.path)}</code>` : nothing}</span>
      </div>
      <span class="badge ${ready ? "done" : "blocked"}">${ready ? "Ready" : "Changes needed"}</span>
    </header>
    <div class="step-card-body">
      ${e.summary ? html`<p class="step-card-text">${e.summary}</p>` : nothing}
      ${findings.length
        ? html`<ul class="findings">${findings.map((f, i) => finding(e, index, f, i, chosen))}</ul>`
        : html`<p class="step-card-text muted">No problems found.</p>`}
      ${diffPanel(e, index)}
    </div>
    <footer class="step-card-foot">${decided}</footer>
  </article>`;
}
