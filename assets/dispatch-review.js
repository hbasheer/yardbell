import { html, nothing, render } from "/vendor/lit-html/lit-html.js";
import { openHistory } from "/dispatch-tasks.js";
import { canvas, fitAll, settle as fitCanvases, triggerWords } from "/pipeline-canvas.js";

// Dispatch's steps that change something (start, stop or type into a session) and the results of
// reviews, drawn as cards the person approves, edits, rejects or acts on.

export const CHANGING = new Set(["call_connector", "start_session", "send_to_session", "stop_session", "review_session", "scan_folder", "remove_worktree", "integrate_branches", "push_branch", "move_session", "remember", "change_settings", "save_task", "run_trigger", "save_pipeline", "set_pipeline_enabled", "run_pipeline", "answer_run"]);

const ICONS = {
  start_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9l7-4.5z"/></svg>`,
  send_to_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8.5 12h5"/></svg>`,
  stop_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`,
  remove_worktree: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>`,
  integrate_branches: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 7 3 7 6"/></svg>`,
  push_branch: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7M3.5 13.5h9"/></svg>`,
  move_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/></svg>`,
  remember: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/></svg>`,
  change_settings: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 11.5h11"/><circle cx="5.5" cy="4.5" r="1.5"/><circle cx="10.5" cy="11.5" r="1.5"/></svg>`,
  save_task: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h7l2 2v9h-9z"/><path d="M5.5 2.5v3.5h4.5V2.5M5.5 13.5v-4h5v4"/></svg>`,
  run_trigger: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2 4 9h4l-1 5 5-7H8z"/></svg>`,
  save_pipeline: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.5"/><circle cx="12.5" cy="4" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><path d="M5 8h2.5c1.5 0 1.5-4 3.5-4M7.5 8c1.5 0 1.5 4 3.5 4"/></svg>`,
  set_pipeline_enabled: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="5" width="11" height="6" rx="3"/><circle cx="10.5" cy="8" r="1.5"/></svg>`,
  run_pipeline: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9l7-4.5z"/></svg>`,
  call_connector: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h8 M8 5l3 3-3 3 M13.5 3v10"/></svg>`,
  answer_run: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>`,
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
  remove_worktree: "Remove a worktree",
  integrate_branches: "Integrate branches",
  push_branch: "Push a branch",
  move_session: "Move a session",
  call_connector: "Call a connected tool",
};

const MEMORY_TITLES = { add: "Remember this", replace: "Change a memory", forget: "Forget a memory" };

const SETTINGS_AREAS = {
  dispatch: ["Dispatch", "/settings#dispatch"],
  triggers: ["Triggers", "/settings#triggers"],
  worktree_setup: ["Worktree setup", "/settings#worktree-setup"],
  agents: ["Agents", "/settings"],
  session_mcp_servers: ["MCP servers for sessions", "/settings#servers"],
  phone: ["Phone notifications", "/settings#phone"],
  machines: ["Machines", "/settings#machines"],
  pipelines: ["Pipelines", "/pipeline"],
  pull_requests: ["Pull requests", "/settings"],
};
const RUN_ACTIONS = { answer: "Answer", retry: "Retry", continue_pass: "Continue", continue_fail: "Continue", drop: "Drop" };
const RUN_DONE = { queued: "Queued", running: "Running again", waiting: "Still waiting", done: "Finished", dropped: "Dropped" };
const pipelineLink = (id, tab) => `/pipeline?p=${encodeURIComponent(id)}&tab=${tab}`;
const areaName = (area) => SETTINGS_AREAS[area]?.[0] || area;
const areaLink = (area) => SETTINGS_AREAS[area]?.[1] || "/settings";

const SEVERITY = { high: "High", medium: "Medium", low: "Low" };
const SEVERITY_ORDER = ["high", "medium", "low"];

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
const problems = new Map();
const working = new Map();
const expanded = new Set();
const picks = new Map();
const sending = new Set();
const diffs = new Map();
const targets = new Map();
const lowOpen = new Set();

export function setup(context) {
  ctx = context;
}

export const isWorking = (id) => working.has(id);
export const isEditing = (id) => drafts.has(id);
export function stopEditing(id) {
  drafts.delete(id);
  ctx.draw();
}
export function editorFor(e) {
  return editor(e);
}
export function markWorking(ids, decision) {
  for (const id of ids) {
    if (decision) working.set(id, decision);
    else working.delete(id);
  }
}

export function reset() {
  drafts.clear();
  working.clear();
  expanded.clear();
  picks.clear();
  sending.clear();
  diffs.clear();
  targets.clear();
  lowOpen.clear();
}

export function clock(stamp) {
  if (!stamp) return "";
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString()} ${time}`;
}

export function agentLabel(name) {
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

function stoppedShort(e) {
  return e.tool === "integrate_branches" && worktreeOutcome(e.tool, e.result?.text || "")?.stopped;
}

function badge(e, state) {
  const mine = e.by === "you";
  if (state === "done" && stoppedShort(e)) return html`<span class="badge blocked">Stopped at a conflict</span>`;
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
  if (e.tool === "remove_worktree") return html`<code>${i.folder || ctx.short(i.path)}</code> on ${i.machine}`;
  if (e.tool === "integrate_branches") {
    return html`${i.machine} · <code>${i.folder || ctx.short(i.path)}</code> · into <code>${i.into}</code>`;
  }
  if (e.tool === "push_branch") return html`<code>${i.branch}</code> on ${i.machine} to ${i.remote || "origin"}`;
  if (e.tool === "move_session") return html`<strong>${i.name}</strong> from ${i.machine} to ${i.to || "the machine with the most room"}`;
  if (e.tool === "remember") return "Dispatch's memory, read at the start of every turn";
  if (e.tool === "change_settings") return `Settings, ${areaName(i.area)}`;
  if (e.tool === "save_task") return i.before ? "A new version of a saved task" : "A new task";
  if (e.tool === "run_trigger") return "Runs it now, as Run now in Settings does";
  if (e.tool === "save_pipeline") return i.before ? `Pipelines, version ${i.before.version} to the next` : "Pipelines, a new pipeline, saved switched off";
  if (e.tool === "set_pipeline_enabled" || e.tool === "run_pipeline") return html`Pipelines, <code>${i.id}</code>`;
  if (e.tool === "answer_run") return `A run of ${i.pipeline}`;
  if (e.tool === "call_connector") return html`<strong>${i.connector}</strong> · <code>${i.call}</code>`;
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

function longText(id, text, brief = false) {
  const long = brief ? text.length > 200 || text.includes("\n") : text.length > 420 || text.split("\n").length > 6;
  const open = expanded.has(id);
  return html`<p class="step-card-text ${long && !open ? (brief ? "clamped brief" : "clamped") : ""}">${text}</p>
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
    case "remove_worktree":
      return html`<div class="step-card-body"><p class="step-card-text muted">Runs <code>git worktree remove</code> and prunes${i.delete_branch ? ", and deletes the branch if it is merged" : ""}. It is refused if the worktree has uncommitted changes or commits no remote has; only you can remove those, from the dashboard.</p></div>`;
    case "integrate_branches":
      return html`<div class="step-card-body"><p class="step-card-label">${i.method === "rebase" ? "Rebased" : "Merged"} in this order onto a new branch from <code>${i.base}</code></p>
        <ol class="step-card-list">${(i.branches || []).map((b) => html`<li><code>${b}</code></li>`)}</ol>
        <p class="step-card-text muted">It stops at the first conflict and pushes nothing.</p></div>`;
    case "push_branch":
      return html`<div class="step-card-body"><p class="step-card-text muted">Every commit it would push is checked for keys, tokens and your saved secrets first, and a hit stops it. Never forced.</p></div>`;
    case "remember":
      return memoryBody(i);
    case "change_settings":
    case "save_task":
    case "run_trigger":
      return changeBody(e);
    case "save_pipeline":
      return pipelineBody(e);
    case "set_pipeline_enabled":
    case "run_pipeline":
    case "answer_run":
      return runBody(e);
    case "move_session":
      return html`<div class="step-card-body"><p class="step-card-text muted">The branch and its uncommitted changes go over ssh; nothing is committed or pushed. The same agent starts there with the task${i.stop_original ? ", and the original stops" : ""}.</p>
        ${i.task ? html`<p class="step-card-label">Task</p>${longText(e.id || i.task, i.task)}` : nothing}</div>`;
    default:
      return nothing;
  }
}

// Long stretches that stay the same shrink to a few lines either side of a change.
function trimmed(text, first, last) {
  const lines = text.split("\n");
  const keep = 3;
  if (lines.length <= keep * 2 + 1) return text;
  const head = first ? [] : lines.slice(0, keep);
  const tail = last ? [] : lines.slice(-keep);
  return [...head, "  …", ...tail].join("\n");
}

function changeDiff(parts) {
  if (!parts?.length) return nothing;
  if (!parts.some((p) => p.op !== "same")) return html`<p class="step-card-text muted">Nothing changes from what is saved now.</p>`;
  return html`<div class="th-diff change-diff" role="group" aria-label="Changes">${parts.map((p, n) => p.op === "add"
    ? html`<ins><span class="visually-hidden">added </span>${p.text}</ins>`
    : p.op === "del"
      ? html`<del><span class="visually-hidden">removed </span>${p.text}</del>`
      : html`<span>${trimmed(p.text, n === 0, n === parts.length - 1)}</span>`)}</div>`;
}

const OUTCOME_WORDS = { pass: "pass", fail: "fail", needs_you: "needs you", start: "start" };

function pipelineBody(e) {
  const i = e.input || {};
  const c = i.changes || {};
  const lists = [
    c.trigger ? html`<li>The trigger changed: ${triggerWords(i.definition.trigger)}.</li>` : nothing,
    c.added?.length ? html`<li>Steps added: ${c.added.join(", ")}.</li>` : nothing,
    c.removed?.length ? html`<li>Steps removed: ${c.removed.join(", ")}.</li>` : nothing,
    ...(c.changed || []).map((x) => html`<li>${x.step}: ${x.fields.join(", ")} changed.</li>`),
  ];
  return html`<div class="step-card-body">
    <div class="step-card-pipeline">${canvas({ def: i.definition, key: `proposal-${e.id}` })}</div>
    ${lists.some((l) => l !== nothing) ? html`<ul class="step-card-list">${lists}</ul>` : nothing}
    ${c.lines?.length ? html`<ul class="step-card-list pipeline-lines">${c.lines.map((l) => html`<li>On ${OUTCOME_WORDS[l.outcome] || l.outcome}, ${l.from} went to ${l.was}, now goes to ${l.now}</li>`)}</ul>` : nothing}
    ${(c.wording || []).map((w) => html`<p class="step-card-label">${w.step}: instructions</p>${changeDiff(w.diff)}`)}
    <p class="step-card-text muted">A new or changed pipeline always waits for you.</p>
  </div>`;
}

function runBody(e) {
  const i = e.input || {};
  if (e.tool === "set_pipeline_enabled") {
    return html`<div class="step-card-body"><p class="step-card-text muted">${i.on ? "It starts runs on its own from now on, as its trigger says." : "It stops starting runs on its own; runs already going carry on."}</p></div>`;
  }
  if (e.tool === "run_pipeline") {
    const subjects = [...(i.tickets || []), ...(i.prs || [])];
    return html`<div class="step-card-body">
      ${subjects.length ? html`<ul class="step-card-list">${subjects.map((s) => html`<li>${/^https?:/.test(s) ? html`<a href=${s} target="_blank" rel="noopener">${s}</a>` : html`<code>${s}</code>`}</li>`)}</ul>`
        : html`<p class="step-card-text muted">One run with no ticket or pull request.</p>`}
    </div>`;
  }
  const w = i.waiting || {};
  return html`<div class="step-card-body">
    <div class="run-waiting">
      <p class="step-card-label">${i.subject}, at ${w.step}</p>
      <p class="step-card-text">${w.reason}</p>
      ${w.screen ? html`<details class="step-card-more"><summary>What the session showed</summary><p class="step-card-text step-card-mono">${w.screen}</p></details>` : nothing}
    </div>
    ${i.action === "answer" ? html`<p class="step-card-label">Answer</p><p class="step-card-text">${i.text}</p>` : nothing}
  </div>`;
}

function changeBody(e) {
  const i = e.input || {};
  if (e.tool === "run_trigger") {
    return html`<div class="step-card-body"><p class="step-card-text muted">A schedule starts its task in a new conversation now; a Linear or GitHub trigger checks for new items.</p></div>`;
  }
  const own = e.tool === "change_settings" && i.area === "dispatch"
    ? html`<p class="step-card-text muted">Dispatch's own settings always wait for you.</p>` : nothing;
  const shown = i.diff ? changeDiff(i.diff) : html`<p class="step-card-text step-card-mono">${e.tool === "save_task" ? i.text : JSON.stringify(i.value, null, 2)}</p>`;
  const secrets = i.secrets?.length
    ? html`<p class="step-card-text">It uses saved secrets: ${i.secrets.map((s, n) => html`${n ? ", " : ""}<code>${s}</code>`)}. A change that uses a saved secret always waits for you.</p>` : nothing;
  return html`<div class="step-card-body">${shown}${secrets}${own}</div>`;
}

// The change as a diff of the memory: the entry it removes and the one it adds.
function memoryBody(i) {
  const removed = i.change === "add" ? "" : i.old;
  const added = i.change === "forget" ? "" : i.entry;
  return html`<div class="step-card-body">
    <div class="memory-diff" role="group" aria-label="Change to the memory">
      ${removed ? html`<del class="memory-diff-line"><span class="memory-diff-mark" aria-hidden="true">-</span><span>${removed}</span></del>` : nothing}
      ${added ? html`<ins class="memory-diff-line"><span class="memory-diff-mark" aria-hidden="true">+</span><span>${added}</span></ins>` : nothing}
    </div>
    ${i.reason ? html`<p class="step-card-label">Why</p><p class="step-card-text">${i.reason}</p>` : nothing}
  </div>`;
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
  const problem = problems.get(e.id) ? html`<p class="step-card-outcome step-card-error" role="alert">${problems.get(e.id)}</p>` : nothing;
  if (e.tool === "change_settings") {
    return html`<div class="step-card-form">
      <label>${areaName(draft.area)}, as JSON<textarea class="step-card-json" rows=${Math.min(18, (draft.json || "").split("\n").length + 1)} spellcheck="false" .value=${draft.json ?? ""} @input=${(ev) => { draft.json = ev.target.value; }}></textarea></label>
      <p class="help">Leave each (hidden) as it is to keep what is saved.</p>
      ${problem}
    </div>`;
  }
  if (e.tool === "save_task") {
    return html`<div class="step-card-form">
      <label>${draft.name}<textarea rows="6" .value=${draft.text ?? ""} @input=${(ev) => { draft.text = ev.target.value; }}></textarea></label>
      ${problem}
    </div>`;
  }
  if (e.tool === "remember") {
    return html`<div class="step-card-form">
      ${draft.old ? html`<div class="memory-diff"><del class="memory-diff-line"><span class="memory-diff-mark" aria-hidden="true">-</span><span>${draft.old}</span></del></div>` : nothing}
      <label>${draft.change === "replace" ? "Becomes" : "Entry"}<textarea rows="3" maxlength="500" .value=${draft.entry ?? ""} @input=${(ev) => { draft.entry = ev.target.value; }}></textarea></label>
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

// The edited step goes back without the old diff, which no longer describes it.
function edited(e) {
  const draft = { ...drafts.get(e.id) };
  if (e.tool === "change_settings") {
    let value;
    try { value = JSON.parse(draft.json); } catch (err) { throw new Error(`This is not valid JSON: ${err.message}`); }
    return { area: e.input.area, value, before: e.input.before };
  }
  if (e.tool === "save_task") return { name: e.input.name, text: draft.text, before: e.input.before };
  for (const key of Object.keys(draft)) {
    if (draft[key] === "" && !(key in e.input)) delete draft[key];
    if (draft[key] === false && !(key in e.input)) delete draft[key];
  }
  if (!draft.new_branch) delete draft.base;
  return draft;
}

// Dispatch's steps live in a conversation; the Proposals page gives its own address for each.
const stepUrl = (e) => ctx.stepUrl?.(e) || `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/actions/${e.id}`;
const builderKey = (e) => ctx.builderKey?.(e) || `${ctx.conversation()}.${e.id}`;

export async function decide(e, decision) {
  const editingNow = decision === "approve" && drafts.has(e.id);
  let input = null;
  try {
    input = editingNow ? edited(e) : null;
  } catch (err) {
    problems.set(e.id, err.message);
    ctx.draw();
    return;
  }
  working.set(e.id, decision);
  ctx.draw();
  try {
    const step = await ctx.api("POST", stepUrl(e), { decision, ...(input ? { input } : {}) });
    drafts.delete(e.id);
    problems.delete(e.id);
    ctx.replaceStep(step);
    ctx.decided();
    if (step.result && !step.result.ok) ctx.toast(step.result.text);
  } catch (err) {
    if (editingNow && !/already|withdrawn/.test(err.message)) problems.set(e.id, err.message);
    else ctx.toast(err.message);
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

export function startEditing(e) {
  drafts.set(e.id, e.tool === "change_settings" ? { area: e.input.area, json: JSON.stringify(e.input.value, null, 2) } : { ...e.input });
  problems.delete(e.id);
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
  const said = worktreeOutcome(e.tool, r.text);
  if (said?.stopped) return html`<p class="step-card-outcome step-card-warn">${said.text}</p>`;
  if (said) return html`<p class="step-card-outcome">${ICONS.check}<span class="step-card-said">${said.text}</span>${s ? html`<a class="btn" href=${ctx.termUrl(s.machine, s.name)} target="_blank" rel="noopener" title="Open ${s.name}"><span class="btn-label">Open</span></a>` : nothing}</p>`;
  const v = parsed(r.text);
  if (e.tool === "change_settings") {
    return html`<p class="step-card-outcome">${ICONS.check}<span>Saved. Settings, Undo reverses it.</span><a class="btn" href=${areaLink(e.input.area)}><span class="btn-label">Open in Settings</span></a></p>
      ${v?.note ? html`<p class="step-card-outcome step-card-warn">${v.note}</p>` : nothing}`;
  }
  if (e.tool === "save_task") {
    const name = e.input.name;
    return html`<p class="step-card-outcome">${ICONS.check}<span>Saved as version ${v?.version ?? 1}</span><button class="btn" type="button" @click=${() => openHistory({ name, customised: true, api: ctx.api, toast: ctx.toast, changed: () => ctx.decided() })}><span class="btn-label">See task</span></button></p>`;
  }
  if (e.tool === "save_pipeline" && v) {
    return html`<p class="step-card-outcome">${ICONS.check}<span>Saved as version ${v.version}</span><a class="btn" href=${pipelineLink(v.saved, "build")}><span class="btn-label">Open pipeline</span></a></p>
      ${v.note ? html`<p class="step-card-outcome step-card-warn">${v.note} It replaced version ${v.replaced}.</p>` : nothing}`;
  }
  if (e.tool === "set_pipeline_enabled" && v) {
    return html`<p class="step-card-outcome">${ICONS.check}<span>${v.enabled ? "Turned on" : "Turned off"}</span><a class="btn" href=${pipelineLink(v.id, "build")}><span class="btn-label">Open pipeline</span></a></p>`;
  }
  if (e.tool === "run_pipeline" && v) {
    const n = v.runs?.length || 0;
    return html`<p class="step-card-outcome">${ICONS.check}<span>Started ${n} ${n === 1 ? "run" : "runs"}</span><a class="btn" href=${pipelineLink(e.input.id, "runs")}><span class="btn-label">Open runs</span></a></p>`;
  }
  if (e.tool === "answer_run" && v) {
    return html`<p class="step-card-outcome">${ICONS.check}<span>${RUN_DONE[v.state] || "Done"}</span></p>`;
  }
  if (e.tool === "run_trigger") {
    return html`<p class="step-card-outcome">${ICONS.check}<span>${v?.text || (v?.conversation ? "Started" : "Done")}</span>${v?.conversation ? html`<a class="btn" href=${`/dispatch?c=${encodeURIComponent(v.conversation)}`}><span class="btn-label">Open conversation</span></a>` : nothing}</p>`;
  }
  if (e.tool === "remember") {
    return html`<p class="step-card-outcome">${ICONS.check}<span>${e.input.change === "forget" ? "Forgotten" : "Saved to memory"}</span><a class="btn" href="/settings#dispatch-memory"><span class="btn-label">See memory</span></a></p>`;
  }
  const word = { send_to_session: "Sent", stop_session: "Stopped" }[e.tool] || "Done";
  return html`<p class="step-card-outcome">${ICONS.check}<span>${word}</span></p>`;
}

function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// What a worktree step did, from the result it returned. An integration that stopped at a conflict
// ran, but did not finish.
function worktreeOutcome(tool, text) {
  let v = null;
  try { v = JSON.parse(text); } catch { return null; }
  switch (tool) {
    case "remove_worktree": return { text: v.removed?.note || "Removed" };
    case "integrate_branches": return { text: v.summary || "Integrated", stopped: Boolean(v.integrated?.conflict) };
    case "push_branch": return { text: `Pushed ${v.pushed?.branch} to ${v.pushed?.remote}` };
    case "move_session": return { text: `Moved to ${v.machine} as ${v.name}${v.from?.stopped ? `; ${v.from.name} stopped` : ""}` };
    default: return null;
  }
}

const RULE_STEPS = { call_connector: "call connected tools", start_session: "start sessions", stop_session: "stop sessions", send_to_session: "type into sessions", review_session: "start reviews", scan_folder: "start scans", remove_worktree: "remove worktrees", integrate_branches: "integrate branches", push_branch: "push branches", move_session: "move sessions", remember: "change Dispatch's memory", change_settings: "change settings", save_task: "save tasks", run_trigger: "run triggers", save_pipeline: "save pipelines", set_pipeline_enabled: "turn pipelines on or off", run_pipeline: "run pipelines", answer_run: "answer runs" };
const UNPLACED = new Set(["call_connector", "remember", "change_settings", "save_task", "run_trigger", "save_pipeline", "set_pipeline_enabled", "run_pipeline", "answer_run"]);

export function ruleText(r) {
  if (UNPLACED.has(r.action)) return RULE_STEPS[r.action];
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
  if (e.by === "pipeline") parts.push(`Ran as part of the pipeline run started at ${clock(e.run_started || e.at)}`);
  else if (e.status === "auto") parts.push(`Ran without asking ${clock(e.at)}`);
  else if (e.by === "client") parts.push(`Proposed by ${e.from} ${clock(e.at)}`);
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
  const editable = ["start_session", "send_to_session", "change_settings", "save_task"].includes(e.tool) || (e.tool === "remember" && e.input?.change !== "forget");
  return html`<div class="step-card-actions">
    <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => decide(e, "reject")}>${mine ? "Cancel" : "Reject"}</button>
    ${e.tool === "change_settings" ? html`<a class="btn quiet" href=${areaLink(e.input?.area)}>Open in Settings</a>` : nothing}
    ${e.tool === "save_pipeline" ? html`<a class="btn" href=${`/pipeline?proposal=${encodeURIComponent(builderKey(e))}`}>${ICONS.edit}Edit in the builder</a>` : nothing}
    ${editable ? html`<button class="btn" type="button" ?disabled=${busy} @click=${() => startEditing(e)}>${ICONS.edit}Edit</button>` : nothing}
    <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decide(e, "approve")}>${ICONS.check}${mine ? mineWords(e).go : "Approve"}</button>
  </div>`;
}

function stepTitle(e) {
  const scan = scanOf(e.review);
  if (scan) return `Start a ${SCANS[scan].toLowerCase()}`;
  if (e.tool === "remember") return MEMORY_TITLES[e.input?.change] || MEMORY_TITLES.add;
  if (e.tool === "change_settings") return `Change Settings: ${areaName(e.input?.area)}`;
  if (e.tool === "save_task") return `Save the task ${e.input?.name || ""}`.trim();
  if (e.tool === "run_trigger") return `Run the trigger ${e.input?.name || ""}`.trim();
  if (e.tool === "save_pipeline") return `${e.input?.before ? "Change the pipeline" : "New pipeline:"} ${e.input?.definition?.name || ""}`.trim();
  if (e.tool === "set_pipeline_enabled") return `${e.input?.on ? "Turn on" : "Turn off"} ${e.input?.name || ""}`.trim();
  if (e.tool === "run_pipeline") return `Run ${e.input?.name || ""}`.trim();
  if (e.tool === "answer_run") {
    const a = e.input?.action;
    const how = a === "continue_pass" ? " as passed" : a === "continue_fail" ? " as failed" : "";
    return `${RUN_ACTIONS[a] || "Answer"} ${e.input?.subject || ""}${how}`.trim();
  }
  return e.review ? "Start a review" : TITLES[e.tool] || e.tool;
}

// A pipeline drawn on a card shows whole the first time it is on the page.
const fitted = new Set();

export function afterDraw() {
  const drawn = document.querySelectorAll(".step-card .pl-canvas");
  if (!drawn.length) return;
  fitCanvases();
  for (const c of drawn) {
    if (fitted.has(c.dataset.key)) continue;
    fitted.add(c.dataset.key);
    fitAll(c);
  }
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
  if (was("entry") !== (e.input.entry || "")) fields.push("entry");
  if ("value" in e.original && JSON.stringify(e.original.value) !== JSON.stringify(e.input.value)) fields.push("settings");
  return fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}` : fields[0] || "";
}

function editNote(e) {
  if (e.status !== "edited" || !e.original) return nothing;
  const what = changes(e);
  const proposed = e.original.prompt ?? e.original.text ?? e.original.entry;
  const differs = proposed !== undefined && proposed !== (e.input.prompt ?? e.input.text ?? e.input.entry);
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
  if (!picks.has(index)) picks.set(index, new Set((e.findings || []).flatMap((f, i) => (f.severity === "low" ? [] : [i]))));
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
    <span class="finding-text"><span>${f.text}</span>${place(e, index, f)}${shots(e, index, i)}</span>
  </label></li>`;
}

// Findings under one heading per severity, worst first. Low ones start folded, unless they are all
// there is or one of them is chosen.
function findingList(e, index, chosen, none) {
  const all = (e.findings || []).map((f, i) => ({ f, i }));
  if (!all.length) return html`<p class="step-card-text muted">${none}</p>`;
  const groups = [...SEVERITY_ORDER, ""]
    .map((sev) => ({ sev, items: all.filter(({ f }) => (sev ? f.severity === sev : !SEVERITY_ORDER.includes(f.severity))) }))
    .filter((g) => g.items.length);
  const onlyLow = groups.every((g) => g.sev === "low");
  return html`${groups.map((g) => {
    const word = html`<span class="sev-dot ${g.sev}" aria-hidden="true"></span>${SEVERITY[g.sev] || "Other"} · ${g.items.length}`;
    const folds = g.sev === "low" && !onlyLow;
    const open = !folds || lowOpen.has(index) || g.items.some(({ i }) => chosen.has(i));
    const head = folds
      ? html`<button class="finding-group-head" type="button" aria-expanded=${open ? "true" : "false"} @click=${() => { open ? lowOpen.delete(index) : lowOpen.add(index); ctx.draw(); }}>${ICONS.chevron}${word}</button>`
      : html`<p class="finding-group-head">${word}</p>`;
    return html`<section class="finding-group ${g.sev || "other"}">
      ${head}
      ${open ? html`<ul class="findings">${g.items.map(({ f, i }) => finding(e, index, f, i, chosen))}</ul>` : nothing}
    </section>`;
  })}`;
}

const findingWords = (n) => `${n} ${n === 1 ? "finding" : "findings"}`;

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
        @click=${() => settle(e, index, t.pick ? "send" : "start", t.pick)}><span class="btn-label">${t.pick ? `Send ${findingWords(count)}` : `Fix ${count} in a new session`}</span></button>`;
  }
  const foot = done
    ? html`<span class="step-card-trail">${decidedWords(done)}</span>`
    : html`<span class="step-card-trail">Finished ${clock(e.at)}</span>
      <div class="step-card-actions">
        <button class="btn" type="button" ?disabled=${busy} @click=${() => settle(e, index, "dismiss")}>Dismiss</button>
        ${send}
      </div>`;
  const folder = ctx.folderOf(of.path);
  return html`<article class="step-card review scan ${done ? "done" : verdict.tone === "done" ? "ready" : "pending"}" aria-label="${title} of ${folder}">
    <header class="step-card-head">
      <span class="step-card-icon">${ICONS.scan}</span>
      <div class="step-card-title">
        <strong>${title} of <code>${folder}</code></strong>
        <span class="step-card-where" title=${ctx.short(of.path)}>by <a href=${ctx.termUrl(e.machine, e.name)} target="_blank" rel="noopener">${e.name}</a> on ${e.machine}${of.branch ? html` · <code>${of.branch}</code>` : nothing}</span>
      </div>
      <span class="badge ${verdict.tone}">${verdict.word}</span>
    </header>
    <div class="step-card-body">
      ${e.summary ? longText(`summary:${index}`, e.summary, true) : nothing}
      ${findingList(e, index, chosen, "No issues found.")}
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
        ${findings.length ? html`<button class="btn primary" type="button" ?disabled=${busy || !count} title=${`Type the chosen findings into ${of.name} so it fixes them`} @click=${() => settle(e, index, "send")}><span class="btn-label">Send ${findingWords(count)}</span></button>` : nothing}
      </div>`;
  return html`<article class="step-card review ${done ? "done" : ready ? "ready" : "pending"}" aria-label="Review of ${of.branch || of.name}">
    <header class="step-card-head">
      <span class="step-card-icon">${ICONS.review}</span>
      <div class="step-card-title">
        <strong>Review of ${of.branch ? html`<code>${of.branch}</code>` : of.name}</strong>
        <span class="step-card-where" title=${of.path ? ctx.short(of.path) : nothing}>by <a href=${ctx.termUrl(e.machine, e.name)} target="_blank" rel="noopener">${e.name}</a> on ${e.machine}${of.path ? html` · <code>${ctx.folderOf(of.path)}</code>` : nothing}</span>
      </div>
      <span class="badge ${ready ? "done" : "blocked"}">${ready ? "Ready" : "Changes needed"}</span>
    </header>
    <div class="step-card-body">
      ${e.summary ? longText(`summary:${index}`, e.summary, true) : nothing}
      ${findingList(e, index, chosen, "No problems found.")}
      ${diffPanel(e, index)}
    </div>
    <footer class="step-card-foot">${decided}</footer>
  </article>`;
}
