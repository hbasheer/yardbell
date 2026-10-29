import { html, nothing } from "/vendor/lit-html/lit-html.js";

let ctx = null;
const sending = new Set();

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

function checks(e) {
  return html`<ul class="pull-checks">${(e.checks || []).map((c) => html`<li>
    <span class="pull-check-name">${c.url ? html`<a href=${c.url} target="_blank" rel="noopener">${c.name}</a>` : c.name}</span>
    ${c.log ? html`<pre class="session-screen">${c.log}</pre>` : nothing}
  </li>`)}</ul>`;
}

function notes(e) {
  const more = e.more ? html`<li class="pull-more">${e.more} more on the ${window.YardbellPull.noun(e.pull || {}).toLowerCase()}.</li>` : nothing;
  return html`<ul class="pull-notes">${(e.notes || []).map((n) => html`<li>
    <div class="pull-note-head"><strong>${n.author || "A reviewer"}</strong> ${noteSaid(n)}${n.url ? html` · <a href=${n.url} target="_blank" rel="noopener">View</a>` : nothing}</div>
    ${n.body ? html`<p class="pull-note-body">${n.body}</p>` : nothing}
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
    ${e.kind === "ci" ? checks(e) : notes(e)}
    <div class="pull-send">
      <span class="step-card-label">Send to session types</span>
      <p class="step-card-text">${e.instruction}</p>
    </div>
    <div class="session-card-actions">
      ${canSend ? html`<button class="btn primary" type="button" ?disabled=${!e.name} title="Type this into ${e.name}, as your Dispatch rules allow" @click=${() => sendToSession(e, index)}><span class="btn-label">${sent?.again ? "Send again" : "Send to session"}</span></button>` : nothing}
      <a class="btn quiet" href=${ctx.termUrl(e.machine, e.name)} target="_blank" rel="noopener">Open</a>
      ${sent?.text ? html`<span class="session-card-answer">${sent.text}</span>` : nothing}
    </div>
  </div>`;
}
