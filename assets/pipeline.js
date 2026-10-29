import { html, render, nothing } from "/vendor/lit-html/lit-html.js";

const $ = (id) => document.getElementById(id);
const STAGES = ["triage", "implement", "review", "qa", "finish"];
const AT = { triage: 0, implement: 1, review: 2, fix: 2, qa: 3, finish: 4 };
const ANSWERABLE = ["questions", "asked", "findings", "qa_failed"];

let data = { enabled: true, records: [], runs: [], test_machine: "" };
let tickets = null;
let picked = new Set();
let drafts = new Map();
let busy = false;

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
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 60000));
  if (Number.isNaN(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / 1440)} d`;
}

// How many queued tickets go before this one: those waiting for the same machine, or for triage.
function ahead(r) {
  const since = Date.parse(r.stage_since);
  return data.records.filter((o) => o.stage === "queued" && o.id !== r.id && o.machine === r.machine && Date.parse(o.stage_since) < since).length;
}

function word(r) {
  switch (r.stage) {
    case "queued": { const n = ahead(r); return n ? `Queued, ${n} ahead` : "Queued"; }
    case "triage": return "Triage";
    case "implement": return "Implement";
    case "review": return r.round ? `Review, round ${r.round + 1}` : "Review";
    case "fix": return r.fix_for === "qa" ? "Fix after QA" : "Fix";
    case "qa": return `QA on ${data.test_machine || "the test machine"}`;
    case "finish": return "Finish";
    case "done": return "Done";
    case "parked": return "Needs you";
    case "failed": return "Failed";
    default: return "Dropped";
  }
}

function where(r) {
  if (r.stage === "parked") return AT[r.parked?.from] ?? -1;
  if (r.stage === "failed") return AT[r.failed_at] ?? -1;
  if (r.stage === "queued") return r.machine ? 1 : 0;
  if (r.stage === "done") return STAGES.length;
  return AT[r.stage] ?? -1;
}

function marks(r) {
  const at = where(r);
  const stopped = ["parked", "failed", "dropped"].includes(r.stage);
  const running = !stopped && !["queued", "done"].includes(r.stage);
  return html`<ol class="pl-stages" aria-label="Stages">${STAGES.map((s, i) => {
    const state = i < at ? "done" : i === at && running ? "current" : i === at && stopped ? "stopped" : "";
    return html`<li class="pl-stage ${state}" data-stage=${s} title=${s === "qa" ? "QA" : s[0].toUpperCase() + s.slice(1)}></li>`;
  })}</ol>`;
}

async function act(r, what, body) {
  busy = true;
  draw();
  try {
    await api("POST", `/api/pipeline/tickets/${encodeURIComponent(r.id)}/${what}`, body || {});
    if (what === "answer") drafts.delete(r.id);
    await load();
  } catch (err) {
    toast(err.message);
  }
  busy = false;
  draw();
}

function row(r) {
  const active = !["done", "dropped"].includes(r.stage);
  return html`<li class="pl-row ${r.stage}" data-id=${r.id}>
    <div class="pl-ticket-id">
      <a class="pl-id" href=${r.url || nothing} target="_blank" rel="noopener">${r.id}</a>
      <span class="pl-title">${r.title}</span>
    </div>
    ${marks(r)}
    <span class="pl-word">${word(r)}</span>
    <span class="pl-meta">
      <span class="pl-meta-line">
        ${r.machine ? html`<span class="pl-machine" title=${r.reason || ""}>${r.machine}</span>` : nothing}
        ${active && r.stage_since ? html`<span class="pl-since" title="Time in this stage">${ago(r.stage_since)} in this stage</span>` : nothing}
        ${r.pull ? html`<a class="pl-pull" href=${r.pull.url} target="_blank" rel="noopener">Draft #${r.pull.number}</a>` : nothing}
      </span>
      ${r.branch ? html`<code class="pl-branch">${r.branch}</code>` : nothing}
    </span>
    <span class="pl-actions">
      ${r.conversation ? html`<a class="btn quiet" href=${`/dispatch?c=${encodeURIComponent(r.conversation)}`}>Conversation</a>` : nothing}
      ${active ? html`<button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => act(r, "drop")}>Stop</button>` : nothing}
    </span>
  </li>`;
}

function why(r) {
  if (r.stage === "failed") return html`<p class="pl-reason">Failed in ${word({ ...r, stage: r.failed_at || "" })}.</p>${r.failed ? html`<pre class="session-screen">${r.failed}</pre>` : nothing}`;
  const p = r.parked || {};
  const open = (r.questions || []).filter((q) => !q.answer);
  return html`<p class="pl-reason">${p.reason}</p>
    ${p.kind === "questions" && open.length ? html`<ol class="pl-questions">${open.map((q) => html`<li>${q.asked}</li>`)}</ol>` : nothing}
    ${p.kind === "findings" && r.findings?.length ? html`<ul class="pl-findings">${r.findings.map((f) => html`<li>${f}</li>`)}</ul>` : nothing}
    ${p.kind === "qa_failed" && r.qa_report ? html`<pre class="session-screen">${r.qa_report}</pre>` : nothing}
    ${p.screen ? html`<pre class="session-screen">${p.screen}</pre>` : nothing}`;
}

function need(r) {
  const answerable = r.stage === "parked" && ANSWERABLE.includes(r.parked?.kind);
  const draft = drafts.get(r.id) || "";
  return html`<article class="pl-need" data-id=${r.id}>
    <header class="pl-need-head">
      <a class="pl-id" href=${r.url || nothing} target="_blank" rel="noopener">${r.id}</a>
      <strong class="pl-title">${r.title}</strong>
      <span class="badge ${r.stage === "failed" ? "failed" : "blocked"}">${r.stage === "failed" ? "Failed" : "Needs you"}</span>
    </header>
    ${why(r)}
    ${answerable ? html`<label class="visually-hidden" for=${`answer-${r.id}`}>Your answer for ${r.id}</label>
      <textarea id=${`answer-${r.id}`} rows="2" placeholder="Your answer" .value=${draft} @input=${(e) => { drafts.set(r.id, e.target.value); draw(); }}></textarea>` : nothing}
    <div class="pl-need-actions">
      <button class="btn quiet danger" type="button" ?disabled=${busy} @click=${() => act(r, "drop")}>Drop</button>
      <button class="btn" type="button" ?disabled=${busy} @click=${() => act(r, "retry")}>Retry</button>
      ${answerable ? html`<button class="btn primary" type="button" ?disabled=${busy || !draft.trim()} @click=${() => act(r, "answer", { text: draft })}>Send answer</button>` : nothing}
    </div>
  </article>`;
}

function runHead(run) {
  const parked = run.parked;
  const by = run.started_by === "you" ? "started by you" : `started by ${run.started_by.replace(/^trigger:/, "the trigger ")}`;
  const summary = run.active ? `${run.active} working` : `${run.done} done, ${parked} ${parked === 1 ? "needs" : "need"} you, ${run.failed} failed`;
  return html`<p class="pl-run-head"><span>${by}</span><span class="pl-run-sum">${summary}</span></p>`;
}

function stateOf(t) {
  return t.state || "No state";
}

function drawPicker() {
  const list = tickets || [];
  const filter = $("pl-state").value;
  const shown = list.filter((t) => !filter || stateOf(t) === filter);
  const states = [...new Set(list.map(stateOf))];
  $("pl-state").closest("label").hidden = !tickets;
  render(html`<option value="">All states</option>${states.map((s) => html`<option value=${s} ?selected=${s === filter}>${s}</option>`)}`, $("pl-state"));
  render(tickets && !shown.length ? html`<li class="pl-empty">No open tickets${filter ? ` in ${filter}` : ""}.</li>` : shown.map((t) => html`<li class="pl-ticket" data-id=${t.id}>
    <label>
      <input type="checkbox" .checked=${picked.has(t.id)} ?disabled=${t.running} @change=${(e) => { e.target.checked ? picked.add(t.id) : picked.delete(t.id); draw(); }}>
      <span class="pl-id">${t.id}</span>
      <span class="pl-title">${t.title}</span>
      <span class="pl-state-word">${t.running ? "In a run" : stateOf(t)}</span>
    </label>
  </li>`), $("pl-tickets"));
  const n = picked.size;
  $("pl-start").textContent = `Start ${n} ${n === 1 ? "ticket" : "tickets"}`;
  $("pl-start").disabled = busy || !n;
  $("pl-start").hidden = !tickets;
  const waiting = shown.filter((t) => !t.running).length;
  $("pl-start-state").hidden = !filter || !waiting;
  $("pl-start-state").textContent = `Start all in ${filter}`;
  $("pl-start-state").disabled = busy;
  $("pl-load").textContent = tickets ? "Refresh" : "Show my open tickets";
}

function draw() {
  $("pl-off").hidden = data.enabled;
  const needs = data.records.filter((r) => r.stage === "parked" || r.stage === "failed");
  $("pl-needs-section").hidden = !needs.length;
  render(needs.map(need), $("pl-needs"));
  const groups = data.runs.map((run) => ({ run, records: data.records.filter((r) => r.run === run.run) }));
  render(groups.length
    ? groups.map(({ run, records }) => html`<div class="pl-run">${runHead(run)}<ul class="pl-rows">${records.map(row)}</ul></div>`)
    : html`<p class="pl-empty">No runs yet. Start one below, or let a trigger start one.</p>`, $("pl-runs"));
  drawPicker();
}

async function load() {
  data = await api("GET", "/api/pipeline");
  if (tickets) {
    const running = new Set(data.records.filter((r) => !["done", "failed", "dropped"].includes(r.stage)).map((r) => r.id));
    tickets = tickets.map((t) => ({ ...t, running: running.has(t.id) }));
    for (const id of running) picked.delete(id);
  }
  draw();
}

async function loadTickets() {
  busy = true;
  draw();
  try {
    tickets = (await api("GET", "/api/pipeline/tickets")).tickets;
  } catch (err) {
    toast(err.message);
  }
  busy = false;
  draw();
}

async function start(body) {
  busy = true;
  draw();
  try {
    const out = await api("POST", "/api/pipeline/runs", body);
    picked = new Set();
    toast(`Started ${out.records.length} ${out.records.length === 1 ? "ticket" : "tickets"}`, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  }
  busy = false;
  draw();
}

$("pl-load").addEventListener("click", loadTickets);
$("pl-state").addEventListener("change", draw);
$("pl-start").addEventListener("click", () => start({ ids: [...picked] }));
$("pl-start-state").addEventListener("click", () => start({ state: $("pl-state").value }));

window.YardbellLive.follow(() => load().catch(() => {}), 5000);
load().catch((err) => toast(err.message));
