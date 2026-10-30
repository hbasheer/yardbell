import { html, nothing, render } from "/vendor/lit-html/lit-html.js";
import * as steps from "/dispatch-review.js";

const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
let proposals = null;

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
  const sure = await Nav.confirm("Delete this proposal?", waiting ? "It has not run, and it will not." : "Its card goes; what it did stays done.", { confirm: "Delete", danger: true });
  if (!sure) return;
  try {
    await api("DELETE", `/api/proposals/${encodeURIComponent(p.id)}`);
    proposals = proposals.filter((x) => x.id !== p.id);
    draw();
    Nav.refresh?.();
  } catch (err) {
    toast(err.message);
  }
}

async function clearDecided() {
  if (!(await Nav.confirm("Clear every decided proposal?", "Ones still waiting for you stay.", { confirm: "Clear", danger: true }))) return;
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

function section(title, list, action = nothing) {
  if (!list.length) return nothing;
  return html`<section class="pr-section"><div class="pr-section-head"><h2 class="pr-head">${title}</h2>${action}</div><div class="pr-list">${list.map(item)}</div></section>`;
}

function draw() {
  if (!proposals) return;
  const waiting = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  render(proposals.length
    ? html`${section("Waiting for you", waiting)}${section("Decided", decided, html`<button class="btn quiet small-link" type="button" id="pr-clear" @click=${clearDecided}>Clear decided</button>`)}`
    : html`<p class="pr-empty">Nothing waits for you. Changes that MCP clients ask for land here.</p>`, $("pr-root"));
  steps.afterDraw();
}

async function load() {
  proposals = (await api("GET", "/api/proposals")).proposals;
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
  decided: () => window.YardbellNav?.refresh(),
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
load().catch((err) => toast(err.message));
