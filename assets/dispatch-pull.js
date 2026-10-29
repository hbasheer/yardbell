import { html, nothing } from "/vendor/lit-html/lit-html.js";

let ctx = null;
const sending = new Set();
const opened = new Set();

const CHEVRON = html`<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>`;

export function setup(context) {
  ctx = context;
}

const KINDS = {
  ci: { word: "CI failed", badge: "failed" },
  changes_requested: { word: "Changes requested", badge: "blocked" },
  review: { word: "New comments", badge: "blocked" },
};

function kindOf(e) {
  if (e.kind === "ci") return KINDS.ci;
  return (e.notes || []).some((n) => n.kind === "changes_requested") ? KINDS.changes_requested : KINDS.review;
}

function noteSaid(n) {
  if (n.kind === "changes_requested") return "requested changes";
  if (n.kind === "inline" && n.place) return html`on <code>${n.place}</code>`;
  if (n.kind === "review") return "reviewed";
  return "commented";
}

// The line of a failed log that says what broke, so a folded check still tells you something.
function firstError(log) {
  const lines = String(log).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\b(error|fail(ed|ure)?|panicked)\b|[✗✕]/i.test(l)) || lines[0] || "";
}

function toggle(key) {
  opened.has(key) ? opened.delete(key) : opened.add(key);
  ctx.draw();
}

function checks(e, index) {
  return html`<ul class="pull-checks">${(e.checks || []).map((c, n) => {
    const key = `${ctx.conversation()}:${index}:check:${n}`;
    const open = opened.has(key);
    const head = c.log
      ? html`<button class="pull-check-head" type="button" aria-expanded=${open ? "true" : "false"} @click=${() => toggle(key)}>
          ${CHEVRON}<span class="pull-check-name">${c.name}</span>${open ? nothing : html`<code class="pull-check-first">${firstError(c.log)}</code>`}
        </button>`
      : html`<span class="pull-check-name">${c.name}</span>`;
    return html`<li>
      <div class="pull-check-row">${head}${c.url ? html`<a class="pull-check-link" href=${c.url} target="_blank" rel="noopener">View</a>` : nothing}</div>
      ${open ? html`<pre class="session-screen">${c.log}</pre>` : nothing}
    </li>`;
  })}</ul>`;
}

function noteBody(index, i, body) {
  const key = `${ctx.conversation()}:${index}:note:${i}`;
  const long = body.length > 240 || body.split("\n").length > 3;
  const open = opened.has(key);
  return html`<p class="pull-note-body ${long && !open ? "clamped" : ""}">${body}</p>
    ${long ? html`<button class="link-btn" type="button" @click=${() => toggle(key)}>${open ? "Show less" : "Show all"}</button>` : nothing}`;
}

function notes(e, index) {
  const more = e.more ? html`<li class="pull-more">${e.more} more on the ${window.YardbellPull.noun(e.pull || {}).toLowerCase()}.</li>` : nothing;
  return html`<ul class="pull-notes">${(e.notes || []).map((n, i) => html`<li>
    <div class="pull-note-head"><strong>${n.author || "A reviewer"}</strong> ${noteSaid(n)}${n.url ? html` · <a href=${n.url} target="_blank" rel="noopener">View</a>` : nothing}</div>
    ${n.body ? noteBody(index, i, n.body) : nothing}
  </li>`)}${more}</ul>`;
}

function stepOf(e) {
  const id = e.sent?.step;
  return id ? ctx.events().find((x) => x.role === "action" && x.id === id) : null;
}

function sentNote(e) {
  if (sending.has(e.key)) return { text: "Sending…", again: false };
  if (!e.sent) return null;
  const step = stepOf(e);
  if (!step) return { text: "Sent to the session.", again: false };
  if (step.status === "pending") return { text: "Waiting for your approval below.", again: false };
  if (step.status === "rejected" || step.status === "withdrawn") return { text: "", again: true };
  if (step.result && step.result.ok === false) return { text: `Not sent: ${step.result.text}`, again: false };
  const at = step.result?.at || step.decided;
  return { text: `Sent${at ? ` at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.`, again: false };
}

async function sendToSession(e, index) {
  sending.add(e.key);
  ctx.draw();
  try {
    const out = await ctx.api("POST", `/dispatch/conversations/${encodeURIComponent(ctx.conversation())}/pulls`, { card: index });
    ctx.replaceAt(index, out.card);
    ctx.addStep(out.step);
    ctx.toast(out.step.status === "pending" ? "Waiting for your approval below" : `Sent to ${e.name}`, "ok");
  } catch (err) {
    ctx.toast(err.message);
    if (/already/.test(err.message)) ctx.reload();
  }
  sending.delete(e.key);
  ctx.draw();
}

export function pullCard(e, index) {
  const pull = e.pull || {};
  const kind = kindOf(e);
  const sent = sentNote(e);
  const canSend = !sent || sent.again;
  return html`<div class="session-card pull-card ${e.kind === "ci" ? "failed" : "blocked"}">
    <header class="session-card-head">
      <div class="session-card-id">
        <strong>${pull.url ? html`<a href=${pull.url} target="_blank" rel="noopener">${window.YardbellPull.ref(pull)}</a>` : window.YardbellPull.ref(pull)} ${pull.title}</strong>
        <span class="session-card-where">${e.name} on ${e.machine}${e.branch ? html` · <code>${e.branch}</code>` : nothing}</span>
      </div>
      <span class="badge ${kind.badge}">${kind.word}</span>
    </header>
    ${e.kind === "ci" ? checks(e, index) : notes(e, index)}
    <div class="session-card-actions">
      ${canSend ? html`<button class="btn primary" type="button" ?disabled=${!e.name} title="Type this into ${e.name}, as your Dispatch rules allow" @click=${() => sendToSession(e, index)}><span class="btn-label">${sent?.again ? "Send again" : "Send to session"}</span></button>` : nothing}
      <a class="btn quiet" href=${ctx.termUrl(e.machine, e.name)} target="_blank" rel="noopener">Open</a>
      ${sent?.text ? html`<span class="session-card-answer">${sent.text}</span>` : nothing}
      <details class="pull-sends"><summary>What it sends</summary><p class="step-card-text">${e.instruction}</p></details>
    </div>
  </div>`;
}
