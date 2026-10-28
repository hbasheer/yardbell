import { html, nothing } from "/vendor/lit-html/lit-html.js";

// Dispatch's steps that change something (start, stop or type into a session) and the results of
// reviews, drawn as cards the person approves, edits, rejects or acts on.

export const CHANGING = new Set(["start_session", "send_to_session", "stop_session", "review_session"]);

const ICONS = {
  start_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9l7-4.5z"/></svg>`,
  send_to_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8.5 12h5"/></svg>`,
  stop_session: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`,
  review: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg>`,
  check: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`,
  edit: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4z"/></svg>`,
};

const TITLES = {
  start_session: "Start a session",
  send_to_session: "Type into a session",
  stop_session: "Stop a session",
};

const SEVERITY = { high: "High", medium: "Medium", low: "Low" };

let ctx = null;
const drafts = new Map();
const working = new Map();
const expanded = new Set();
const picks = new Map();
const sending = new Set();

export function setup(context) {
  ctx = context;
}

export function reset() {
  drafts.clear();
  working.clear();
  expanded.clear();
  picks.clear();
  sending.clear();
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
    case "pending": return html`<span class="badge blocked">${mine ? "Not started" : "Waiting for you"}</span>`;
    case "running": return html`<span class="badge busy">Running</span>`;
    case "failed": return html`<span class="badge failed">Failed</span>`;
    case "rejected": return html`<span class="badge">${mine ? "Cancelled" : "Rejected"}</span>`;
    case "withdrawn": return html`<span class="badge">Withdrawn</span>`;
    default: return html`<span class="badge done">Done</span>`;
  }
}

function where(e) {
  const i = e.input || {};
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

function longText(id, text) {
  const long = text.length > 420 || text.split("\n").length > 6;
  const open = expanded.has(id);
  return html`<p class="step-card-text ${long && !open ? "clamped" : ""}">${text}</p>
    ${long ? html`<button class="link-btn" type="button" @click=${() => { open ? expanded.delete(id) : expanded.add(id); ctx.draw(); }}>${open ? "Show less" : "Show all"}</button>` : nothing}`;
}

function body(e) {
  const i = e.input || {};
  if (e.review) {
    return html`<div class="step-card-body">
      <p class="step-card-text">A new session in <code>${ctx.short(i.path)}</code> reviews this branch, runs the tests and changes no files. Its findings come back here.</p>
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
    <label>${e.review ? "Instructions for the reviewer" : "Task"}<textarea rows=${e.review ? 9 : 6} .value=${draft.prompt ?? ""} @input=${(ev) => { draft.prompt = ev.target.value; }}></textarea></label>
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

const RULE_STEPS = { start_session: "start sessions", stop_session: "stop sessions", send_to_session: "type into sessions", review_session: "start reviews" };

function ruleText(r) {
  const machine = !r.machine || r.machine === "any" ? "any machine" : r.machine;
  return `${RULE_STEPS[r.action] || "any step"} on ${machine}${r.folder ? ` in ${r.folder}` : ""}`;
}

function trail(e, state) {
  if (e.legacy) return "Ran without asking";
  const parts = [];
  const mine = e.by === "you";
  if (e.status === "auto") parts.push(`Ran without asking ${clock(e.at)}`);
  else parts.push(`${mine ? "You asked for this" : "Proposed by Dispatch"} ${clock(e.at)}`);
  if (e.rule) parts.push(`Your rule: ${ruleText(e.rule)}`);
  if (e.status === "approved") parts.push(`${mine ? "Started" : "Approved"} ${clock(e.decided)}`);
  if (e.status === "edited") parts.push(`Edited and ${mine ? "started" : "approved"} ${clock(e.decided)}`);
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
      <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decide(e, "approve")}>${ICONS.check}${mine ? "Start review" : "Approve with changes"}</button>
    </div>`;
  }
  const editable = e.tool !== "stop_session";
  return html`<div class="step-card-actions">
    <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => decide(e, "reject")}>${mine ? "Cancel" : "Reject"}</button>
    ${editable ? html`<button class="btn" type="button" ?disabled=${busy} @click=${() => startEditing(e)}>${ICONS.edit}Edit</button>` : nothing}
    <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decide(e, "approve")}>${ICONS.check}${mine ? "Start review" : "Approve"}</button>
  </div>`;
}

export function stepCard(e) {
  const state = stateOf(e);
  const icon = e.review ? ICONS.review : ICONS[e.tool] || ICONS.start_session;
  return html`<article class="step-card ${state}" aria-label=${e.review ? "Start a review" : TITLES[e.tool] || e.tool}>
    <header class="step-card-head">
      <span class="step-card-icon">${icon}</span>
      <div class="step-card-title">
        <strong>${e.review ? "Start a review" : TITLES[e.tool] || e.tool}</strong>
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

async function settle(e, index, decision) {
  const findings = [...picked(e, index)].sort((a, b) => a - b);
  sending.add(index);
  ctx.draw();
  try {
    const review = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/reviews/${index}`, { decision, findings });
    ctx.replaceAt(index, review);
    if (decision === "send") ctx.toast(`Sent ${findings.length} ${findings.length === 1 ? "finding" : "findings"} to ${e.of.name}`, "ok");
  } catch (err) {
    ctx.toast(err.message);
    if (/already/.test(err.message)) ctx.reload();
  } finally {
    sending.delete(index);
    ctx.draw();
  }
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
    <span class="finding-text">${f.place ? html`<code class="finding-place">${f.place}</code>` : nothing}<span>${f.text}</span></span>
  </label></li>`;
}

export function reviewCard(e, index) {
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
    </div>
    <footer class="step-card-foot">${decided}</footer>
  </article>`;
}
