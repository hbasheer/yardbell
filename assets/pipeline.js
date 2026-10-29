import { html, svg, render, nothing } from "/vendor/lit-html/lit-html.js";

const $ = (id) => document.getElementById(id);
const NODE_W = 190;
const NODE_H = 58;
const OUTCOMES = [["pass", "On pass"], ["fail", "On fail"], ["needs_you", "On needs you"]];
const WORDS = { pass: "passed", fail: "failed", needs_you: "needs you" };
const KINDS = { agent: "Agent", plan: "Plan", push: "Push and draft PR", linear: "Linear", report: "Report to me", wait: "Wait for me" };
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

function triggerWords(t) {
  switch (t?.kind) {
    case "schedule": return `On the schedule ${t.schedule || "(not set)"}${t.state ? `, my open tickets in ${t.state}` : ""}`;
    case "linear":
      if (t.states?.length) return `When a Linear ticket${t.assigned ? " of mine" : ""} moves to ${t.states.join(" or ")}`;
      return "When a Linear ticket is assigned to me";
    case "github_review": return "When someone asks me to review a GitHub pull request";
    case "gitlab_reviewer": return `When a GitLab merge request on ${t.host || "a host you pick"} adds me as reviewer`;
    default: return "By hand";
  }
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

function newPipeline(template) {
  doing(async () => {
    const d = await api("POST", "/api/pipelines", { template });
    go(`p=${encodeURIComponent(d.id)}&tab=steps`);
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
      <p class="pl-field-head">QA notes per folder <span>Added to every QA step that tests that folder, such as how to run its specs.</span></p>
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
        <button class="btn primary" type="button" id="pl-new" aria-expanded=${show.templates ? "true" : "false"} @click=${() => { show.templates = !show.templates; draw(); }}>New pipeline</button>
      </div>
    </header>
    ${show.templates ? html`<div class="pl-panel" id="pl-templates">
      <p class="pl-field-head">Start from a template <span>It is saved switched off, so you can set its trigger and steps first.</span></p>
      <div class="pl-template-list">${data.templates.map((t) => html`<button class="btn" type="button" ?disabled=${busy} @click=${() => newPipeline(t)}>${t}</button>`)}</div>
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

function edgePath(a, b) {
  const ax = a.x + NODE_W, ay = a.y + NODE_H / 2, bx = b.x, by = b.y + NODE_H / 2;
  if (b.x >= a.x + NODE_W) {
    const mid = (ax + bx) / 2;
    return `M${ax} ${ay} C${mid} ${ay} ${mid} ${by} ${bx} ${by}`;
  }
  if (Math.abs(b.x - a.x) < NODE_W) {
    const down = b.y > a.y;
    const x = a.x + NODE_W / 2 + (down ? -24 : 24);
    const y1 = down ? a.y + NODE_H : a.y;
    const y2 = down ? b.y : b.y + NODE_H;
    return `M${x} ${y1} C${x} ${(y1 + y2) / 2} ${x} ${(y1 + y2) / 2} ${x} ${y2}`;
  }
  const depth = Math.max(a.y, b.y) + NODE_H + 40 + Math.min(80, (a.x - b.x) / 12);
  const x1 = a.x + NODE_W / 2, x2 = b.x + NODE_W / 2 + 20;
  return `M${x1} ${a.y + NODE_H} C${x1} ${depth} ${x2} ${depth} ${x2} ${b.y + NODE_H}`;
}

function nodeState(run, step) {
  if (!run) return { cls: "", mark: "", note: KINDS[step.kind] };
  const st = run.steps?.[step.id];
  const current = run.step === step.id && ["queued", "running", "waiting"].includes(run.state);
  if (current && run.state === "waiting") {
    const reason = run.waiting?.reason || "waiting";
    const note = run.waiting?.kind === "needs_you" ? "needs you" : reason.startsWith(`${step.name} `) ? reason.slice(step.name.length + 1) : reason;
    return { cls: "waiting", mark: "!", note };
  }
  if (current) return { cls: "now", mark: "", note: run.state === "queued" ? "queued" : `running · ${ago(run.step_since)}` };
  if (st?.outcome) {
    const runs = st.runs > 1 ? ` · ${st.runs} runs` : "";
    return { cls: `done ${st.outcome === "fail" ? "failed" : ""}`, mark: st.outcome === "fail" ? "✗" : "✓", note: `${WORDS[st.outcome]}${runs}` };
  }
  return { cls: "later", mark: "", note: "not reached" };
}

function graph(d, run) {
  const at = Object.fromEntries(d.steps.map((s) => [s.id, s]));
  const width = Math.max(...d.steps.map((s) => s.x)) + NODE_W + 40;
  const height = Math.max(...d.steps.map((s) => s.y)) + NODE_H + 160;
  const edges = [];
  for (const s of d.steps) {
    for (const [outcome] of OUTCOMES) {
      const to = s.next?.[outcome];
      if (!at[to]) continue;
      const taken = run && run.steps?.[s.id]?.outcome === outcome && run.steps?.[to];
      edges.push(svg`<path class=${`pl-edge ${outcome} ${taken ? "taken" : ""}`} d=${edgePath(s, at[to])} marker-end=${taken ? "url(#pl-arrow-taken)" : "url(#pl-arrow)"}></path>`);
    }
  }
  return html`<div class="pl-canvas" aria-label="Steps of this run">
    <div class="pl-canvas-inner" style=${`width:${width}px;height:${height}px`}>
      <svg width=${width} height=${height} aria-hidden="true">
        <defs>${["", "-taken"].map((k) => svg`<marker id=${`pl-arrow${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z" class=${`pl-arrowhead${k}`}></path></marker>`)}</defs>
        ${edges}
      </svg>
      ${d.steps.map((s) => {
        const n = nodeState(run, s);
        return html`<div class=${`pl-node ${n.cls}`} data-step=${s.id} style=${`left:${s.x}px;top:${s.y}px`}>
          <b>${n.mark || run ? html`<span class="pl-mark" aria-hidden="true">${n.mark}</span>` : nothing}${s.name}</b>
          <small>${n.note}</small>
        </div>`;
      })}
    </div>
  </div>`;
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
  return html`<div class="pl-need" id="pl-need">
    <p>${(w.reason || "").startsWith(nameOf(d, w.step)) ? html`<b>${w.reason}</b>` : html`<b>${nameOf(d, w.step)}</b> · ${w.reason}`}</p>
    ${w.kind === "questions" && open.length ? html`<ol class="pl-questions">${open.map((q) => html`<li>${q.asked}</li>`)}</ol>` : nothing}
    ${w.screen ? html`<pre class="session-screen">${w.screen}</pre>` : nothing}
    ${answerable ? html`<label class="visually-hidden" for="pl-answer">Your answer</label>
      <textarea id="pl-answer" rows="3" placeholder="Your answer" .value=${text} @input=${(e) => { answers.set(run.id, e.target.value); draw(); }}></textarea>` : nothing}
    <div class="pl-need-actions">
      <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => act(run, "drop")}>Drop</button>
      <button class="btn" type="button" ?disabled=${busy} @click=${() => act(run, "retry")}>Retry step</button>
      <button class="btn" type="button" ?disabled=${busy} @click=${() => act(run, "continue", { outcome: "fail" })}>Continue on fail</button>
      <button class="btn" type="button" ?disabled=${busy} @click=${() => act(run, "continue", { outcome: "pass" })}>Continue on pass</button>
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
    ${["queued", "running"].includes(run.state) ? html`<div class="pl-need-actions"><button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => act(run, "drop")}>Stop this run</button></div>` : nothing}
    <ol class="pl-steps">${d.steps.filter((st) => run.steps?.[st.id]).map((st) => {
      const state = run.steps[st.id];
      const n = nodeState(run, st);
      return html`<li class=${`pl-st ${n.cls}`}>
        <span class="pl-mark" aria-hidden="true">${n.mark}</span>
        <div><span class="pl-st-name">${st.name}</span> <small>${n.note}</small>${state.report ? report(state.report) : nothing}</div>
        <time>${clock(state.ended || state.started)}</time>
      </li>`;
    })}</ol>
    ${run.report ? html`<div class="pl-final"><p class="pl-field-head">Report</p><pre class="session-screen">${run.report}</pre></div>` : nothing}
  </aside>`;
}

function runsTab(d) {
  const runs = runsOf(d.id);
  const chosen = runs.find((r) => r.id === params().get("run")) || runs[0];
  if (!runs.length) return html`<p class="pl-empty">No runs yet. ${SUBJECTLESS.includes(d.trigger.kind) ? "Run it now, or" : "Run it now with a ticket or link, or"} switch it on and let its trigger start one.</p>${graph(d, null)}`;
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
    ${graph(chosen.definition || d, chosen)}
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
  const cont = typeof step.session === "object" ? step.session.continue : "";
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
      ${field("Session", stepSelect(cont ? `continue:${cont}` : "new", others.map((s) => ({ id: `continue:${s.id}`, name: `Continue ${s.name}'s session` })),
        (v) => { step.session = v === "new" ? "new" : { continue: v.slice("continue:".length) }; redraw(); }, [["new", "A new session"]]))}
    </div>
    <label class="check"><input type="checkbox" name="read_only" .checked=${!!step.read_only} @change=${(e) => { step.read_only = e.target.checked; redraw(); }}>Read only: the agent may not change files, commit or push</label>
    ${data.mcp_servers.length ? field("MCP servers", picks(data.mcp_servers, step.mcp_servers || [], (list) => { step.mcp_servers = list; redraw(); }, "mcp")) : nothing}`;
}

function kindFields(step, others, redraw) {
  switch (step.kind) {
    case "agent": return agentFields(step, others, redraw);
    case "plan": return field("Dispatch may pick from", picks(data.machines, step.machines || [], (list) => { step.machines = list; redraw(); }, "plan"), "None ticked means any machine.");
    case "linear": return html`<div class="pl-fields">
      ${field("Action", html`<select name="action" @change=${(e) => { step.action = e.target.value; redraw(); }}>
        <option value="move" ?selected=${step.action === "move"}>Move the ticket</option>
        <option value="comment" ?selected=${step.action === "comment"}>Draft a comment for me</option>
      </select>`)}
      ${step.action === "move" ? field("To the state", html`<input name="state" .value=${step.state || ""} @input=${(e) => { step.state = e.target.value; redraw(); }}>`) : nothing}
    </div>`;
    case "wait": return field("Message", html`<textarea name="message" rows="2" .value=${step.message || ""} @input=${(e) => { step.message = e.target.value; redraw(); }}></textarea>`);
    default: return nothing;
  }
}

function stepForm(step, d, redraw) {
  const others = d.steps.filter((s) => s.id !== step.id);
  const targets = [["end", "End the run"], ["wait", "Wait for me"]];
  return html`<fieldset class="pl-step-form" data-step=${step.id}>
    <legend>${step.name || step.id} <span>${KINDS[step.kind]}</span></legend>
    <div class="pl-fields">
      ${field("Name", html`<input name="name" .value=${step.name} @input=${(e) => { step.name = e.target.value; redraw(); }}>`)}
      ${field("Runs at most", html`<input type="number" name="max_runs" min="1" max="10" .value=${String(step.max_runs ?? 2)} @input=${(e) => { step.max_runs = Number(e.target.value); redraw(); }}>`)}
      ${step.kind === "agent" ? field("Minutes", html`<input type="number" name="minutes" min="10" max="1440" placeholder=${String(data.settings.minutes)} .value=${step.minutes == null ? "" : String(step.minutes)}
        @input=${(e) => { step.minutes = e.target.value === "" ? null : Number(e.target.value); redraw(); }}>`) : nothing}
    </div>
    ${kindFields(step, others, redraw)}
    <div class="pl-fields pl-next">${OUTCOMES.map(([o, lbl]) => field(lbl, stepSelect(step.next[o], others, (v) => { step.next[o] = v; redraw(); }, targets)))}</div>
  </fieldset>`;
}

function triggerForm(d, redraw) {
  const t = d.trigger;
  const kinds = [["manual", "By hand"], ["schedule", "On a schedule"], ["linear", "A Linear ticket"], ["github_review", "A GitHub review request"], ["gitlab_reviewer", "A GitLab merge request reviewer"]];
  const setKind = (k) => {
    d.trigger = k === "schedule" ? { kind: k, schedule: "", state: "" } : k === "linear" ? { kind: k, assigned: true, states: [] } : k === "gitlab_reviewer" ? { kind: k, host: data.gitlab_hosts[0] || "" } : { kind: k };
    redraw();
  };
  return html`<fieldset class="pl-step-form pl-trigger-form">
    <legend>Pipeline</legend>
    <div class="pl-fields">
      ${field("Name", html`<input name="pipeline_name" .value=${d.name} @input=${(e) => { d.name = e.target.value; redraw(); }}>`)}
      ${field("Starts", html`<select name="trigger" @change=${(e) => setKind(e.target.value)}>${kinds.map(([k, l]) => html`<option value=${k} ?selected=${t.kind === k}>${l}</option>`)}</select>`)}
      ${t.kind === "schedule" ? html`
        ${field("Schedule", html`<input name="schedule" placeholder="weekdays 02:00" .value=${t.schedule || ""} @input=${(e) => { t.schedule = e.target.value; redraw(); }}>`)}
        ${field("With my open tickets in", html`<input name="state" placeholder="Todo, or empty for none" .value=${t.state || ""} @input=${(e) => { t.state = e.target.value; redraw(); }}>`)}` : nothing}
      ${t.kind === "linear" ? field("In the states", html`<input name="states" placeholder="Todo, In Progress" .value=${(t.states || []).join(", ")}
        @change=${(e) => { t.states = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); redraw(); }}>`, "Empty means when it is assigned to you.") : nothing}
      ${t.kind === "linear" ? html`<label class="check"><input type="checkbox" name="assigned" .checked=${!!t.assigned} @change=${(e) => { t.assigned = e.target.checked; redraw(); }}>Only tickets assigned to me</label>` : nothing}
      ${t.kind === "gitlab_reviewer" ? field("GitLab host", data.gitlab_hosts.length
        ? html`<select name="host" @change=${(e) => { t.host = e.target.value; redraw(); }}>${data.gitlab_hosts.map((h) => html`<option value=${h} ?selected=${t.host === h}>${h}</option>`)}</select>`
        : html`<input name="host" .value=${t.host || ""} @input=${(e) => { t.host = e.target.value; redraw(); }}>`,
        data.gitlab_hosts.length ? "" : "Add the host under Settings, Pull requests first.") : nothing}
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
    }
  });
}

function stepsTab() {
  const redraw = () => draw();
  const changed = JSON.stringify(draft) !== JSON.stringify(def);
  return html`<div class="pl-steps-tab">
    ${problems.length ? html`<div class="pl-problems" id="pl-problems" role="alert"><p>Not saved. Fix these first:</p><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : nothing}
    ${triggerForm(draft, redraw)}
    ${draft.steps.map((s) => stepForm(s, draft, redraw))}
    <div class="pl-save-bar">
      <span>${changed ? "Unsaved changes" : "Saved"}</span>
      <button class="btn quiet" type="button" ?disabled=${!changed || busy} @click=${() => { draft = structuredClone(def); problems = []; draw(); }}>Undo changes</button>
      <button class="btn primary" type="button" id="pl-save" ?disabled=${busy} @click=${save}>Save</button>
    </div>
  </div>`;
}

function historyTab() {
  return html`<ol class="pl-history">${versions.map((v, i) => html`<li class="pl-history-row" data-version=${String(v.version)}>
    <span class="pl-v">v${v.version}</span>
    <span class="pl-history-steps">${v.definition.steps.map((s) => s.name).join(" · ")}</span>
    <time>${clock(v.saved)}</time>
    ${i === 0 ? html`<span class="pl-current">Current</span>` : html`<button class="btn" type="button" ?disabled=${busy} @click=${() => doing(async () => {
      def = await api("POST", `/api/pipelines/${encodeURIComponent(def.id)}/restore`, { version: v.version });
      draft = structuredClone(def);
      toast(`Restored v${v.version} as v${def.version}`, "ok");
      await load();
    })}>Restore</button>`}
  </li>`)}</ol>`;
}

function runNow(d) {
  if (SUBJECTLESS.includes(d.trigger.kind)) {
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
  const start = () => doing(async () => {
    const items = subjects.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const body = { tickets: items.filter((x) => !x.startsWith("https://")), prs: items.filter((x) => x.startsWith("https://")) };
    const out = await api("POST", `/api/pipelines/${encodeURIComponent(d.id)}/runs`, body);
    subjects = "";
    show.runNow = false;
    toast(`Started ${out.runs.length} ${out.runs.length === 1 ? "run" : "runs"}`, "ok");
    await load();
  });
  return html`<div class="pl-panel" id="pl-run-now-panel">
    ${field(linear ? "Ticket ids" : "Merge or pull request links", html`<textarea rows="2" id="pl-subjects" placeholder=${linear ? "COM-1234 COM-1240" : "https://gitlab.example.com/group/app/-/merge_requests/87"}
      .value=${subjects} @input=${(e) => { subjects = e.target.value; draw(); }}></textarea>`, "One run each. Ticket ids and links can be mixed.")}
    <div class="pl-panel-actions">
      <button class="btn quiet" type="button" @click=${() => { show.runNow = false; draw(); }}>Cancel</button>
      <button class="btn primary" type="button" ?disabled=${busy || !subjects.trim()} @click=${start}>Start</button>
    </div>
  </div>`;
}

function removePipeline(d) {
  if (!confirm(`Delete ${d.name} and its runs? Its history goes too.`)) return;
  doing(async () => {
    await api("DELETE", `/api/pipelines/${encodeURIComponent(d.id)}`);
    go("");
  });
}

function pipelineView() {
  const d = def;
  const tab = params().get("tab") || "runs";
  const setTab = (t) => {
    const q = params();
    q.set("tab", t);
    history.replaceState(null, "", `${location.pathname}?${q}`);
    load().catch((err) => toast(err.message));
  };
  const tabs = [["runs", "Runs"], ["steps", "Steps"], ["history", "History"]];
  return html`
    <button class="back-link" type="button" id="pl-back" @click=${() => go("")}><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>Pipelines</button>
    <header class="main-head pl-title">
      <h1 class="pl-title-name">${d.name}</h1>
      ${onOff(d)}
      <span class="pl-version">v${d.version}</span>
      <div class="pl-head-actions">
        <button class="btn quiet danger" type="button" @click=${() => removePipeline(d)}>Delete</button>
        <button class="btn primary" type="button" id="pl-run-now" ?disabled=${busy} @click=${() => runNow(d)}>Run now</button>
      </div>
    </header>
    <p class="pl-trigger">${triggerWords(d.trigger)}</p>
    ${show.runNow ? runNowPanel(d) : nothing}
    <div class="segmented pl-tabs" role="tablist">${tabs.map(([t, l]) => html`<button type="button" role="tab" aria-selected=${tab === t ? "true" : "false"} @click=${() => setTab(t)}>${l}</button>`)}</div>
    ${tab === "steps" ? stepsTab() : tab === "history" ? historyTab() : runsTab(d)}`;
}

let centred = "";

// Brings the step a run is at into view once, when the run is first shown.
function centre() {
  const canvas = document.querySelector(".pl-run-view .pl-canvas");
  const node = canvas?.querySelector(".pl-node.waiting, .pl-node.now");
  const run = document.querySelector(".pl-run-item.sel")?.dataset.id || "";
  if (!node || run === centred) return;
  centred = run;
  canvas.scrollLeft = node.offsetLeft - (canvas.clientWidth - node.offsetWidth) / 2;
  canvas.scrollTop = node.offsetTop - (canvas.clientHeight - node.offsetHeight) / 2;
}

function draw() {
  const root = $("pl-root");
  if (!data) return;
  const id = params().get("p");
  document.title = id && def ? `${def.name} · Pipelines · Yardbell` : "Pipelines · Yardbell";
  render(id && def ? pipelineView() : listView(), root);
  centre();
}

async function load() {
  const id = params().get("p");
  const [list, runs] = await Promise.all([api("GET", "/api/pipelines"), api("GET", "/api/runs")]);
  data = list;
  allRuns = runs.runs;
  if (id) {
    const found = data.pipelines.find((p) => p.definition.id === id)?.definition;
    if (!found) {
      toast(`There is no pipeline ${id}`);
      history.replaceState(null, "", location.pathname);
      def = null;
    } else {
      const editing = draft && def && def.id === id && JSON.stringify(draft) !== JSON.stringify(def);
      def = found;
      if (!editing) draft = structuredClone(found);
      if (params().get("tab") === "history") versions = (await api("GET", `/api/pipelines/${encodeURIComponent(id)}/history`)).history;
    }
  } else {
    def = null;
    draft = null;
  }
  draw();
}

window.addEventListener("popstate", () => load().catch((err) => toast(err.message)));
window.YardbellLive.follow(() => { if (!busy) load().catch(() => {}); }, 5000);
load().catch((err) => toast(err.message));
