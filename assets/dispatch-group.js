import { html, nothing } from "/vendor/lit-html/lit-html.js";
import * as steps from "/dispatch-review.js";

let ctx = null;
const deciding = new Set();
const reviewing = new Set();
const opened = new Set();

export function setup(context) {
  ctx = context;
}

export function reset() {
  deciding.clear();
  reviewing.clear();
  opened.clear();
}

const ICONS = {
  group: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.5"/><path d="M5 8h2.5M7.5 3.5v9M7.5 3.5h3M7.5 8h3M7.5 12.5h3"/><circle cx="12.5" cy="3.5" r="1.5"/><circle cx="12.5" cy="8" r="1.5"/><circle cx="12.5" cy="12.5" r="1.5"/></svg>`,
  results: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m2.5 4.5 1.3 1.3L6 3.5M2.5 10.5l1.3 1.3L6 9.5M8.5 4.5h5M8.5 10.5h5"/></svg>`,
  check: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`,
  edit: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4z"/></svg>`,
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");

export function minutes(n) {
  if (n % 60 === 0 && n >= 60) return plural(n / 60, "hour", "hours");
  return `${n} min`;
}

function stepOf(id) {
  return id ? ctx.events().find((e) => e.role === "action" && e.id === id) : null;
}

function live(session) {
  const state = ctx.state();
  if (!state || !session) return undefined;
  return state.sessions.find((s) => s.machine === session.machine && s.tmux === session.name && !s.stale) || null;
}

// One child as it stands now: its step, its session and how the person would describe it.
function childState(child) {
  if (child.refused) return { key: "refused", word: "Refused", tone: "failed" };
  const step = stepOf(child.step);
  if (!step) return { key: "lost", word: "Not started", tone: "" };
  if (steps.isWorking(step.id) || ((step.status === "approved" || step.status === "edited" || step.status === "auto") && !step.result)) {
    return { key: "starting", word: "Starting", tone: "busy", step };
  }
  if (step.status === "pending") return { key: "pending", word: "Waiting for you", tone: "blocked", step };
  if (step.status === "rejected") return { key: "rejected", word: "Rejected", tone: "", step };
  if (step.status === "withdrawn") return { key: "withdrawn", word: "Withdrawn", tone: "", step };
  if (!step.result.ok) return { key: "failed", word: "Failed to start", tone: "failed", step };
  const session = step.result.session;
  const s = live(session);
  // A session started a moment ago may not be in the last /state yet, so until it is, the card
  // goes by what the server last saw.
  const state = s ? (s.activity === "active" ? "working" : s.activity) : child.state || "started";
  const word = {
    working: ["Working", "busy"],
    blocked: ["Needs you", "blocked"],
    idle: child.worked ? ["Done", "done"] : ["Idle", ""],
    ended: ["Ended", ""],
  }[state] || ["Started", "busy"];
  return { key: state || "started", word: word[0], tone: word[1], step, session };
}

function where(input) {
  const folder = input.folder || ctx.short(input.path);
  return html`${input.machine}${folder ? html` · <code>${folder}</code>` : nothing}${input.branch ? html` · <code>${input.branch}</code>${input.new_branch ? " new" : ""}` : nothing} · ${steps.agentLabel(input.agent)}`;
}

function task(key, text) {
  if (!text) return nothing;
  const long = text.length > 220 || text.split("\n").length > 3;
  const open = opened.has(key);
  return html`<p class="step-card-text group-task ${long && !open ? "clamped" : ""}">${text}</p>
    ${long ? html`<button class="link-btn" type="button" @click=${() => { open ? opened.delete(key) : opened.add(key); ctx.draw(); }}>${open ? "Show less" : "Show all"}</button>` : nothing}`;
}

function childActions(st) {
  const step = st.step;
  if (st.key === "pending") {
    const busy = steps.isWorking(step.id);
    if (steps.isEditing(step.id)) {
      return html`<div class="group-child-actions">
        <button class="btn quiet" type="button" ?disabled=${busy} @click=${() => steps.stopEditing(step.id)}>Cancel</button>
        <button class="btn primary" type="button" ?disabled=${busy} @click=${() => steps.decide(step, "approve")}>${ICONS.check}Approve with changes</button>
      </div>`;
    }
    return html`<div class="group-child-actions">
      <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => steps.decide(step, "reject")}>Reject</button>
      <button class="btn" type="button" ?disabled=${busy} @click=${() => steps.startEditing(step)}>${ICONS.edit}Edit</button>
      <button class="btn" type="button" ?disabled=${busy} @click=${() => steps.decide(step, "approve")}>${ICONS.check}Approve</button>
    </div>`;
  }
  if (st.session && st.key !== "ended") {
    return html`<div class="group-child-actions">
      <a class="btn quiet" href=${ctx.termUrl(st.session.machine, st.session.name)} target="_blank" rel="noopener" title="Open ${st.session.name}">Open</a>
    </div>`;
  }
  return nothing;
}

function childRow(group, child, i) {
  const st = childState(child);
  const input = st.step?.input || child.input || {};
  const editing = st.key === "pending" && steps.isEditing(st.step.id);
  let note = nothing;
  if (child.refused) note = html`<p class="group-child-note bad">Not started: ${child.refused}.</p>`;
  else if (st.key === "failed") note = html`<p class="group-child-note bad">${st.step.result.text}</p>`;
  else if (st.session) note = html`<p class="group-child-note">${st.key === "ended" ? "Was" : "Running as"} <strong>${st.session.name}</strong> on ${st.session.machine}</p>`;
  const rule = st.step?.rule || child.rule;
  return html`<li class="group-child ${st.key}">
    <div class="group-child-head">
      <div class="group-child-id">
        <strong>${child.label}</strong>
        <span class="step-card-where">${where(input)}</span>
      </div>
      <span class="badge ${st.tone}">${st.word}</span>
    </div>
    ${editing ? steps.editorFor(st.step) : task(`${group.id}:${i}`, input.prompt)}
    ${note}
    ${rule ? html`<p class="group-child-rule">Your rule: ${steps.ruleText(rule)}</p>` : nothing}
    ${childActions(st)}
  </li>`;
}

async function decideAll(group, decision, pending) {
  deciding.add(group.id);
  steps.markWorking(pending.map((s) => s.id), decision);
  ctx.draw();
  try {
    const decided = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/groups/${group.id}`, { decision });
    for (const step of decided) ctx.replaceStep(step);
    ctx.decided();
    const failed = decided.filter((s) => s.result && !s.result.ok).length;
    if (failed) ctx.toast(`${failed} of ${plural(decided.length, "child", "children")} failed to start. Each row says why.`);
  } catch (err) {
    ctx.toast(err.message);
    ctx.reload();
  } finally {
    deciding.delete(group.id);
    steps.markWorking(pending.map((s) => s.id), null);
    ctx.draw();
  }
}

function groupBadge(group, states) {
  const waiting = states.filter((s) => s.key === "pending").length;
  if (waiting) return { word: waiting === states.length ? "Waiting for you" : `${waiting} wait for you`, tone: "blocked", edge: "pending" };
  if (group.status === "gathered") return { word: "Results below", tone: "done", edge: "done" };
  if (group.status === "dropped") return { word: "Nothing started", tone: "", edge: "" };
  if (group.status === "gathering") return { word: "Gathering", tone: "busy", edge: "running" };
  const started = states.filter((s) => s.session);
  const done = started.filter((s) => s.key === "ended" || s.tone === "done").length;
  if (!started.length) return { word: "Starting", tone: "busy", edge: "running" };
  return { word: `${done} of ${started.length} done`, tone: "busy", edge: "running" };
}

export function groupCard(group) {
  const children = group.children || [];
  const states = children.map(childState);
  const pending = states.filter((s) => s.key === "pending").map((s) => s.step);
  const badge = groupBadge(group, states);
  const busy = deciding.has(group.id) || pending.some((s) => steps.isWorking(s.id));
  const gather = !group.gather
    ? "Dispatch hears the results with your next message"
    : group.follow
      ? html`Then Dispatch acts on the results: ${group.gather}`
      : html`Dispatch hears the results with your next message, then: ${group.gather}`;
  const trail = [`Proposed by Dispatch ${steps.clock(group.at)}`];
  if (group.started) trail.push(`Running since ${steps.clock(group.started)}`);
  if (group.gathered) trail.push(`Gathered ${steps.clock(group.gathered)}`);
  return html`<article class="step-card group-card ${badge.edge}" aria-label=${`Group: ${group.title}`}>
    <header class="step-card-head">
      <span class="step-card-icon">${ICONS.group}</span>
      <div class="step-card-title">
        <strong>${group.title}</strong>
        <span class="step-card-where">${plural(children.length, "session", "sessions")} · gathered when all are done, or after ${minutes(group.minutes || 60)}</span>
      </div>
      <span class="badge ${badge.tone}">${badge.word}</span>
    </header>
    <ol class="group-children">${children.map((c, i) => childRow(group, c, i))}</ol>
    <p class="group-gather">${gather}.</p>
    <footer class="step-card-foot">
      <span class="step-card-trail">${trail.join(" · ")}</span>
      ${pending.length > 1 ? html`<div class="step-card-actions">
        <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => decideAll(group, "reject", pending)}>Reject all</button>
        <button class="btn primary" type="button" ?disabled=${busy} @click=${() => decideAll(group, "approve", pending)}>${ICONS.check}Approve all</button>
      </div>` : nothing}
    </footer>
  </article>`;
}

const RESULT = {
  done: { word: "Done", tone: "done" },
  partial: { word: "Partly done", tone: "blocked" },
  failed: { word: "Failed", tone: "failed" },
};

function resultBadge(c) {
  if (!c.started) return { word: "Did not start", tone: "" };
  if (c.result) return RESULT[c.result.status] || { word: c.result.status, tone: "" };
  if (c.state === "needs input") return { word: "Needs you", tone: "blocked" };
  if (c.state === "still working") return { word: "Still working", tone: "busy" };
  return { word: "No result", tone: "" };
}

async function review(index, i, c) {
  const key = `${index}:${i}`;
  reviewing.add(key);
  ctx.draw();
  try {
    const step = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/reviews`, { card: index, child: i });
    ctx.addStep(step);
    ctx.toast(`A review of ${c.branch || c.name} waits below for you to start it`, "ok");
  } catch (err) {
    ctx.toast(err.message);
  } finally {
    reviewing.delete(key);
    ctx.draw();
  }
}

function resultRow(e, index, c, i) {
  const badge = resultBadge(c);
  const r = c.result;
  const running = c.started && c.state !== "ended" && live({ machine: c.machine, name: c.name }) !== null;
  return html`<li class="group-child result">
    <div class="group-child-head">
      <div class="group-child-id">
        <strong>${c.label}</strong>
        <span class="step-card-where">${c.started
          ? html`${c.name} on ${c.machine}${c.branch ? html` · <code>${c.branch}</code>` : nothing}`
          : capital(c.note)}</span>
      </div>
      <span class="badge ${badge.tone}">${badge.word}</span>
    </div>
    ${r?.summary ? html`<p class="step-card-text">${r.summary}</p>` : nothing}
    ${r?.details?.length ? html`<ul class="group-details">${r.details.map((d) => html`<li>${d}</li>`)}</ul>` : nothing}
    ${c.started && !r ? html`<details class="step-card-more" ?open=${!c.screen ? false : c.state === "needs input"}>
      <summary>${c.screen ? "No result block. Where its screen ended" : "No result block, and no screen to show"}</summary>
      ${c.screen ? html`<pre class="session-screen">${c.screen}</pre>` : nothing}
    </details>` : nothing}
    ${c.started ? html`<div class="group-child-actions">
      ${running ? html`<a class="btn quiet" href=${ctx.termUrl(c.machine, c.name)} target="_blank" rel="noopener" title="Open ${c.name}">Open</a>` : nothing}
      <button class="btn" type="button" ?disabled=${reviewing.has(`${index}:${i}`)} title="Start a reviewer in the same folder that runs the tests and changes nothing" @click=${() => review(index, i, c)}>Review branch</button>
    </div>` : nothing}
  </li>`;
}

export function resultsCard(e, index) {
  const children = e.children || [];
  const started = children.filter((c) => c.started);
  const finished = started.filter((c) => c.result || c.state === "finished" || c.state === "ended").length;
  const timedOut = e.why === "timeout";
  const all = { 1: "The session is done", 2: "Both sessions are done" }[started.length] || `All ${started.length} sessions are done`;
  const head = timedOut
    ? `Gathered after ${minutes(e.minutes || 60)}, ${finished} of ${plural(started.length, "session", "sessions")} finished`
    : all;
  const then = e.follow
    ? html`Dispatch was asked to act on these results: ${e.gather}`
    : "Dispatch hears these results with your next message";
  return html`<article class="step-card results-card ${timedOut ? "pending" : "done"}" aria-label=${`Results: ${e.title}`}>
    <header class="step-card-head">
      <span class="step-card-icon">${ICONS.results}</span>
      <div class="step-card-title">
        <strong>Results of ${e.title}</strong>
        <span class="step-card-where">${head}</span>
      </div>
      <span class="badge ${timedOut ? "blocked" : "done"}">${timedOut ? "Timed out" : "All done"}</span>
    </header>
    <ol class="group-children">${children.map((c, i) => resultRow(e, index, c, i))}</ol>
    <footer class="step-card-foot">
      <span class="step-card-trail">Gathered ${steps.clock(e.at)} · ${then}.</span>
    </footer>
  </article>`;
}
