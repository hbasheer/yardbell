import { html, nothing, render } from "/vendor/lit-html/lit-html.js";
import * as steps from "/dispatch-review.js";

const $ = (id) => document.getElementById(id);
const Shell = window.YardbellShell;
let proposals = null;
let showing = "all";

Shell.column.innerHTML = '<nav class="col-list" aria-label="Proposals"></nav>';
const mark = Shell.spy();
const loadState = () => Shell.loadState().catch(() => {});

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
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

async function remove(p) {
  const waiting = p.status === "pending";
  const sure = await Shell.confirm("Delete this proposal?", waiting ? "It has not run, and it will not." : "Its card goes; what it did stays done.", { confirm: "Delete", danger: true });
  if (!sure) return;
  try {
    await api("DELETE", `/api/proposals/${encodeURIComponent(p.id)}`);
    proposals = proposals.filter((x) => x.id !== p.id);
    draw();
    loadState();
  } catch (err) {
    toast(err.message);
  }
}

async function clearDecided() {
  if (!(await Shell.confirm("Clear every decided proposal?", "Ones still waiting for you stay.", { confirm: "Clear", danger: true }))) return;
  try {
    await api("POST", "/api/proposals/clear", {});
    proposals = proposals.filter((p) => p.status === "pending");
    draw();
  } catch (err) {
    toast(err.message);
  }
}

function item(p) {
  return html`<div class="pr-item">${steps.stepCard(p)}<button class="btn quiet danger pr-delete" type="button" aria-label=${`Delete the proposal: ${p.tool}`} @click=${() => remove(p)}>Delete</button></div>`;
}

function section(id, title, list, action = nothing) {
  if (!list.length) return nothing;
  return html`<section class="pr-section" id=${id}><div class="pr-section-head"><h2 class="pr-head">${title}</h2>${action}</div><div class="pr-list">${list.map(item)}</div></section>`;
}

function columnRow(name, list, id) {
  return list.length
    ? html`<a class="col-row" href=${`#${id}`} @click=${() => { if (showing !== "all") { showing = "all"; draw(); } }}><span class="col-row-name">${name}</span><span class="col-row-meta">${list.length}</span></a>`
    : html`<span class="col-row" aria-disabled="true"><span class="col-row-name">${name}</span><span class="col-row-meta">0</span></span>`;
}

function tabs(waiting, decided) {
  const tab = (key, label, count) => html`<button type="button" data-show=${key} aria-pressed=${String(showing === key)} @click=${() => { showing = key; draw(); }}>${label}${count ? html`<span class="seg-count">${count}</span>` : nothing}</button>`;
  return html`<div class="segmented pill-tabs" role="group" aria-label="Show proposals">${tab("all", "All")}${tab("waiting", "Waiting", waiting.length)}${tab("decided", "Decided", decided.length)}</div>`;
}

const EMPTY = {
  all: "Nothing waits for you. Changes that MCP clients ask for land here.",
  waiting: "Nothing waits for you.",
  decided: "Nothing decided yet.",
};

function draw() {
  if (!proposals) return;
  const waiting = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  render(html`${columnRow("Waiting", waiting, "pr-waiting")}${columnRow("Decided", decided, "pr-decided")}`, Shell.column.firstElementChild);
  render(tabs(waiting, decided), $("pr-tabs"));
  const shown = (key) => showing === "all" || showing === key;
  const any = (shown("waiting") && waiting.length) || (shown("decided") && decided.length);
  render(any
    ? html`${shown("waiting") ? section("pr-waiting", "Waiting for you", waiting) : nothing}${shown("decided") ? section("pr-decided", "Decided", decided, html`<button class="btn quiet small-link" type="button" id="pr-clear" @click=${clearDecided}>Clear decided</button>`) : nothing}`
    : html`<p class="pr-empty">${EMPTY[showing]}</p>`, $("pr-root"));
  steps.afterDraw();
  mark();
}

// Opening the page, or coming back to it, tells the server the person has seen what waits.
async function load(opened = false) {
  proposals = (await api("GET", `/api/proposals${opened ? "?opened=1" : ""}`)).proposals;
  draw();
}

steps.setup({
  api,
  toast,
  draw,
  termUrl: (machine, name) => `/term/${encodeURIComponent(machine)}/${encodeURIComponent(name)}`,
  short: (path) => path,
  folderOf: () => "",
  conversation: () => "",
  state: () => null,
  loadState: async () => {},
  reload: () => load().catch((err) => toast(err.message)),
  decided: loadState,
  replaceStep(step) {
    const i = proposals.findIndex((p) => p.id === step.id);
    if (i >= 0) proposals[i] = step;
  },
  replaceAt() {},
  addStep() {},
  stepUrl: (e) => `/api/proposals/${encodeURIComponent(e.id)}`,
  builderKey: (e) => `inbox.${e.id}`,
});

// A card being edited keeps its draft; the list refreshes around it.
window.YardbellLive.follow(() => { if (!proposals?.some((p) => steps.isEditing(p.id))) load().catch(() => {}); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true).catch(() => {}); });
load(true).catch((err) => toast(err.message));
loadState();
window.YardbellLive.follow(loadState, 10000);
