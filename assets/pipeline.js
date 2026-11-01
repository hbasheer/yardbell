import { html, render, nothing } from "/vendor/lit-html/lit-html.js";
import { canvas, settle, nodeState, triggerWords, setConnectors, icon, toWorld, centreOf, NODE_W, KINDS, WORDS } from "/pipeline-canvas.js";

const $ = (id) => document.getElementById(id);
const OUTCOMES = [["pass", "On pass"], ["fail", "On fail"], ["needs_you", "On needs you"]];
const ANSWERABLE = ["needs_you", "asking", "questions", "no_result"];
const SUBJECTLESS = ["manual", "schedule"];

let data = null;
let allRuns = [];
let def = null;
let draft = null;
let problems = [];
let versions = [];
let show = { waiting: false, settings: false, templates: false, runNow: false };
let settings = null;
let answers = new Map();
let subjects = "";
let busy = false;
// A pipeline Dispatch proposed, opened from its card: saving approves the step.
let proposal = null;

function toast(message, kind = "error") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 6000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("logged out"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out.error || `Request failed (${res.status})`);
    err.problems = out.problems || [];
    throw err;
  }
  return out;
}

async function doing(work) {
  busy = true;
  draw();
  try {
    await work();
  } catch (err) {
    toast(err.message);
  }
  busy = false;
  draw();
}

function params() {
  return new URLSearchParams(location.search);
}

function go(query) {
  history.pushState(null, "", query ? `${location.pathname}?${query}` : location.pathname);
  show = { waiting: false, settings: false, templates: false, runNow: false };
  problems = [];
  load().catch((err) => toast(err.message));
}

function ago(stamp) {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 60000));
  if (!stamp || Number.isNaN(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / 1440)} d`;
}

function clock(stamp) {
  const d = new Date(stamp);
  if (!stamp || Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function label(run) {
  const s = run.subject || {};
  const pr = s.pr ? `${s.pr.forge === "gitlab" ? "!" : "#"}${s.pr.number}` : "";
  const ticket = s.ticket ? `${s.ticket.id} ${s.ticket.title}`.trim() : "";
  return [pr, ticket].filter(Boolean).join(" ") || `Run started ${clock(run.started)}`;
}


const isStep = (d, id) => d.steps.some((s) => s.id === id);
const nameOf = (d, id) => d.steps.find((s) => s.id === id)?.name || id;

// The pass line from the start, with a step's fail line back to an earlier step, or to a step
// off the line, shown as a loop on it.
function flow(d) {
  const path = [];
  let id = d.start;
  while (isStep(d, id) && !path.includes(id)) {
    path.push(id);
    id = d.steps.find((s) => s.id === id).next.pass;
  }
  return path.map((id) => {
    const step = d.steps.find((s) => s.id === id);
    const fail = step.next.fail;
    const back = isStep(d, fail) && (!path.includes(fail) || path.indexOf(fail) <= path.indexOf(id));
    return back ? `${step.name} ⟲ ${nameOf(d, fail)}` : step.name;
  });
}

function counts(c) {
  const parts = [];
  if (c.running) parts.push(`${c.running} running`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.done) parts.push(`${c.done} done`);
  return parts.join(" · ") || "No runs yet";
}

function setEnabled(id, enabled) {
  doing(async () => {
    try {
      await api("POST", `/api/pipelines/${encodeURIComponent(id)}/enabled`, { enabled });
    } finally {
      await load();
    }
  });
}

function onOff(d) {
  return html`<input type="checkbox" class="switch" aria-label=${`${d.name} on`} title=${d.enabled ? "On" : "Off"}
    .checked=${d.enabled} ?disabled=${busy} @click=${(e) => e.stopPropagation()} @change=${(e) => {
      // lit only writes .checked when the saved value changes, so a refused switch would stay on.
      const want = e.target.checked;
      e.target.checked = !want;
      setEnabled(d.id, want);
    }}>`;
}

function card(p) {
  const d = p.definition;
  const steps = flow(d);
  return html`<article class="pl-card" data-id=${d.id} @click=${() => go(`p=${encodeURIComponent(d.id)}`)}>
    <div class="pl-card-head"><a class="pl-card-name" href=${`?p=${encodeURIComponent(d.id)}`} @click=${(e) => { e.preventDefault(); }}>${d.name}</a>${onOff(d)}</div>
    <p class="pl-trigger">${triggerWords(d.trigger)}</p>
    <ol class="pl-flow" aria-label="Steps">${steps.map((s, i) => html`${i ? html`<li class="pl-arrow" aria-hidden="true">→</li>` : nothing}<li>${s}</li>`)}</ol>
    ${p.problem ? html`<p class="pl-problem">${p.problem}</p>` : nothing}
    <div class="pl-card-foot"><span>${counts(p.runs)}</span><span class="pl-card-tags">${p.runs.waiting ? html`<span class="badge blocked">Needs you</span>` : nothing}<span class="pl-v">v${d.version}</span></span></div>
  </article>`;
}

const TEMPLATE_HINTS = {
  "Implement my tickets": "Plan, implement, review and fix, QA, push a draft, move the ticket, report",
  "Review my merge requests": "Understand, root cause, security, test on devbox, report",
};

function newPipeline(template) {
  doing(async () => {
    const d = await api("POST", "/api/pipelines", template ? { template } : { empty: true });
    go(`p=${encodeURIComponent(d.id)}&tab=build`);
  });
}

function waitingList() {
  const waiting = allRuns.filter((r) => r.state === "waiting");
  if (!waiting.length) return html`<p class="pl-empty">Nothing is waiting for you.</p>`;
  return html`<ul class="pl-wait-list">${waiting.map((r) => html`<li class="pl-wait-item">
    <button class="pl-wait-open" type="button" @click=${() => go(`p=${encodeURIComponent(r.pipeline)}&run=${encodeURIComponent(r.id)}`)}>
      <span class="pl-wait-label">${label(r)}</span>
      <span class="pl-wait-why">${r.pipeline_name} · ${r.waiting?.reason || "Waiting"} · ${ago(r.step_since)}</span>
    </button>
  </li>`)}</ul>`;
}

function settingsForm() {
  const s = settings;
  const set = (key, value) => { settings = { ...settings, [key]: value }; draw(); };
  const notes = s.notes;
  const setNote = (i, key, value) => { notes[i] = { ...notes[i], [key]: value }; draw(); };
  const save = () => doing(async () => {
    const qa_notes = Object.fromEntries(notes.filter((n) => n.folder.trim()).map((n) => [n.folder.trim(), n.note]));
    await api("PUT", "/api/pipelines/settings", { per_machine: Number(s.per_machine), minutes: Number(s.minutes), qa_notes });
    toast("Saved to yardbell.yml", "ok");
    show.settings = false;
    await load();
  });
  return html`<form class="pl-panel" id="pl-settings" @submit=${(e) => { e.preventDefault(); save(); }}>
    <div class="pl-fields">
      <label class="pl-field"><span>Agent steps at once on each machine</span>
        <input type="number" name="per_machine" min="1" max="6" .value=${String(s.per_machine)} @input=${(e) => set("per_machine", e.target.value)}></label>
      <label class="pl-field"><span>Minutes a step may run before it waits for you</span>
        <input type="number" name="minutes" min="10" max="1440" .value=${String(s.minutes)} @input=${(e) => set("minutes", e.target.value)}></label>
    </div>
    <div class="pl-notes">
      <p class="pl-field-head">QA notes per folder <span>Added to every agent step working in that folder, such as how to run its specs and console.</span></p>
      <ul>${notes.map((n, i) => html`<li class="pl-note">
        <input name="folder" placeholder="acme/web" aria-label="Folder" .value=${n.folder} @input=${(e) => setNote(i, "folder", e.target.value)}>
        <input name="note" placeholder="Run bin/rspec, then check the page in the browser" aria-label="Note" .value=${n.note} @input=${(e) => setNote(i, "note", e.target.value)}>
        <button class="btn quiet" type="button" aria-label="Remove this note" @click=${() => { notes.splice(i, 1); draw(); }}>Remove</button>
      </li>`)}</ul>
      <button class="btn" type="button" id="pl-note-add" @click=${() => { notes.push({ folder: "", note: "" }); draw(); }}>Add a note</button>
    </div>
    <div class="pl-panel-actions">
      <button class="btn quiet" type="button" @click=${() => { show.settings = false; draw(); }}>Cancel</button>
      <button class="btn primary" type="submit" id="pl-settings-save" ?disabled=${busy}>Save</button>
    </div>
  </form>`;
}

function listView() {
  const waiting = allRuns.filter((r) => r.state === "waiting").length;
  const openSettings = () => {
    const s = data.settings;
    settings = { per_machine: s.per_machine, minutes: s.minutes, notes: Object.entries(s.qa_notes || {}).map(([folder, note]) => ({ folder, note })) };
    show.settings = !show.settings;
    draw();
  };
  return html`
    <a class="back-link" href="/"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5"/></svg>Dashboard</a>
    <header class="main-head"><h1>Pipelines</h1>
      <div class="pl-head-actions">
        <button class="btn" type="button" id="pl-waiting-toggle" aria-pressed=${show.waiting ? "true" : "false"} @click=${() => { show.waiting = !show.waiting; draw(); }}>Waiting for me${waiting ? html` <span class="pl-count">${waiting}</span>` : nothing}</button>
        <button class="btn" type="button" id="pl-settings-open" aria-expanded=${show.settings ? "true" : "false"} @click=${openSettings}>Settings</button>
        <button class="btn primary" type="button" id="pl-new" aria-expanded=${show.templates ? "true" : "false"} @click=${() => { show.templates = !show.templates; draw(); }}><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>New pipeline</button>
      </div>
    </header>
    ${show.templates ? html`<div class="pl-panel" id="pl-templates">
      <p class="pl-field-head">New pipeline <span>It is saved switched off, so you can set its trigger and steps before it runs.</span></p>
      <div class="pl-template-list">
        <button class="pl-template pl-template-empty" type="button" data-empty ?disabled=${busy} @click=${() => newPipeline(null)}>
          <span class="pl-kind-icon">${icon("start")}</span><span><b>Empty pipeline</b><small>Start with nothing and build it on the canvas</small></span>
        </button>
        ${data.templates.map((t) => html`<button class="pl-template" type="button" ?disabled=${busy} @click=${() => newPipeline(t)}>
          <span class="pl-kind-icon">${icon("agent")}</span><span><b>${t}</b><small>${TEMPLATE_HINTS[t] || "A template"}</small></span>
        </button>`)}
      </div>
    </div>` : nothing}
    ${show.settings ? settingsForm() : nothing}
    ${show.waiting ? html`<section class="pl-section" id="pl-waiting" aria-label="Waiting for me">${waitingList()}</section>` : nothing}
    <section class="pl-cards" aria-label="Your pipelines">
      ${data.pipelines.map(card)}
      ${data.pipelines.length ? nothing : html`<p class="pl-empty">No pipelines yet. Start one from a template with New pipeline.</p>`}
    </section>`;
}

function runsOf(id) {
  return allRuns.filter((r) => r.pipeline === id);
}

function stateWord(run, d) {
  const step = nameOf(d, run.step);
  switch (run.state) {
    case "waiting": return `Waiting for you at ${step} · ${ago(run.step_since)}`;
    case "queued": return `${step}, queued`;
    case "running": return `${step} · ${ago(run.step_since)}`;
    case "done": return `Done ${clock(run.history?.at(-1)?.at || run.step_since)}`;
    default: return "Dropped";
  }
}

async function removeRun(run) {
  const going = !["done", "dropped"].includes(run.state);
  const lose = going ? "The run stops. Its agent sessions stop and close, and its record and reports go." : "Its record and reports go.";
  const keep = going ? "The worktree, the branch and any pull request stay." : "The branch and any pull request stay.";
  if (!(await ask("Delete this run?", `${lose} ${keep}`, { confirm: "Delete", danger: true }))) return;
  doing(async () => {
    await api("DELETE", `/api/runs/${encodeURIComponent(run.id)}`);
    const q = params();
    q.delete("run");
    history.replaceState(null, "", `${location.pathname}?${q}`);
    await load();
  });
}

function act(run, what, body) {
  doing(async () => {
    await api("POST", `/api/runs/${encodeURIComponent(run.id)}/${what}`, body || {});
    if (what === "answer") answers.delete(run.id);
    await load();
  });
}

function needBox(run, d) {
  const w = run.waiting || {};
  const answerable = ANSWERABLE.includes(w.kind);
  const open = (run.questions || []).filter((q) => !q.answer);
  const text = answers.get(run.id) || "";
  const step = d.steps.find((s) => s.id === w.step);
  const command = step?.kind === "command";
  const ran = run.steps?.[w.step]?.ran;
  const didRun = !!ran && ran.command === step?.command && step?.approved === step?.command;
  return html`<div class="pl-need" id="pl-need">
    <p>${(w.reason || "").startsWith(nameOf(d, w.step)) ? html`<b>${w.reason}</b>` : html`<b>${nameOf(d, w.step)}</b> · ${w.reason}`}</p>
    ${w.kind === "questions" && open.length ? html`<ol class="pl-questions">${open.map((q) => html`<li>${q.asked}</li>`)}</ol>` : nothing}
    ${w.kind === "no_result" ? html`<p class="help">The agent went quiet and Yardbell could not read a result from it. Show the terminal to see what it did, then retry the step, continue on pass or fail, or answer it.</p>` : nothing}
    ${w.screen ? html`<pre class="session-screen">${w.screen}</pre>` : nothing}
    ${command && !didRun ? html`<p class="help">This command has not run in this attempt, so the step cannot continue on pass.</p>` : nothing}
    ${command && didRun && !ran.passed ? html`<p class="help">This command failed. If you continue on pass, the run records that you overrode it.</p>` : nothing}
    ${answerable ? html`<label class="visually-hidden" for="pl-answer">Your answer</label>
      <textarea id="pl-answer" rows="3" placeholder="Your answer" .value=${text} @input=${(e) => { answers.set(run.id, e.target.value); draw(); }}></textarea>` : nothing}
    <div class="pl-need-actions">
      <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => act(run, "drop")}>Drop</button>
      ${w.kind === "tool_changed" ? html`<button class="btn primary" type="button" ?disabled=${busy} @click=${() => act(run, "accept-tool")}>Accept and run</button>` : html`<button class="btn" type="button" ?disabled=${busy} @click=${() => act(run, "retry")}>Retry step</button>`}
      <button class="btn" type="button" ?disabled=${busy} @click=${() => act(run, "continue", { outcome: "fail" })}>Continue on fail</button>
      ${command && !didRun ? nothing : html`<button class="btn" type="button" ?disabled=${busy} @click=${() => act(run, "continue", { outcome: "pass" })}>Continue on pass</button>`}
      ${answerable ? html`<button class="btn primary" type="button" ?disabled=${busy || !text.trim()} @click=${() => act(run, "answer", { text })}>Send answer</button>` : nothing}
    </div>
  </div>`;
}

function report(text) {
  const lines = (text || "").trim().split("\n");
  if (lines.length <= 3) return html`<p class="pl-report">${text}</p>`;
  return html`<details class="pl-report"><summary>${lines.slice(0, 2).join("\n")}</summary>${lines.slice(2).join("\n")}</details>`;
}

function detail(run, d) {
  const s = run.subject || {};
  const pr = s.pr;
  return html`<aside class="pl-detail">
    <div>
      <h3>${label(run)}</h3>
      <p class="pl-detail-meta">Started ${clock(run.started)} by ${run.started_by === "you" ? "you" : "a trigger"} · ${stateWord(run, d)}</p>
      <div class="pl-links">
        ${s.ticket?.url ? html`<a href=${s.ticket.url} target="_blank" rel="noopener">${s.ticket.id} in Linear</a>` : nothing}
        ${pr ? html`<a href=${pr.url} target="_blank" rel="noopener">${pr.forge === "gitlab" ? `Merge request !${pr.number}` : `Pull request #${pr.number}`}</a>` : nothing}
        ${run.pull ? html`<a href=${run.pull.url} target="_blank" rel="noopener">Draft #${run.pull.number}</a>` : nothing}
        ${run.conversation ? html`<a href=${`/dispatch?c=${encodeURIComponent(run.conversation)}`}>Conversation</a>` : nothing}
        ${run.place?.machine ? html`<span>${[run.place.machine, run.place.branch].filter(Boolean).join(" · ")}</span>` : nothing}
      </div>
    </div>
    ${run.state === "waiting" ? needBox(run, d) : nothing}
    ${run.teardown_problem ? html`<p class="pl-teardown-problem" role="alert">${run.teardown_problem}</p>` : nothing}
    <div class="pl-need-actions">
      ${["queued", "running"].includes(run.state) ? html`<button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => act(run, "drop")}>Stop this run</button>` : nothing}
      <button class="btn quiet danger" type="button" id="pl-delete-run" ?disabled=${busy} @click=${() => removeRun(run)}>Delete this run</button>
    </div>
    <ol class="pl-steps">${d.steps.filter((st) => run.steps?.[st.id]).map((st) => {
      const state = run.steps[st.id];
      const n = nodeState(run, st);
      return html`<li class=${`pl-st ${n.cls}`}>
        <span class="pl-mark" aria-hidden="true">${n.mark}</span>
        <div><span class="pl-st-name">${st.name}</span> <small>${n.note}</small>${state.overridden ? html` <small class="pl-overridden">Passed by a person after its command failed</small>` : nothing}${state.report ? report(state.report) : nothing}</div>
        <time>${clock(state.ended || state.started)}</time>
      </li>`;
    })}</ol>
    ${run.report ? html`<div class="pl-final"><p class="pl-field-head">Report</p><pre class="session-screen">${run.report}</pre></div>` : nothing}
  </aside>`;
}

// Which session's terminal is shown, per run, when the person picked one themselves.
const shownTerminal = new Map();

async function stopSession(run, t) {
  const after = t.current ? "The agent in it stops. The step then waits for you." : "The agent in it stops.";
  if (!(await ask(`Stop ${t.name}?`, after, { confirm: "Stop session", danger: true }))) return;
  doing(async () => {
    await api("POST", `/api/runs/${encodeURIComponent(run.id)}/stop-session`, { name: t.name });
    await load();
  });
}

function toggleTerminal() {
  terminalOpen = !terminalOpen;
  remember("yb-pipeline-terminal", terminalOpen);
  draw();
}

function terminal(run) {
  const list = run.terminals || [];
  if (!list.length) return html`<section class="pl-terminal empty"><p class="help">This run has no live session.</p></section>`;
  const shown = list.find((t) => t.name === shownTerminal.get(run.id)) || list.find((t) => t.current) || list[0];
  const src = `/term/${encodeURIComponent(shown.machine)}/${encodeURIComponent(shown.name)}`;
  return html`<section class="pl-terminal">
    <header class="pl-terminal-head">
      <button class="btn quiet small-link" type="button" id="pl-terminal-toggle" aria-expanded=${terminalOpen ? "true" : "false"} @click=${toggleTerminal}>${terminalOpen ? "Hide terminal" : "Show terminal"}</button>
      ${list.length > 1
        ? html`<div class="segmented pl-terminal-switch" role="group" aria-label="Sessions of this run">${list.map((t) => html`<button type="button" aria-pressed=${t === shown ? "true" : "false"} @click=${() => { shownTerminal.set(run.id, t.name); draw(); }}>${t.label}</button>`)}</div>`
        : html`<strong>${shown.label}</strong>`}
      <span class="pl-bar-space"></span>
      <a class="btn quiet small-link" href=${src} target="_blank" rel="noopener">Open</a>
      <button class="btn quiet danger small-link" type="button" id="pl-stop-session" ?disabled=${busy} @click=${() => stopSession(run, shown)}>Stop session</button>
    </header>
    ${terminalOpen ? html`<iframe class="pl-terminal-frame" title=${`Terminal of ${shown.label}`} src=${`${src}?embed=1`}></iframe>` : nothing}
  </section>`;
}

function runsTab(d) {
  const runs = runsOf(d.id);
  const chosen = runs.find((r) => r.id === params().get("run")) || runs[0];
  if (!runs.length) return html`<p class="pl-empty">No runs yet. ${SUBJECTLESS.includes(d.trigger.kind) ? "Run it now, or" : "Run it now with a ticket or link, or"} switch it on and let its trigger start one.</p>${canvas({ def: d, key: `${d.id}:${d.version}:` })}`;
  const pick = (r) => {
    const q = params();
    q.set("run", r.id);
    history.replaceState(null, "", `${location.pathname}?${q}`);
    draw();
  };
  const dot = { waiting: "wait", queued: "run", running: "run", done: "ok", dropped: "off" };
  return html`<div class="pl-run-view">
    <nav class="pl-run-list" aria-label="Runs">${runs.map((r) => html`<button type="button" class=${`pl-run-item ${r === chosen ? "sel" : ""}`} data-id=${r.id} aria-current=${r === chosen ? "true" : "false"} @click=${() => pick(r)}>
      <span class="pl-run-title"><span class=${`pl-dot ${dot[r.state] || "off"}`}></span>${label(r)}</span>
      <small>${stateWord(r, r.definition || d)}</small>
    </button>`)}</nav>
    <div class=${`pl-run-main ${terminalOpen && chosen.terminals?.length ? "" : "terminal-closed"}`}>
      ${canvas({ def: chosen.definition || d, run: chosen, key: `${d.id}:${chosen.version}:${chosen.id}` })}
      ${terminal(chosen)}
    </div>
    ${detail(chosen, chosen.definition || d)}
  </div>`;
}

function field(lbl, input, hint) {
  return html`<label class="pl-field"><span>${lbl}</span>${input}${hint ? html`<small>${hint}</small>` : nothing}</label>`;
}

function picks(list, chosen, onChange, name) {
  return html`<div class="pl-picks">${list.map((m) => html`<label class="check"><input type="checkbox" name=${name} .checked=${chosen.includes(m)}
    @change=${(e) => onChange(e.target.checked ? [...chosen, m] : chosen.filter((x) => x !== m))}>${m}</label>`)}</div>`;
}

function stepSelect(value, others, onChange, extra = []) {
  return html`<select @change=${(e) => onChange(e.target.value)}>
    ${extra.map(([v, l]) => html`<option value=${v} ?selected=${value === v}>${l}</option>`)}
    ${others.map((s) => html`<option value=${s.id} ?selected=${value === s.id}>${s.name}</option>`)}
  </select>`;
}

function agentFields(step, others, redraw) {
  const m = step.machine || { pick: [] };
  const mode = "name" in m ? "name" : "same_as" in m ? "same_as" : "pick";
  const setMachine = (value) => { step.machine = value; redraw(); };
  const ws = step.workspace || { kind: "new_worktree" };
  return html`
    ${field("Instructions", html`<textarea name="instructions" rows="5" .value=${step.instructions || ""} @input=${(e) => { step.instructions = e.target.value; redraw(); }}></textarea>`,
      "Fill in {ticket}, {title}, {url}, {description}, {branch}, {pr}, {report} or {report:Step name}.")}
    <div class="pl-fields">
      ${field("Agent", html`<select name="agent" @change=${(e) => { step.agent = e.target.value; redraw(); }}>
        <option value="" ?selected=${!step.agent}>Your default agent</option>
        ${data.agents.map((a) => html`<option value=${a} ?selected=${step.agent === a}>${a}</option>`)}
      </select>`)}
      ${field("Machine", html`<select name="machine_mode" @change=${(e) => setMachine(e.target.value === "name" ? { name: data.machines[0] || "" } : e.target.value === "same_as" ? { same_as: others[0]?.id || "" } : { pick: [] })}>
        <option value="pick" ?selected=${mode === "pick"}>Dispatch picks it</option>
        <option value="name" ?selected=${mode === "name"}>Always this machine</option>
        <option value="same_as" ?selected=${mode === "same_as"}>The machine of another step</option>
      </select>`)}
      ${mode === "name" ? field("Which machine", html`<select name="machine" @change=${(e) => setMachine({ name: e.target.value })}>${data.machines.map((x) => html`<option value=${x} ?selected=${m.name === x}>${x}</option>`)}</select>`) : nothing}
      ${mode === "same_as" ? field("Same machine as", stepSelect(m.same_as, others, (v) => setMachine({ same_as: v }))) : nothing}
    </div>
    ${mode === "pick" ? field("Dispatch may pick from", picks(data.machines, m.pick || [], (list) => setMachine({ pick: list }), "pick"), "None ticked means any machine.") : nothing}
    <div class="pl-fields">
      ${field("Works in", html`<select name="workspace" @change=${(e) => { const k = e.target.value; step.workspace = k === "new_worktree" ? { kind: k } : k === "same_as" ? { kind: k, step: others[0]?.id || "" } : { kind: k, from: others[0]?.id || "" }; redraw(); }}>
        <option value="new_worktree" ?selected=${ws.kind === "new_worktree"}>A new worktree on the run's branch</option>
        <option value="same_as" ?selected=${ws.kind === "same_as"}>The folder of another step</option>
        <option value="copy" ?selected=${ws.kind === "copy"}>A copy of another step's branch</option>
      </select>`)}
      ${ws.kind === "same_as" ? field("Folder of", stepSelect(ws.step, others, (v) => { step.workspace = { kind: "same_as", step: v }; redraw(); })) : nothing}
      ${ws.kind === "copy" ? field("Copy of", stepSelect(ws.from, others, (v) => { step.workspace = { kind: "copy", from: v }; redraw(); })) : nothing}
    </div>
    <label class="check"><input type="checkbox" name="read_only" .checked=${!!step.read_only} @change=${(e) => { step.read_only = e.target.checked; redraw(); }}>Review: new read-only session. Other steps share the run's one session.</label>
    ${data.mcp_servers.length ? field("MCP servers", picks(data.mcp_servers, step.mcp_servers || [], (list) => { step.mcp_servers = list; redraw(); }, "mcp"), "An agent signs in to a server itself, on its own machine. Signing in here is for Yardbell's own steps. Saved with the step; agents do not get them yet.") : nothing}`;
}

// What a connection's lists hold, kept per address so a redraw does not ask again.
const connectorChoices = new Map();

function choicesFor(id, call, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  const url = `/api/settings/connectors/${encodeURIComponent(id)}/options/${encodeURIComponent(call)}${query ? `?${query}` : ""}`;
  if (!connectorChoices.has(url)) {
    connectorChoices.set(url, { loading: true });
    api("GET", url)
      .then((list) => connectorChoices.set(url, { list }), (err) => connectorChoices.set(url, { error: err.message }))
      .finally(draw);
  }
  return connectorChoices.get(url);
}

const NO_CONNECTIONS = html`<p class="help">No connections yet. Add one under <a href="/settings#connections">Settings, Connections</a>.</p>`;

function connectionField(step, redraw) {
  const value = step.kind === "tool" ? `server:${step.server}` : `connector:${step.connector}`;
  const pick = (chosen) => {
    const [kind, name] = [chosen.slice(0, chosen.indexOf(":")), chosen.slice(chosen.indexOf(":") + 1)];
    for (const key of ["connector", "call", "params", "server", "tool", "arguments", "call_kind", "schema_hash"]) delete step[key];
    if (kind === "server") Object.assign(step, { kind: "tool", server: name, tool: "", arguments: {}, call_kind: "change", schema_hash: "" });
    else Object.assign(step, { kind: "call", connector: name, call: "", params: {} });
    redraw();
  };
  return field("Connection", html`<select name="connection" @change=${(e) => pick(e.target.value)}>
    ${data.connectors.length ? html`<optgroup label="Actions you set up">${data.connectors.map((c) => html`<option value=${`connector:${c.id}`} ?selected=${value === `connector:${c.id}`}>${c.name}</option>`)}</optgroup>` : nothing}
    ${data.mcp_servers.length ? html`<optgroup label="Any tool on a signed-in server">${data.mcp_servers.map((m) => html`<option value=${`server:${m}`} ?selected=${value === `server:${m}`}>${m}</option>`)}</optgroup>` : nothing}
  </select>`);
}

function updateFields(step, redraw) {
  const t = draft.trigger;
  const from = t.kind === "connector" || (t.kind === "schedule" && t.connector) ? data.connectors.find((c) => c.id === t.connector) : null;
  const typed = field("To the state", html`<input name="state" .value=${step.state || ""} @input=${(e) => { step.state = e.target.value; redraw(); }}>`, "The state's name in Linear, or its id in another tool.");
  let target = typed;
  if (from?.calls.some((c) => c.name === "states")) {
    const found = choicesFor(from.id, "states", t.params);
    if (found.list) {
      target = field("To the state", html`<select name="state" @change=${(e) => { step.state = e.target.value; redraw(); }}>
        <option value="" ?selected=${!step.state}>Pick a state</option>
        ${found.list.map((s) => html`<option value=${s.id} ?selected=${s.id === step.state}>${s.name}</option>`)}
      </select>`);
    }
  }
  return html`<div class="pl-fields">
    ${field("Action", html`<select name="action" @change=${(e) => { step.action = e.target.value; redraw(); }}>
      <option value="move" ?selected=${step.action === "move"}>Move the ticket</option>
      <option value="comment" ?selected=${step.action === "comment"}>Comment with the run's report</option>
    </select>`, "It uses whichever connection started the run. In Linear, a comment is drafted for you to post.")}
    ${step.action === "move" ? target : nothing}
  </div>`;
}

function connectorSelect(value, change) {
  return html`<select name="connector" @change=${(e) => change(e.target.value)}>
    ${value && !data.connectors.some((c) => c.id === value) ? html`<option value=${value} selected>${value}</option>` : nothing}
    ${data.connectors.map((c) => html`<option value=${c.id} ?selected=${c.id === value}>${c.name}${c.enabled ? "" : " (switched off)"}</option>`)}
  </select>`;
}

function statePicks(t, connector, redraw) {
  const setStates = (list) => { t.states = list; redraw(); };
  const typed = field("In the states", html`<input name="states" placeholder="Empty means every item" .value=${(t.states || []).join(", ")}
    @change=${(e) => setStates(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))}>`, "Empty means every item.");
  if (!connector.calls.some((c) => c.name === "states")) return typed;
  const found = choicesFor(connector.id, "states", t.params);
  if (found.loading) return html`<p class="help">Reading ${connector.name}...</p>`;
  if (found.error) return html`${typed}<p class="help">The choices could not be read. Pick the other options first, or type the ids here.</p>`;
  const chosen = t.states || [];
  return field("In the states", html`<div class="pl-state-list">${found.list.map((s) => html`<label class="check pl-state-pick"><input type="checkbox" value=${s.id} .checked=${chosen.includes(s.id)}
    @change=${(e) => setStates(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))}>${s.name}</label>`)}</div>`, "None ticked means every item.");
}

function connectorFields(t, redraw) {
  if (!data.connectors.length) return NO_CONNECTIONS;
  const connector = data.connectors.find((c) => c.id === t.connector);
  const params = t.params || (t.params = {});
  const setParam = (name, value) => {
    if (value) params[name] = value;
    else delete params[name];
    t.states = [];
    redraw();
  };
  return html`
    ${paramFields(connector, params, setParam)}
    ${connector ? statePicks(t, connector, redraw) : nothing}`;
}

function paramFields(connector, params, setParam) {
  const needed = connector?.calls?.find((c) => c.name === "list")?.needs || [];
  return html`${(connector?.params || []).map((p) => {
      if (!p.options) {
        return field(p.label || p.name, html`<input name=${`param-${p.name}`} .value=${params[p.name] || ""} @change=${(e) => setParam(p.name, e.target.value.trim())}>`);
      }
      const found = choicesFor(connector.id, p.options);
      return field(p.label || p.name, html`<select name=${`param-${p.name}`} @change=${(e) => setParam(p.name, e.target.value)}>
        <option value="" ?selected=${!params[p.name]}>${needed.includes(p.name) ? "Pick one" : "Any"}</option>
        ${params[p.name] && !found.list?.some((o) => o.id === params[p.name]) ? html`<option value=${params[p.name]} selected>${params[p.name]}</option>` : nothing}
        ${(found.list || []).map((o) => html`<option value=${o.id} ?selected=${o.id === params[p.name]}>${o.name}</option>`)}
      </select>`, found.error ? "The choices could not be read. Test the connection in Settings." : "");
    })}`;
}

let hookAddress = null;

function newHookAddress(d) {
  doing(async () => {
    hookAddress = await api("POST", `/api/pipelines/${encodeURIComponent(d.id)}/webhook-token`);
  });
}

function webhookFields(d, redraw) {
  const t = d.trigger;
  const map = t.map || (t.map = {});
  const address = hookAddress?.url || (hookAddress ? `/hooks/pipeline/${d.id}/${hookAddress.token}` : "");
  return html`<p class="help">Yardbell listens on this machine and your mesh. An outside service cannot reach this address without a tunnel you set up.</p>
    ${address ? html`<p class="pl-hook-address"><code>${address}</code></p><p class="help">Copy it now: it is shown only this once. It works once this is saved and switched on.</p>` : nothing}
    <button class="btn" type="button" id="pl-hook-new" ?disabled=${busy} @click=${() => newHookAddress(d)}>New address</button>
    <p class="help">A new address replaces the old one. The body is JSON with <code>id</code> and <code>title</code>, and optional <code>url</code> and <code>description</code>. If yours differs, name where each one is:</p>
    ${["id", "title", "url", "description"].map((name) => field(name, html`<input name=${`map-${name}`} placeholder=${name} .value=${map[name] || ""} autocapitalize="off" spellcheck="false"
      @change=${(e) => { if (e.target.value.trim()) map[name] = e.target.value.trim(); else delete map[name]; redraw(); }}>`))}`;
}

function callFields(step, redraw) {
  if (!data.connectors.length && !data.mcp_servers.length) return NO_CONNECTIONS;
  const connector = data.connectors.find((c) => c.id === step.connector);
  const call = connector?.calls.find((c) => c.name === step.call);
  const params = step.params || (step.params = {});
  return html`<div class="pl-fields">
    ${field("Call", html`<select name="call" @change=${(e) => { step.call = e.target.value; redraw(); }}>
      <option value="" ?selected=${!step.call}>Pick a call</option>
      ${(connector?.calls || []).map((c) => html`<option value=${c.name} ?selected=${c.name === step.call}>${c.name}, ${c.kind === "lookup" ? "reads" : "changes"}</option>`)}
    </select>`, call?.kind === "change" ? "It changes something in the tool, and your Dispatch rules can refuse it." : "")}
    ${(call?.needs || []).map((name) => field(name, html`<input name=${`param-${name}`} .value=${params[name] || ""} @input=${(e) => { params[name] = e.target.value; redraw(); }}>`, "You can use {{ticket}}, {{title}}, {{url}}, {{branch}} and {{report}}."))}
  </div>`;
}

// What each server offers, kept per name so a redraw does not ask again.
const serverTools = new Map();

function toolsOf(server, redraw) {
  if (!server) return { tools: [] };
  if (!serverTools.has(server)) {
    serverTools.set(server, { loading: true, tools: [] });
    api("GET", `/api/settings/mcp/servers/${encodeURIComponent(server)}/tools`)
      .then((out) => serverTools.set(server, { tools: out.tools }))
      .catch((err) => serverTools.set(server, { error: err.message, tools: [] }))
      .finally(redraw);
  }
  return serverTools.get(server);
}

function argumentField(step, name, schema, required, redraw) {
  const args = step.arguments || (step.arguments = {});
  const hint = [required ? "Required." : "", schema.description || ""].filter(Boolean).join(" ");
  if (schema.type === "string" && !schema.enum) {
    return field(name, html`<input name=${`arg-${name}`} .value=${args[name] ?? ""} placeholder="{{ticket}} fills in from the run" @input=${(e) => {
      if (e.target.value) args[name] = e.target.value;
      else delete args[name];
    }}>`, hint);
  }
  const shown = args[name] === undefined ? "" : JSON.stringify(args[name], null, 2);
  return field(`${name} (JSON)`, html`<textarea name=${`arg-${name}`} rows="3" spellcheck="false" .value=${shown} @change=${(e) => {
    const text = e.target.value.trim();
    if (!text) { delete args[name]; return; }
    try {
      args[name] = JSON.parse(text);
      e.target.setCustomValidity("");
    } catch {
      e.target.setCustomValidity("This is not valid JSON");
      e.target.reportValidity();
    }
  }}></textarea>`, hint);
}

function toolFields(step, redraw) {
  const listed = toolsOf(step.server, redraw);
  const tool = listed.tools.find((t) => t.name === step.tool);
  const properties = tool?.input_schema?.properties || {};
  const required = tool?.input_schema?.required || [];
  const choose = (name) => {
    const picked = listed.tools.find((t) => t.name === name);
    step.tool = name;
    step.arguments = {};
    step.schema_hash = picked?.schema_hash || "";
    step.call_kind = picked?.read_only_hint ? "lookup" : "change";
    redraw();
  };
  return html`<div class="pl-fields">
    ${listed.error || listed.loading ? html`<p class="help">${listed.error || "Asking the server for its tools."}</p>` : nothing}
    ${field("Tool", html`<select name="tool" @change=${(e) => choose(e.target.value)}>
      <option value="" ?selected=${!step.tool}>Pick a tool</option>
      ${listed.tools.map((t) => html`<option value=${t.name} ?selected=${t.name === step.tool}>${t.name}</option>`)}
    </select>`, tool?.description || "")}
    ${tool ? Object.entries(properties).map(([name, schema]) => argumentField(step, name, schema, required.includes(name), redraw)) : nothing}
    ${tool ? html`<label class="check"><input type="checkbox" name="only_reads" .checked=${step.call_kind === "lookup"} @change=${(e) => { step.call_kind = e.target.checked ? "lookup" : "change"; redraw(); }}>Only reads</label>
      <small class="help">A tool's own label is only a hint, so check it. A step that changes things can be refused by your Dispatch rules.</small>` : nothing}
  </div>`;
}

// Typing a command is a person writing it, so it counts as approved. One an agent proposed stays
// unapproved until a person says so here or when a run reaches it. A proposal's edits go through
// the same check as the agent's own text, so nothing can be approved until it is saved.
function commandFields(step, redraw) {
  const waiting = step.command && step.approved !== step.command;
  return html`${field("Command", html`<textarea name="command" class="mono" rows="3" spellcheck="false" autocapitalize="off" .value=${step.command || ""} @input=${(e) => { step.command = e.target.value; if (!proposal) step.approved = e.target.value; redraw(); }}></textarea>`,
      "Runs in your login shell in the run's worktree, on its machine. Exit 0 follows the pass line and anything else follows the fail line. The end of its output is the step's report, so a later step can read it with {report}. It takes no placeholders. Join several commands with &&, because only the last one's exit counts otherwise.")}
    ${waiting ? html`<div class="pl-approve-command">
      <p class="help">Nobody has approved this command yet, so a run stops here and shows it to you first.${proposal ? " You can accept it then." : ""}</p>
      ${proposal ? nothing : html`<button class="btn" type="button" name="approve-command" @click=${() => { step.approved = step.command; redraw(); }}>Approve this command</button>`}
    </div>` : nothing}`;
}

function kindFields(step, others, redraw) {
  switch (step.kind) {
    case "call": return html`${connectionField(step, redraw)}${callFields(step, redraw)}`;
    case "tool": return html`${connectionField(step, redraw)}${toolFields(step, redraw)}`;
    case "agent": return agentFields(step, others, redraw);
    case "plan": return field("Dispatch may pick from", picks(data.machines, step.machines || [], (list) => { step.machines = list; redraw(); }, "plan"), "None ticked means any machine.");
    case "update": return updateFields(step, redraw);
    case "command": return commandFields(step, redraw);
    case "wait": return field("Message", html`<textarea name="message" rows="2" .value=${step.message || ""} @input=${(e) => { step.message = e.target.value; redraw(); }}></textarea>`);
    default: return nothing;
  }
}

// A renamed step keeps the {report:Name} placeholders that point at it.
function rename(d, step, name) {
  const old = step.name.trim();
  step.name = name;
  if (!old) return;
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const placeholder = new RegExp(`\\{report:\\s*${escaped}\\s*\\}`, "gi");
  for (const s of d.steps) {
    if (s.kind === "agent" && s.instructions) s.instructions = s.instructions.replace(placeholder, `{report:${name.trim()}}`);
  }
}

function stepForm(step, d, redraw) {
  const others = d.steps.filter((s) => s.id !== step.id);
  const targets = [["end", "End the run"], ["wait", "Wait for me"]];
  return html`<fieldset class="pl-step-form" data-step=${step.id}>
    <legend>${step.name || step.id} <span>${KINDS[step.kind]}</span></legend>
    <div class="pl-fields">
      ${field("Name", html`<input name="name" .value=${step.name} @input=${(e) => { rename(d, step, e.target.value); redraw(); }}>`)}
      ${field("Runs at most", html`<input type="number" name="max_runs" min="1" max="10" .value=${String(step.max_runs ?? 2)} @input=${(e) => { step.max_runs = Number(e.target.value); redraw(); }}>`)}
      ${step.kind === "agent" ? field("Minutes", html`<input type="number" name="minutes" min="10" max="1440" placeholder=${String(data.settings.minutes)} .value=${step.minutes == null ? "" : String(step.minutes)}
        @input=${(e) => { step.minutes = e.target.value === "" ? null : Number(e.target.value); redraw(); }}>`) : nothing}
      ${step.kind === "command" ? field("Stop after minutes", html`<input type="number" name="minutes" min="1" max="1440" placeholder="10" .value=${step.minutes == null ? "" : String(step.minutes)}
        @input=${(e) => { step.minutes = e.target.value === "" ? null : Number(e.target.value); redraw(); }}>`) : nothing}
    </div>
    ${kindFields(step, others, redraw)}
    <div class="pl-fields pl-next">${OUTCOMES.map(([o, lbl]) => field(lbl, stepSelect(step.next[o], others, (v) => { step.next[o] = v; redraw(); }, targets)))}</div>
  </fieldset>`;
}

function triggerFields(d, redraw) {
  const t = d.trigger;
  const kinds = [["manual", "By hand"], ["schedule", "On a schedule"], ["linear", "New ticket from a connection"], ["webhook", "A webhook"], ["github_review", "A GitHub review request"], ["gitlab_reviewer", "A GitLab merge request reviewer"]];
  const setKind = (k) => {
    d.trigger = newTrigger(k);
    redraw();
  };
  return html`<fieldset class="pl-step-form pl-trigger-form">
    <legend>Start when</legend>
    <div class="pl-fields">
      ${field("Starts", html`<select name="trigger" @change=${(e) => setKind(e.target.value)}>${kinds.map(([k, l]) => html`<option value=${k} ?selected=${t.kind === k || (k === "linear" && t.kind === "connector")}>${l}</option>`)}</select>`)}
      ${t.kind === "linear" || t.kind === "connector" ? field("From", html`<select name="ticket-source" @change=${(e) => {
        d.trigger = e.target.value === "linear" ? newTrigger("linear") : { kind: "connector", connector: e.target.value, params: {}, states: [] };
        redraw();
      }}>
        <option value="linear" ?selected=${t.kind === "linear"}>Linear</option>
        ${data.connectors.map((c) => html`<option value=${c.id} ?selected=${t.kind === "connector" && t.connector === c.id}>${c.name}</option>`)}
      </select>`) : nothing}
      ${t.kind === "schedule" ? html`
        ${field("Schedule", html`<input name="schedule" placeholder="weekdays 02:00" .value=${t.schedule || ""} @input=${(e) => { t.schedule = e.target.value; redraw(); }}>`)}
        ${field("With my open tickets in", html`<input name="state" placeholder="Todo, or empty for none" .value=${t.state || ""} @input=${(e) => { t.state = e.target.value; redraw(); }}>`)}` : nothing}
      ${t.kind === "schedule" && data.connectors.length ? field("Read them from", html`<select name="schedule-source" @change=${(e) => { t.connector = e.target.value; redraw(); }}>
        <option value="" ?selected=${!t.connector}>Linear</option>
        ${data.connectors.map((c) => html`<option value=${c.id} ?selected=${c.id === t.connector}>${c.name}</option>`)}
      </select>`) : nothing}
      ${t.kind === "schedule" && t.connector ? paramFields(data.connectors.find((c) => c.id === t.connector), t.params || (t.params = {}), (name, value) => { if (value) t.params[name] = value; else delete t.params[name]; redraw(); }) : nothing}
      ${t.kind === "connector" ? connectorFields(t, redraw) : nothing}
      ${t.kind === "webhook" ? webhookFields(d, redraw) : nothing}
      ${t.kind === "linear" ? field("In the states", html`<input name="states" placeholder="Todo, In Progress" .value=${(t.states || []).join(", ")}
        @change=${(e) => { t.states = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); redraw(); }}>`, "Empty means when it is assigned to you.") : nothing}
      ${t.kind === "linear" ? html`<label class="check"><input type="checkbox" name="assigned" .checked=${!!t.assigned} @change=${(e) => { t.assigned = e.target.checked; redraw(); }}>Only tickets assigned to me</label>` : nothing}
      ${t.kind === "gitlab_reviewer" ? field("GitLab host", data.gitlab_hosts.length
        ? html`<select name="host" @change=${(e) => { t.host = e.target.value; redraw(); }}>${data.gitlab_hosts.map((h) => html`<option value=${h} ?selected=${t.host === h}>${h}</option>`)}</select>`
        : html`<input name="host" .value=${t.host || ""} @input=${(e) => { t.host = e.target.value; redraw(); }}>`,
        data.gitlab_hosts.length ? "" : "Add the host under Settings, GitHub and GitLab first.") : nothing}
      ${field("First step", stepSelect(d.start, d.steps, (v) => { d.start = v; redraw(); }))}
    </div>
  </fieldset>`;
}

function save() {
  doing(async () => {
    try {
      def = await api("PUT", `/api/pipelines/${encodeURIComponent(def.id)}`, draft);
      draft = structuredClone(def);
      problems = [];
      toast(`Saved as v${def.version}`, "ok");
      await load();
    } catch (err) {
      if (!err.problems?.length) throw err;
      problems = err.problems;
      inspectorOpen = true;
    }
  });
}

const LIBRARY = [
  ["Start when", [["manual", "manual", "By hand", "From Run now"], ["schedule", "schedule", "Schedule", "Weekdays, every day, a time"], ["linear", "ticket", "New ticket", "From Linear, Trello or any connection"], ["webhook", "call", "A webhook", "Another system calls an address"], ["github_review", "pull", "GitHub review request", "A PR asks for my review"], ["gitlab_reviewer", "pull", "GitLab reviewer", "An MR adds me as reviewer"]]],
  ["Agent", [["agent", "agent", "Agent step", "Your instructions, on a machine"], ["plan", "plan", "Plan", "Picks machine, folder and branch"]]],
  ["Yardbell", [["push", "push", "Push and draft PR", "Secret check, never forced"], ["update", "update", "Update the ticket", "Move or comment, wherever it came from"], ["call", "call", "Use a connected tool", "Do one action in a tool, with no agent"], ["command", "command", "Run a command", "Its exit code decides pass or fail"], ["report", "report", "Report to me", "What the run found, on your phone"]]],
  ["You", [["wait", "wait", "Wait for me", "Continues when you say"]]],
];

let selected = null;
let libraryOpen = remembered("yb-pipeline-library", true);
let terminalOpen = remembered("yb-pipeline-terminal", false);
let inspectorOpen = true;

function remembered(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function remember(key, on) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {}
}

function select(id) {
  selected = id;
  if (id) inspectorOpen = true;
  draw();
}

function newTrigger(kind) {
  if (kind === "schedule") return { kind, schedule: "", state: "" };
  if (kind === "linear") return { kind, assigned: true, states: [] };
  if (kind === "gitlab_reviewer") return { kind, host: data.gitlab_hosts[0] || "" };
  if (kind === "connector") return { kind, connector: data.connectors[0]?.id || "", params: {}, states: [] };
  if (kind === "webhook") return { kind, map: {} };
  return { kind };
}

function pickTrigger(kind) {
  draft.trigger = newTrigger(kind);
  select("@start");
}

const phone = window.matchMedia("(max-width: 760px)");
phone.addEventListener?.("change", () => draw());
let addSheet = false;

function libraryGroups() {
  return LIBRARY.map(([group, items]) => html`<h3>${group}</h3>
    <ul>${items.map(([kind, iconKind, name, hint]) => html`<li>
      <button type="button" class="pl-lib-item" data-kind=${kind} data-group=${group}
          @pointerdown=${group === "Start when" || phone.matches ? nothing : (e) => carry(e, kind)}
          @click=${(e) => {
            if (e.currentTarget.dataset.dragged) return delete e.currentTarget.dataset.dragged;
            addSheet = false;
            return group === "Start when" ? pickTrigger(kind) : addStep(kind);
          }}>
        <span class="pl-kind-icon">${icon(iconKind)}</span>
        <span><b>${name}</b><small>${hint}</small></span>
      </button>
    </li>`)}</ul>`);
}

function addSheetView() {
  if (!addSheet) return nothing;
  return html`<div class="pl-sheet-backdrop" @click=${() => { addSheet = false; draw(); }}></div>
    <div class="pl-sheet pl-library" id="pl-add-sheet" role="dialog" aria-label="Add a step">
      <div class="pl-library-head"><span>Add a step</span><button class="btn quiet" type="button" @click=${() => { addSheet = false; draw(); }}>Close</button></div>
      ${libraryGroups()}
    </div>`;
}

function library() {
  const fold = () => { libraryOpen = !libraryOpen; remember("yb-pipeline-library", libraryOpen); draw(); };
  if (!libraryOpen) {
    return html`<aside class="pl-library folded"><button class="btn quiet" type="button" title="Show the steps" aria-label="Show the steps" @click=${fold}>${chevron("right")}</button></aside>`;
  }
  return html`<aside class="pl-library" aria-label="Steps you can add">
    <div class="pl-library-head"><span>Steps</span><button class="btn quiet" type="button" title="Hide the steps" aria-label="Hide the steps" @click=${fold}>${chevron("left")}</button></div>
    ${libraryGroups()}
  </aside>`;
}

function chevron(way) {
  return html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d=${way === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"}></path></svg>`;
}

let past = [];
let future = [];
let addMenu = null;
const GAP_X = 260;
const GAP_Y = 170;

function snapshot() {
  past.push(structuredClone(draft));
  if (past.length > 100) past.shift();
  future = [];
}

function edit(change) {
  snapshot();
  change();
  draw();
}

function undo() {
  if (!past.length) return;
  future.push(structuredClone(draft));
  draft = past.pop();
  if (selected && selected !== "@start" && !selected.startsWith("line:") && !draft.steps.some((s) => s.id === selected)) selected = null;
  draw();
}

function redo() {
  if (!future.length) return;
  past.push(structuredClone(draft));
  draft = future.pop();
  draw();
}

// The same rule as the server's slug, so a step's id reads like its name.
function slug(name, taken) {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const base = words.length ? words.join("-") : "step";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function blank(wanted) {
  const kind = wanted === "call" && !data.connectors.length && data.mcp_servers.length ? "tool" : wanted;
  const names = draft.steps.map((s) => s.name.toLowerCase());
  let name = KINDS[kind];
  for (let n = 2; names.includes(name.toLowerCase()); n++) name = `${KINDS[kind]} ${n}`;
  const fields = {
    agent: { instructions: "", agent: "", machine: { pick: [] }, workspace: { kind: "new_worktree" }, session: "new", read_only: false, mcp_servers: [] },
    plan: { machines: [] },
    update: { action: "move", state: "In Review" },
    call: { connector: data.connectors[0]?.id || "", call: "", params: {} },
    tool: { server: data.mcp_servers[0] || "", tool: "", arguments: {}, call_kind: "change", schema_hash: "" },
    command: { command: "", approved: "" },
    wait: { message: "" },
  }[kind] || {};
  return { id: slug(name, draft.steps.map((s) => s.id)), name, kind, ...fields, max_runs: 2, minutes: null, next: { pass: "end", fail: "wait", needs_you: "wait" }, x: 0, y: 0 };
}

// Moves a new card down until it no longer sits on another.
function room(x, y) {
  let at = { x: Math.round(x / 8) * 8, y: Math.round(y / 8) * 8 };
  while (draft.steps.some((s) => Math.abs(s.x - at.x) < NODE_W - 20 && Math.abs(s.y - at.y) < 100)) at = { ...at, y: at.y + GAP_Y };
  return at;
}

function stepOf(id) {
  return draft.steps.find((s) => s.id === id);
}

function connect(from, outcome, to) {
  edit(() => {
    if (from === "@start") draft.start = to;
    else stepOf(from).next[outcome] = to;
  });
}

function createAt(kind, x, y, from = null, outcome = null) {
  edit(() => {
    const step = { ...blank(kind), ...room(x, y) };
    draft.steps.push(step);
    if (from === "@start" || !draft.start) draft.start = step.id;
    else if (from) stepOf(from).next[outcome] = step.id;
    selected = step.id;
    inspectorOpen = true;
  });
  addMenu = null;
}

// From the library by click: after the selected step, on its pass line; otherwise in view.
function addStep(kind) {
  const after = stepOf(selected);
  if (after) {
    edit(() => {
      const step = { ...blank(kind), ...room(after.x + GAP_X, after.y) };
      step.next.pass = after.next.pass;
      after.next.pass = step.id;
      draft.steps.push(step);
      selected = step.id;
    });
    return;
  }
  const c = document.querySelector(".pl-canvas.editable");
  const at = c ? centreOf(c) : { x: 40, y: 120 };
  if (selected === "@start" && draft.start) {
    const first = stepOf(draft.start);
    edit(() => {
      const step = { ...blank(kind), ...room(first.x, first.y + GAP_Y) };
      step.next.pass = draft.start;
      draft.start = step.id;
      draft.steps.push(step);
      selected = step.id;
    });
    return;
  }
  createAt(kind, at.x - NODE_W / 2, at.y - 50);
}

function removeStep(id) {
  edit(() => {
    const gone = stepOf(id);
    draft.steps = draft.steps.filter((s) => s.id !== id);
    for (const s of draft.steps) {
      for (const o of ["pass", "fail", "needs_you"]) if (s.next[o] === id) s.next[o] = o === "pass" ? "end" : "wait";
    }
    if (draft.start === id) draft.start = stepOf(gone.next.pass) ? gone.next.pass : draft.steps[0]?.id || "";
    selected = null;
  });
}

function cutLine(from, outcome) {
  edit(() => {
    stepOf(from).next[outcome] = outcome === "pass" ? "end" : "wait";
    selected = from;
  });
}

function removeSelected() {
  if (selected?.startsWith("line:")) {
    const [, from, outcome] = selected.split(":");
    cutLine(from, outcome);
  } else if (stepOf(selected)) {
    removeStep(selected);
  }
}

// Steps along the pass line from the start go left to right; a step reached another way sits
// under the step it comes from; anything else goes in a row underneath.
function tidy() {
  edit(() => {
    const chain = [];
    for (let id = draft.start; stepOf(id) && !chain.includes(id); id = stepOf(id).next.pass) chain.push(id);
    const placed = new Map(chain.map((id, i) => [id, { x: 40 + i * GAP_X, y: 120 }]));
    const below = new Map();
    const queue = [...chain];
    while (queue.length) {
      const id = queue.shift();
      for (const o of ["pass", "fail", "needs_you"]) {
        const to = stepOf(id).next[o];
        if (!stepOf(to) || placed.has(to)) continue;
        const col = placed.get(id).x;
        const depth = (below.get(col) || 0) + 1;
        below.set(col, depth);
        placed.set(to, { x: col, y: 120 + depth * GAP_Y });
        queue.push(to);
      }
    }
    const deepest = Math.max(0, ...below.values());
    let i = 0;
    for (const s of draft.steps) {
      const at = placed.get(s.id) || { x: 40 + i++ * GAP_X, y: 120 + (deepest + 1) * GAP_Y };
      s.x = at.x;
      s.y = at.y;
    }
  });
}

const handlers = {
  select: (id) => { addMenu = null; select(id); },
  begin: snapshot,
  move: (id, x, y) => {
    const s = stepOf(id);
    if (!s || (s.x === x && s.y === y)) return;
    s.x = x;
    s.y = y;
    draw();
  },
  connect,
  drop: (kind, world, from, outcome, cx, cy) => {
    if (kind) return createAt(kind, world.x - NODE_W / 2, world.y - 50, from, outcome);
    addMenu = { cx, cy, world, from, outcome };
    draw();
  },
};

function addMenuView() {
  if (!addMenu) return nothing;
  const kinds = LIBRARY.filter(([g]) => g !== "Start when").flatMap(([, items]) => items);
  return html`<div class="pl-add-menu" id="pl-add-menu" role="menu" style=${`left:${addMenu.cx}px;top:${addMenu.cy}px`}>
    <p>Add a step on this line</p>
    ${kinds.map(([kind, iconKind, name]) => html`<button type="button" role="menuitem" data-kind=${kind}
      @click=${() => createAt(kind, addMenu.world.x - NODE_W / 2, addMenu.world.y - 50, addMenu.from, addMenu.outcome)}>
      <span class="pl-kind-icon">${icon(iconKind)}</span>${name}</button>`)}
  </div>`;
}

// Dragging an item out of the library: a card follows the pointer and lands where it is let go.
let carrying = null;

function carry(e, kind) {
  if (e.button !== 0) return;
  carrying = { kind, x0: e.clientX, y0: e.clientY, moved: false, item: e.currentTarget };
}

window.addEventListener("pointermove", (e) => {
  if (!carrying) return;
  if (!carrying.moved && Math.hypot(e.clientX - carrying.x0, e.clientY - carrying.y0) < 5) return;
  if (!carrying.moved) {
    carrying.moved = true;
    carrying.ghost = Object.assign(document.createElement("div"), { className: "pl-lib-ghost", textContent: KINDS[carrying.kind] });
    document.body.append(carrying.ghost);
  }
  carrying.ghost.style.transform = `translate(${e.clientX + 8}px, ${e.clientY + 8}px)`;
});

window.addEventListener("pointerup", (e) => {
  if (!carrying) return;
  const c = carrying;
  carrying = null;
  c.ghost?.remove();
  if (!c.moved) return;
  c.item.dataset.dragged = "1";
  const canvas = document.querySelector(".pl-canvas.editable");
  const r = canvas?.getBoundingClientRect();
  if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  const at = toWorld(canvas, e.clientX, e.clientY);
  createAt(c.kind, at.x - NODE_W / 2, at.y - 50);
});

function typing(e) {
  return e.target.closest?.("input, textarea, select, [contenteditable]");
}

document.addEventListener("keydown", (e) => {
  if (!def || !draft || !document.querySelector(".pl-canvas.editable")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!proposal) save();
    else if (!proposal.decided) approveProposal();
    return;
  }
  if (typing(e)) return;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeSelected();
  } else if (e.key === "Escape") {
    addMenu = null;
    select(null);
  } else if (e.key.startsWith("Arrow") && stepOf(selected)) {
    e.preventDefault();
    const by = e.shiftKey ? 32 : 8;
    const [dx, dy] = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[e.key];
    edit(() => {
      const s = stepOf(selected);
      s.x += dx;
      s.y += dy;
    });
  }
});

function inspector() {
  const redraw = () => draw();
  const step = draft.steps.find((s) => s.id === selected);
  const mine = step ? problems.filter((p) => p.startsWith(`${step.name}: `) || p === `${step.name} is never reached`) : [];
  let body;
  if (step) {
    body = html`${mine.length ? html`<ul class="pl-inspector-problems" role="alert">${mine.map((p) => html`<li>${p.startsWith(`${step.name}: `) ? p.slice(step.name.length + 2) : p}</li>`)}</ul>` : nothing}${stepForm(step, draft, redraw)}
      <div class="pl-inspector-foot"><button class="btn quiet danger" type="button" @click=${() => removeStep(step.id)}>Delete step</button></div>`;
  } else if (selected?.startsWith("line:")) {
    const [, from, outcome] = selected.split(":");
    const src = stepOf(from);
    body = src ? html`<div class="pl-inspector-empty">
      <p><b>${src.name}</b> on ${WORDS[outcome].replace("passed", "pass").replace("failed", "fail")} goes to <b>${stepOf(src.next[outcome])?.name || src.next[outcome]}</b>.</p>
      <p>Drag from the port to another step to change it, or remove the line: the run then ${outcome === "pass" ? "ends" : "waits for you"} there.</p>
      <div><button class="btn quiet danger" type="button" @click=${() => cutLine(from, outcome)}>Remove line</button></div>
    </div>` : nothing;
  } else if (selected === "@start") {
    body = triggerFields(draft, redraw);
  } else {
    body = html`<div class="pl-inspector-empty">
      <p><b>${draft.name}</b></p>
      <p>Click a step to edit it, or the Start when card for the trigger. Drag a step in from the library, or click one to add it.</p>
      <p>${draft.steps.length} ${draft.steps.length === 1 ? "step" : "steps"} · ${triggerWords(draft.trigger)}</p>
    </div>`;
  }
  if (phone.matches && !selected) return nothing;
  return html`<aside class=${`pl-inspector ${phone.matches ? "sheet" : ""}`} id="pl-inspector" aria-label="Selected step">
    <div class="pl-inspector-head">
      <span class="pl-inspector-title">${step ? html`<span class="pl-kind-icon">${icon(step.kind)}</span>${KINDS[step.kind]}` : selected === "@start" ? html`<span class="pl-kind-icon">${icon("start")}</span>Start when` : selected?.startsWith("line:") ? "Line" : "Pipeline"}</span>
      ${phone.matches
        ? html`<button class="btn primary" type="button" id="pl-sheet-done" @click=${() => select(null)}>Done</button>`
        : html`<button class="btn quiet" type="button" title="Hide the panel" aria-label="Hide the panel" @click=${() => { inspectorOpen = false; draw(); }}>${chevron("right")}</button>`}
    </div>
    <div class="pl-inspector-body">${body}</div>
  </aside>`;
}

function buildTab(d) {
  const bar = html`${problems.length ? html`<div class="pl-problems pl-canvas-bar" id="pl-problems" role="alert"><p>Not saved. Fix these first:</p><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : nothing}
    ${inspectorOpen ? nothing : html`<button class="btn pl-panel-toggle pl-canvas-bar" type="button" title="Show the panel" aria-label="Show the panel" @click=${() => { inspectorOpen = true; draw(); }}>${chevron("left")}</button>`}
    ${draft.steps.length ? nothing : html`<p class="pl-canvas-hint">Drag a step here, or click one in the library.</p>`}
    <div class="pl-canvas-tools pl-canvas-bar">
      <button class="btn" type="button" title="Undo (Ctrl+Z)" aria-label="Undo" ?disabled=${!past.length} @click=${undo}><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 2.5 7l3 3 M2.5 7h7a4 4 0 0 1 0 8H8"></path></svg></button>
      <button class="btn" type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" ?disabled=${!future.length} @click=${redo}><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4l3 3-3 3 M13.5 7h-7a4 4 0 0 0 0 8H8"></path></svg></button>
      <button class="btn" type="button" id="pl-tidy" title="Line the steps up" ?disabled=${!draft.steps.length} @click=${tidy}>Tidy</button>
    </div>
    <button class="btn pl-add-fab pl-canvas-bar" type="button" id="pl-add-step" @click=${() => { addSheet = true; draw(); }}>
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"></path></svg>Add step
    </button>`;
  return html`<div class=${`pl-build ${libraryOpen ? "" : "no-library"} ${inspectorOpen ? "" : "no-inspector"}`}>
    ${library()}
    ${canvas({ def: draft, editable: !proposal?.decided, selected, problems, on: handlers, key: `${d.id}:build`, bar })}
    ${addMenuView()}
    ${addSheetView()}
    ${inspectorOpen ? inspector() : html`<span></span>`}
  </div>`;
}

let previewing = null;

async function restore(v) {
  if (unsaved() && !(await leave())) return;
  doing(async () => {
    def = await api("POST", `/api/pipelines/${encodeURIComponent(def.id)}/restore`, { version: v.version });
    draft = structuredClone(def);
    previewing = null;
    toast(`Restored v${v.version} as v${def.version}`, "ok");
    await load();
  });
}

function historyTab() {
  const shown = versions.find((v) => v.version === previewing) || versions[0];
  const current = shown === versions[0];
  return html`<div class="pl-history-view">
    <ol class="pl-history">${versions.map((v, i) => html`<li class=${`pl-history-row ${v === shown ? "sel" : ""}`} data-version=${String(v.version)}>
      <button class="pl-history-pick" type="button" aria-current=${v === shown ? "true" : "false"} @click=${() => { previewing = v.version; draw(); }}>
        <span class="pl-v">v${v.version}</span>
        <span class="pl-history-steps">${v.definition.steps.map((s) => s.name).join(" · ") || "No steps"}</span>
        <time>${clock(v.saved)}</time>
      </button>
      ${i === 0 ? html`<span class="pl-current">Current</span>` : html`<button class="btn" type="button" ?disabled=${busy} @click=${() => restore(v)}>Restore</button>`}
    </li>`)}</ol>
    ${shown ? canvas({
      def: shown.definition,
      key: `${def.id}:history:${shown.version}`,
      bar: html`<div class="pl-history-preview pl-canvas-bar">
        <span>${current ? `Version ${shown.version}, the current one` : `Version ${shown.version}, saved ${clock(shown.saved)}`}</span>
        ${current ? nothing : html`<button class="btn" type="button" @click=${() => restore(shown)}>Restore</button>
          <button class="btn quiet" type="button" @click=${() => { previewing = null; draw(); }}>Back to the current version</button>`}
      </div>`,
    }) : nothing}
  </div>`;
}

function runNow(d) {
  if (d.trigger.kind === "schedule") {
    doing(async () => {
      await api("POST", `/api/pipelines/${encodeURIComponent(d.id)}/runs`, {});
      toast("Started", "ok");
      await load();
    });
    return;
  }
  show.runNow = !show.runNow;
  draw();
}

function runNowPanel(d) {
  const linear = d.trigger.kind === "linear";
  const tool = d.trigger.kind === "connector";
  const hook = d.trigger.kind === "webhook";
  const optional = d.trigger.kind === "manual" || hook;
  const start = () => doing(async () => {
    const items = subjects.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const body = tool
      ? { tickets: items, prs: [] }
      : { tickets: items.filter((x) => !x.startsWith("https://")), prs: items.filter((x) => x.startsWith("https://")) };
    const out = await api("POST", `/api/pipelines/${encodeURIComponent(d.id)}/runs`, body);
    subjects = "";
    show.runNow = false;
    toast(`Started ${out.runs.length} ${out.runs.length === 1 ? "run" : "runs"}`, "ok");
    await load();
  });
  return html`<div class="pl-panel" id="pl-run-now-panel">
    ${hook ? html`<p class="help">Starts one run with no item.</p>` : tool ? field("Item ids or links", html`<textarea rows="2" id="pl-subjects" placeholder="abc123"
      .value=${subjects} @input=${(e) => { subjects = e.target.value; draw(); }}></textarea>`, "One run each.") : field(optional ? "Ticket ids or links (optional)" : linear ? "Ticket ids" : "Merge or pull request links", html`<textarea rows="2" id="pl-subjects" placeholder=${linear || optional ? "COM-1234 COM-1240" : "https://gitlab.example.com/group/app/-/merge_requests/87"}
      .value=${subjects} @input=${(e) => { subjects = e.target.value; draw(); }}></textarea>`, optional ? "One run each, or leave it empty for one run with no ticket." : "One run each. Ticket ids and links can be mixed.")}
    <div class="pl-panel-actions">
      <button class="btn quiet" type="button" @click=${() => { show.runNow = false; draw(); }}>Cancel</button>
      <button class="btn primary" type="button" ?disabled=${busy || (!optional && !subjects.trim())} @click=${start}>Start</button>
    </div>
  </div>`;
}

// The page's own dialog, since the desktop app's webview has no window.confirm.
const ask = (title, body, options) => window.YardbellNav.confirm(title, body, options);
const leave = () => ask("Leave without saving your changes?", "Your changes to this pipeline are lost.", { confirm: "Leave", danger: true });

async function removePipeline(d) {
  if (!(await ask(`Delete ${d.name} and its runs?`, "Its history goes too.", { confirm: "Delete", danger: true }))) return;
  doing(async () => {
    await api("DELETE", `/api/pipelines/${encodeURIComponent(d.id)}`);
    go("");
  });
}

let full = remembered("yb-pipeline-full", true);

// A key is "<conversation>.<step>" for a Dispatch step, or "inbox.<id>" for a proposal from an
// MCP client; both are drawn and approved the same way, at their own address.
async function loadProposal(key) {
  const at = key.lastIndexOf(".");
  const conversation = key.slice(0, at), step = key.slice(at + 1);
  const inbox = conversation === "inbox";
  const e = inbox
    ? await api("GET", `/api/proposals/${encodeURIComponent(step)}`).then((p) => (p.tool === "save_pipeline" ? p : null), () => null)
    : (await api("GET", `/dispatch/conversations/${encodeURIComponent(conversation)}`)).events.find((x) => x.role === "action" && x.id === step && x.tool === "save_pipeline");
  if (!e) {
    toast("There is no such proposal");
    history.replaceState(null, "", location.pathname);
    proposal = def = draft = null;
    return;
  }
  proposal = {
    key, conversation, step, before: e.input.before, decided: e.status !== "pending",
    url: inbox ? `/api/proposals/${encodeURIComponent(step)}` : `/dispatch/conversations/${encodeURIComponent(conversation)}/actions/${step}`,
    back: inbox ? ["/proposals", "Proposals"] : [`/dispatch?c=${encodeURIComponent(conversation)}`, "Dispatch"],
    by: inbox ? e.from : "Dispatch",
  };
  def = structuredClone(e.input.definition);
  draft = structuredClone(def);
  past = [];
  future = [];
  selected = null;
  addMenu = null;
  problems = [];
}

// Unchanged, the step is approved as proposed; changed, it goes back as an edit and is checked again.
function approveProposal() {
  doing(async () => {
    const edited = JSON.stringify(draft) !== JSON.stringify(def);
    const body = { decision: "approve", ...(edited ? { input: { definition: draft, before: proposal.before } } : {}) };
    try {
      const step = await api("POST", proposal.url, body);
      if (step.result && !step.result.ok) {
        proposal.decided = true;
        toast(step.result.text);
        return;
      }
      const out = JSON.parse(step.result?.text || "{}");
      def = structuredClone(draft);
      proposal = null;
      toast(`Saved as v${out.version}`, "ok");
      go(`p=${encodeURIComponent(out.saved)}&tab=build`);
    } catch (err) {
      if (/already|withdrawn/.test(err.message)) {
        proposal.decided = true;
        toast(err.message);
        return;
      }
      const listed = err.message.match(/send the whole pipeline again: (.*)$/s);
      if (!listed) throw err;
      problems = listed[1].split("; ");
      inspectorOpen = true;
    }
  });
}

function proposalView() {
  const [back, backName] = proposal.back;
  return html`<div class=${`pl-builder ${full ? "full" : ""}`}>
    <header class="pl-bar">
      <a class="btn quiet pl-back" href=${back}>${chevron("left")}<span>${backName}</span></a>
      <input class="pl-name pl-title-name" aria-label="Pipeline name" .value=${draft.name} ?disabled=${proposal.decided} @input=${(e) => { draft.name = e.target.value; draw(); }}>
      <span class="pl-bar-space"></span>
      ${proposal.decided ? nothing : html`<button class="btn primary" type="button" id="pl-save" ?disabled=${busy} @click=${approveProposal}>Approve and save</button>`}
    </header>
    <p class="pl-proposal" role="status">${proposal.decided ? "This proposal was already decided." : `Proposed by ${proposal.by}. Saving approves it.`} <a href=${back}>Back to ${backName}</a></p>
    <div class="pl-body">${buildTab(def)}</div>
  </div>`;
}

async function askDispatch(d) {
  if (unsaved() && !(await leave())) return;
  draft = structuredClone(def);
  location.href = `/dispatch?ask=${encodeURIComponent(`Change the pipeline "${d.name}" (${d.id}): `)}`;
}

function unsaved() {
  return !!(def && draft && JSON.stringify(draft) !== JSON.stringify(def));
}

window.addEventListener("beforeunload", (e) => {
  if (!unsaved()) return;
  e.preventDefault();
  e.returnValue = "";
});

function pipelineView() {
  const d = def;
  const runs = runsOf(d.id);
  const tab = params().get("tab") || (runs.length ? "runs" : "build");
  const changed = JSON.stringify(draft) !== JSON.stringify(def);
  const setTab = (t) => {
    const q = params();
    q.set("tab", t);
    history.replaceState(null, "", `${location.pathname}?${q}`);
    load().catch((err) => toast(err.message));
  };
  const toggleFull = () => { full = !full; remember("yb-pipeline-full", full); draw(); };
  const tabs = [["build", "Build"], ["runs", runs.length ? `Runs ${runs.length}` : "Runs"], ["history", "History"]];
  return html`<div class=${`pl-builder ${full ? "full" : ""}`}>
    <header class="pl-bar">
      <button class="btn quiet pl-back" type="button" id="pl-back" title="Back to Pipelines" @click=${async () => { if (!unsaved() || (await leave())) go(""); }}>${chevron("left")}<span>Pipelines</span></button>
      <input class="pl-name pl-title-name" aria-label="Pipeline name" .value=${draft.name} @input=${(e) => { draft.name = e.target.value; draw(); }}>
      ${onOff(d)}
      <span class="pl-version">v${d.version}</span>
      <div class="segmented pl-tabs" role="tablist">${tabs.map(([t, l]) => html`<button type="button" role="tab" aria-selected=${tab === t ? "true" : "false"} @click=${() => setTab(t)}>${l}</button>`)}</div>
      <span class="pl-bar-space"></span>
      <button class="btn quiet" type="button" id="pl-full" aria-pressed=${full ? "true" : "false"} title=${full ? "Exit full screen" : "Full screen"} aria-label=${full ? "Exit full screen" : "Full screen"} @click=${toggleFull}>
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d=${full ? "M6.5 2.5v4h-4 M9.5 2.5v4h4 M6.5 13.5v-4h-4 M9.5 13.5v-4h4" : "M2.5 6.5v-4h4 M13.5 6.5v-4h-4 M2.5 9.5v4h4 M13.5 9.5v4h-4"}></path></svg>
      </button>
      <button class="btn quiet" type="button" id="pl-ask" @click=${() => askDispatch(d)}>Ask Dispatch to change it</button>
      <button class="btn quiet danger" type="button" id="pl-delete" @click=${() => removePipeline(d)}>Delete</button>
      <button class="btn" type="button" id="pl-run-now" ?disabled=${busy} @click=${() => runNow(d)}>Run now</button>
      ${changed
        ? html`<button class="btn primary" type="button" id="pl-save" ?disabled=${busy} @click=${save}>Save</button>`
        : html`<span class="pl-saved" id="pl-save"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"></path></svg>Saved</span>`}
    </header>
    ${show.runNow ? runNowPanel(d) : nothing}
    <div class="pl-body">${tab === "build" ? buildTab(d) : tab === "history" ? historyTab() : runsTab(d)}</div>
  </div>`;
}

function draw() {
  const root = $("pl-root");
  if (!data) return;
  const id = params().get("p");
  document.title = id && def ? `${def.name} · Pipelines · Yardbell` : "Pipelines · Yardbell";
  render(proposal && def ? proposalView() : id && def ? pipelineView() : listView(), root);
  here = location.href;
  settle();
  inView(document.getElementById("pl-add-menu"));
}

// Keeps a menu opened at the pointer inside the window, 8px from its edges.
function inView(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`;
  if (r.right > innerWidth - 8) el.style.left = `${Math.max(8, innerWidth - 8 - r.width)}px`;
}

async function load() {
  const id = params().get("p");
  const asked = params().get("proposal");
  const [list, runs] = await Promise.all([api("GET", "/api/pipelines"), api("GET", "/api/runs")]);
  data = list;
  setConnectors(list.connectors);
  allRuns = runs.runs;
  if (asked) {
    if (proposal?.key !== asked) await loadProposal(asked);
    draw();
    return;
  }
  proposal = null;
  if (id) {
    const found = data.pipelines.find((p) => p.definition.id === id)?.definition;
    if (!found) {
      toast(`There is no pipeline ${id}`);
      history.replaceState(null, "", location.pathname);
      def = null;
    } else {
      if (def?.id !== id) {
        past = [];
        future = [];
        selected = null;
        addMenu = null;
      }
      const editing = draft && def && def.id === id && JSON.stringify(draft) !== JSON.stringify(def);
      def = found;
      if (!editing) draft = structuredClone(found);
      draft.enabled = found.enabled;
      if (params().get("tab") === "history") versions = (await api("GET", `/api/pipelines/${encodeURIComponent(id)}/history`)).history;
    }
  } else {
    def = null;
    draft = null;
  }
  draw();
}

let here = location.href;

let askingToLeave = false;

// The address goes back to the draft while the question is open, so a reload behind it keeps the
// draft, and a second Back only lands here again.
window.addEventListener("popstate", async () => {
  if (unsaved() && params().get("p") !== def.id) {
    const wanted = location.href;
    history.pushState(null, "", here);
    if (askingToLeave) return;
    askingToLeave = true;
    const going = await leave();
    askingToLeave = false;
    if (!going) return;
    history.pushState(null, "", wanted);
  }
  load().catch((err) => toast(err.message));
});
window.YardbellLive.follow(() => { if (!busy) load().catch(() => {}); }, 5000);
load().catch((err) => toast(err.message));
