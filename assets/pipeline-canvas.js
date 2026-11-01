import { html, svg, nothing } from "/vendor/lit-html/lit-html.js";

export const NODE_W = 220;
export const NODE_H = 124;
const START_GAP = 280;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const MINI_W = 168;
const MINI_H = 104;
export const OUTCOMES = ["pass", "fail", "needs_you"];
export const WORDS = { pass: "passed", fail: "failed", needs_you: "needs you" };
const LINE_WORDS = { pass: "pass", fail: "fail", needs_you: "needs you" };
const PORT_Y = { pass: 0.3, fail: 0.55, needs_you: 0.8 };

export const KINDS = {
  agent: "Agent step",
  plan: "Plan",
  push: "Push and draft PR",
  update: "Update the ticket",
  checks: "Wait for CI and reviews",
  call: "Use a connected tool",
  tool: "Use a connected tool",
  command: "Run a command",
  report: "Report to me",
  wait: "Wait for me",
};

const ICONS = {
  start: "M5.5 3.5v9l7-4.5z",
  manual: "M5.5 8V4a1 1 0 0 1 2 0v3.5 M7.5 7V3a1 1 0 0 1 2 0v4 M9.5 7.5V4.5a1 1 0 0 1 2 0V9a4.5 4.5 0 0 1-8.2 2.6L2.6 9.4a1 1 0 0 1 1.6-1.2l1.3 1.3",
  schedule: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M8 5v3l2 1.5",
  ticket: "M2.5 5a1.5 1.5 0 0 0 0 3v3h11V8a1.5 1.5 0 0 1 0-3V2.5h-11z M6.5 4.5v6",
  pull: "M4.5 2.5v11 M4.5 4.5a1.5 1.5 0 1 0 0-.01 M11.5 13.5a1.5 1.5 0 1 0 0-.01 M11.5 12V7a2 2 0 0 0-2-2H7",
  agent: "M2.5 3.5h11v9h-11z M5 6.5l2 1.5-2 1.5 M8.5 10h2.5",
  plan: "M8 2.5v11 M3.5 4.5h6.5l2 1.75-2 1.75H3.5z",
  push: "M8 13V3.5 M4.5 7 8 3.5 11.5 7",
  checks: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M5.5 8l1.75 1.75L10.5 6.5",
  update: "M3 3.5h10v9H3z M5.5 8l1.75 1.75L10.5 6.5",
  call: "M2.5 8h8 M8 5l3 3-3 3 M13.5 3v10",
  tool: "M9.5 3.5a3 3 0 0 0-3.8 3.8L2.5 10.5l3 3 3.2-3.2a3 3 0 0 0 3.8-3.8l-2 2-2-2z",
  command: "M3 4.5 6.5 8 3 11.5 M8 12h5",
  report: "M2.5 4h11v8h-11z M2.5 4 8 8.5 13.5 4",
  wait: "M6 4v8 M10 4v8",
};

export function icon(kind) {
  return html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d=${ICONS[kind] || ICONS.agent}></path></svg>`;
}

const isStep = (d, id) => d.steps.some((s) => s.id === id);

export function machineWord(step) {
  const m = step.machine || {};
  if ("name" in m) return m.name;
  if ("same_as" in m) return `same machine as ${m.same_as}`;
  return m.pick?.length ? m.pick.join(" or ") : "any machine";
}

function workspaceWord(step) {
  const w = step.workspace || {};
  if (w.kind === "same_as") return `folder of ${w.step}`;
  if (w.kind === "copy") return `copy of ${w.from}`;
  return "new worktree";
}

function ago(stamp) {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 60000));
  if (!stamp || Number.isNaN(mins)) return "";
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / 1440)} d`;
}

export function nodeState(run, step) {
  if (!run) return { cls: "", mark: "", note: "" };
  const st = run.steps?.[step.id];
  const current = run.step === step.id && ["queued", "running", "waiting"].includes(run.state);
  if (current && run.state === "waiting") {
    const reason = run.waiting?.reason || "waiting";
    const note = run.waiting?.kind === "needs_you" ? "needs you" : reason.startsWith(`${step.name} `) ? reason.slice(step.name.length + 1) : reason;
    return { cls: "waiting", mark: "!", note };
  }
  if (current && step.kind === "checks" && st?.watch?.status) return { cls: "now", mark: "", note: `${st.watch.status} · ${ago(run.step_since)}` };
  if (current) return { cls: "now", mark: "", note: run.state === "queued" ? (run.held ? "held" : "queued") : `running · ${ago(run.step_since)}` };
  if (st?.outcome) {
    const runs = st.runs > 1 ? ` · ${st.runs} runs` : "";
    return { cls: `done ${st.outcome === "fail" ? "failed" : ""}`, mark: st.outcome === "fail" ? "✗" : "✓", note: `${WORDS[st.outcome]}${runs}` };
  }
  return { cls: "later", mark: "", note: "not reached" };
}

// Where the Start node sits, and the box every node fits in, in definition coordinates.
function layout(d) {
  const first = d.steps.find((s) => s.id === d.start);
  const start = first ? { x: first.x - START_GAP, y: first.y } : { x: 40, y: 120 };
  const xs = [start.x, ...d.steps.map((s) => s.x)];
  const ys = [start.y, ...d.steps.map((s) => s.y)];
  const minX = Math.min(...xs) - 60, minY = Math.min(...ys) - 60;
  return {
    start,
    ox: -minX,
    oy: -minY,
    width: Math.max(...xs) - minX + NODE_W + 60,
    height: Math.max(...ys) - minY + NODE_H + 200,
  };
}

function cubicMid(p0, p1, p2, p3) {
  const at = (a, b, c, e) => 0.125 * a + 0.375 * b + 0.375 * c + 0.125 * e;
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) };
}

// A line from an out port to an in port: a plain curve forwards, a loop under both cards backwards.
export function line(a, b) {
  if (b.x >= a.x + 40) {
    const dx = Math.max(40, (b.x - a.x) / 2);
    const c1 = { x: a.x + dx, y: a.y }, c2 = { x: b.x - dx, y: b.y };
    return { d: `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`, label: cubicMid(a, c1, c2, b) };
  }
  const otherRow = Math.abs(b.y - a.y) > NODE_H * 0.75;
  const turn = otherRow ? (a.y + b.y) / 2 : Math.max(a.y, b.y) + NODE_H / 2 + 56;
  const mid = { x: (a.x + b.x) / 2, y: turn };
  return {
    d: `M${a.x} ${a.y} C${a.x + 70} ${a.y} ${a.x + 70} ${turn} ${mid.x} ${turn} S${b.x - 70} ${b.y} ${b.x} ${b.y}`,
    label: mid,
  };
}

function outPort(s, outcome, ox, oy) {
  return { x: s.x + ox + NODE_W, y: s.y + oy + NODE_H * PORT_Y[outcome] };
}

function inPort(s, ox, oy) {
  return { x: s.x + ox, y: s.y + oy + NODE_H / 2 };
}

const views = new Map();
let held = null;
const touches = new Map();

function viewOf(canvas) {
  return views.get(canvas.dataset.key);
}

function place(canvas) {
  const v = viewOf(canvas);
  if (!v) return;
  canvas.querySelector(".pl-pan").style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  canvas.style.backgroundPosition = `${v.x}px ${v.y}px`;
  canvas.style.backgroundSize = `${24 * v.k}px ${24 * v.k}px`;
  const pct = canvas.querySelector(".pl-zoom-pct");
  if (pct) pct.textContent = `${Math.round(v.k * 100)}%`;
  const mini = canvas.querySelector(".pl-minimap");
  if (mini) {
    const s = Number(mini.dataset.scale);
    const r = mini.querySelector(".pl-mini-view");
    r.setAttribute("x", String((-v.x / v.k) * s));
    r.setAttribute("y", String((-v.y / v.k) * s));
    r.setAttribute("width", String((canvas.clientWidth / v.k) * s));
    r.setAttribute("height", String((canvas.clientHeight / v.k) * s));
  }
}

function setView(canvas, v) {
  views.set(canvas.dataset.key, { ...v, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k)) });
  place(canvas);
}

// Fits the whole graph when it stays readable, and otherwise shows it at a readable size
// centred on the step that matters: the one the run is at, or the selected one.
function fit(canvas, whole = false) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const w = Number(canvas.dataset.width), h = Number(canvas.dataset.height);
  if (!cw || !ch) return;
  const all = Math.min(1, (cw - 32) / w, (ch - 32) / h);
  const k = whole ? Math.max(MIN_ZOOM, all) : all >= 0.75 ? all : 0.85;
  let x = (cw - w * k) / 2, y = Math.max(16, (ch - h * k) / 2);
  const focus = canvas.querySelector(".pl-node.waiting, .pl-node.now, .pl-node.selected");
  const node = focus || canvas.querySelector(".pl-node");
  if (!whole && w * k > cw) x = focus ? cw / 2 - (focus.offsetLeft + focus.offsetWidth / 2) * k : 16;
  if (!whole && h * k > ch && node) y = ch / 2 - (node.offsetTop + node.offsetHeight / 2) * k;
  setView(canvas, { x, y, k });
}

export function fitAll(canvas) {
  fit(canvas, true);
}

function zoomAt(canvas, factor, px, py) {
  const v = viewOf(canvas);
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
  setView(canvas, { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
}

function zoomBy(e, factor) {
  const canvas = e.target.closest(".pl-canvas");
  zoomAt(canvas, factor, canvas.clientWidth / 2, canvas.clientHeight / 2);
}

// Where a point of the window lands in definition coordinates.
export function toWorld(canvas, clientX, clientY) {
  const v = viewOf(canvas);
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left - v.x) / v.k - Number(canvas.dataset.ox),
    y: (clientY - r.top - v.y) / v.k - Number(canvas.dataset.oy),
  };
}

const OWN_DRAG = ".pl-zoom, .pl-minimap, .pl-canvas-bar, button, input, select, textarea, a";
const SNAP = 8;
const snap = (n) => Math.round(n / SNAP) * SNAP;

// Where a point of the window lands inside the drawing (definition coordinates plus the offsets).
function toInner(canvas, clientX, clientY) {
  const v = viewOf(canvas);
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
}

function ghost(canvas, from, to) {
  const g = canvas.querySelector(".pl-ghost");
  if (g) g.setAttribute("d", from ? line(from, to).d : "");
}

function grab(e, on) {
  const canvas = e.currentTarget;
  if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (e.button !== 0 || e.target.closest(OWN_DRAG)) return;
  const port = canvas.classList.contains("editable") && e.target.closest(".pl-port.out");
  const node = canvas.classList.contains("editable") && e.target.closest(".pl-node.editable:not(.pl-start)");
  if (port) {
    const r = port.getBoundingClientRect();
    held = { id: e.pointerId, kind: "line", from: port.closest(".pl-node").dataset.step, outcome: port.dataset.outcome, start: toInner(canvas, r.left + r.width / 2, r.top + r.height / 2), x: e.clientX, y: e.clientY, moved: false };
  } else if (node) {
    held = { id: e.pointerId, kind: "card", step: node.dataset.step, at: { x: Number(node.dataset.x), y: Number(node.dataset.y) }, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false };
  } else {
    held = { id: e.pointerId, kind: "pan", x: e.clientX, y: e.clientY, moved: false };
  }
}

// Capturing only once the pointer moves keeps a plain click on the card or line it landed on.
function hold(canvas, e) {
  if (held.captured) return;
  held.captured = true;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  canvas.classList.add("grabbing");
}

function drag(e, on) {
  const canvas = e.currentTarget;
  if (touches.has(e.pointerId)) {
    const before = [...touches.values()];
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const after = [...touches.values()];
      const dist = (p) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const r = canvas.getBoundingClientRect();
      zoomAt(canvas, dist(after) / dist(before), (after[0].x + after[1].x) / 2 - r.left, (after[0].y + after[1].y) / 2 - r.top);
      held = null;
      return;
    }
  }
  if (!held || held.id !== e.pointerId) return;
  const v = viewOf(canvas);
  if (held.kind === "line") {
    held.moved ||= Math.hypot(e.clientX - held.x, e.clientY - held.y) > 4;
    hold(canvas, e);
    ghost(canvas, held.start, toInner(canvas, e.clientX, e.clientY));
    return;
  }
  if (held.kind === "card") {
    const far = Math.hypot(e.clientX - held.x0, e.clientY - held.y0) > 4;
    if (far && !held.moved) {
      held.moved = true;
      hold(canvas, e);
      on?.begin?.();
    }
    if (held.moved) on?.move?.(held.step, snap(held.at.x + (e.clientX - held.x0) / v.k), snap(held.at.y + (e.clientY - held.y0) / v.k));
    return;
  }
  held.moved ||= Math.hypot(e.clientX - held.x, e.clientY - held.y) > 3;
  if (!held.moved) return;
  hold(canvas, e);
  setView(canvas, { ...v, x: v.x + e.clientX - held.x, y: v.y + e.clientY - held.y });
  held = { ...held, x: e.clientX, y: e.clientY };
}

function letGo(e, on) {
  touches.delete(e.pointerId);
  const canvas = e.currentTarget;
  canvas.classList.remove("grabbing");
  const h = held;
  held = null;
  if (!h || h.id !== e.pointerId) return;
  if (h.kind === "line") {
    ghost(canvas, null);
    if (e.type !== "pointerup") return;
    // A click on a port, or a line dropped back on its own card, changes nothing.
    if (!h.moved) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".pl-node[data-step]");
    if (over && over.dataset.step !== "@start" && over.dataset.step !== h.from) on?.connect?.(h.from, h.outcome, over.dataset.step);
    else if (!over) on?.drop?.(null, toWorld(canvas, e.clientX, e.clientY), h.from, h.outcome, e.clientX, e.clientY);
    return;
  }
  if (h.kind === "pan" && !h.moved && e.type === "pointerup" && !e.target.closest(".pl-node, .pl-edge-hit")) on?.select?.(null);
}

// A trackpad pinch arrives as a wheel event with ctrlKey; two-finger scrolling pans.
function wheel(e) {
  const canvas = e.currentTarget;
  if (e.target.closest(".pl-node textarea, .pl-node select")) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = canvas.getBoundingClientRect();
    zoomAt(canvas, Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
    return;
  }
  const v = viewOf(canvas);
  setView(canvas, { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
}

function seeFromMinimap(e) {
  const canvas = e.currentTarget.closest(".pl-canvas");
  const mini = e.currentTarget;
  const r = mini.getBoundingClientRect();
  const s = Number(mini.dataset.scale);
  const v = viewOf(canvas);
  const wx = (e.clientX - r.left) / s, wy = (e.clientY - r.top) / s;
  setView(canvas, { ...v, x: canvas.clientWidth / 2 - wx * v.k, y: canvas.clientHeight / 2 - wy * v.k });
}

function minimap(d, lay, run) {
  const s = Math.min(MINI_W / lay.width, MINI_H / lay.height);
  const press = (e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seeFromMinimap(e);
  };
  const move = (e) => {
    if (e.buttons) seeFromMinimap(e);
  };
  return html`<svg class="pl-minimap" data-scale=${s} width=${lay.width * s} height=${lay.height * s} aria-label="Overview; click to move there" @pointerdown=${press} @pointermove=${move}>
    ${[{ x: lay.start.x, y: lay.start.y, id: "" }, ...d.steps].map((n) => svg`<rect class=${`pl-mini-node ${n.id && run ? nodeState(run, n).cls : ""}`} x=${(n.x + lay.ox) * s} y=${(n.y + lay.oy) * s} width=${NODE_W * s} height=${NODE_H * s} rx="2"></rect>`)}
    <rect class="pl-mini-view" x="0" y="0" width="0" height="0" rx="3"></rect>
  </svg>`;
}

let connectors = [];
export function setConnectors(list) {
  connectors = list || [];
}

const connectorOf = (id) => connectors.find((c) => c.id === id);
const connectorName = (id) => connectorOf(id)?.name || id || "a connected tool";

function filterWords(t) {
  if (t?.kind === "connector") {
    const chosen = (connectorOf(t.connector)?.params || []).filter((p) => p.filter && t.params?.[p.name]);
    return chosen.length ? `filtered by ${chosen.map((p) => (p.label || p.name).toLowerCase()).join(" and ")}` : "";
  }
  const part = (word, list) => (list?.length ? `${word} ${list.join(" or ")}` : "");
  return [part("label", t?.filter?.labels), part("team", t?.filter?.teams), part("project", t?.filter?.projects)].filter(Boolean).join(", ");
}

export function triggerWords(t) {
  const narrowed = filterWords(t) ? `, ${filterWords(t)}` : "";
  switch (t?.kind) {
    case "schedule": return `On the schedule ${t.schedule || "(not set)"}${t.state ? `, my open ${t.connector ? `${connectorName(t.connector)} items` : "tickets"} in ${t.state}` : ""}`;
    case "connector": return `When ${connectorName(t.connector)} has a new item${t.states?.length ? " in the states you picked" : ""}${narrowed}`;
    case "webhook": return "When another system calls this pipeline's web address";
    case "linear":
      if (t.states?.length) return `When a Linear ticket${t.assigned ? " of mine" : ""} moves to ${t.states.join(" or ")}${narrowed}`;
      return `When a Linear ticket is assigned to me${narrowed}`;
    case "github_review": return "When someone asks me to review a GitHub pull request";
    case "gitlab_reviewer": return `When a GitLab merge request on ${t.host || "a host you pick"} adds me as reviewer`;
    default: return "By hand, from Run now";
  }
}

const TRIGGER_TAGS = { manual: "by hand", schedule: "schedule", linear: "Linear", github_review: "GitHub", gitlab_reviewer: "GitLab", webhook: "webhook", connector: "connected tool" };

// Every card says the same four things in the same places: what it is, who does it, what it does
// (or how far the run got) and where.
export function describe(s) {
  switch (s.kind) {
    case "agent": return { who: s.read_only ? "Agent · read only" : "Agent", does: s.instructions || "No instructions yet", tags: [machineWord(s), workspaceWord(s)] };
    case "plan": return { who: "Agent · Dispatch", does: "Picks the machine, folder and branch, or asks you", tags: [s.machines?.length ? s.machines.join(" or ") : "any machine"] };
    case "push": return { who: "Yardbell", does: "Pushes the branch and opens a draft pull or merge request", tags: ["secret check", "never forced"] };
    case "checks": return { who: "Yardbell", does: s.require_approval ? "Waits for CI to pass and an approval, then follows pass or fail" : "Waits for CI to pass, then follows pass or fail", tags: ["no agent", s.require_approval ? "needs approval" : "CI only"] };
    case "update": return { who: "Yardbell · the ticket's tool", does: s.action === "move" ? `Moves the ticket to ${s.state || "a state you pick"}` : "Comments on the ticket, or drafts it for Linear", tags: [s.action === "move" ? "move" : "comment"] };
    case "call": {
      const call = connectorOf(s.connector)?.calls?.find((c) => c.name === s.call);
      return { who: `Yardbell · ${connectorName(s.connector)}`, does: s.call ? `Calls ${s.call}` : "Pick a call", tags: [call?.kind === "lookup" ? "Reads" : "Changes"] };
    }
    case "tool": return { who: `Yardbell · ${s.server || "MCP"}`, does: s.tool ? `Calls ${s.tool}` : "Pick a tool", tags: [s.call_kind === "lookup" ? "Reads" : "Changes"] };
    case "command": return { who: "Yardbell · no agent", does: s.command || "No command yet", tags: [s.command && s.approved !== s.command ? "Not approved yet" : "Exit code decides"] };
    case "report": return { who: "Yardbell · Dispatch", does: "Writes what the run found and tells you", tags: ["phone notification"] };
    case "wait": return { who: "You", does: s.message || "Waits until you continue it", tags: ["needs you"] };
    default: return { who: "", does: "", tags: [] };
  }
}

function body({ iconKind, name, mark, who, does, tags }) {
  return html`<div class="pl-node-head">
      <span class="pl-kind-icon">${icon(iconKind)}</span>
      <b>${name}</b>
      ${mark ? html`<span class="pl-mark" aria-hidden="true">${mark}</span>` : nothing}
    </div>
    <small class="pl-node-kind">${who}</small>
    <p class="pl-node-text">${does}</p>
    <div class="pl-node-tags">${tags.map((t) => html`<span>${t}</span>`)}</div>`;
}

function card(s, { run, editable, selected, problems, on, ox, oy }) {
  const n = nodeState(run, s);
  const problem = problems?.some((p) => p.startsWith(`${s.name}: `) || p === `${s.name} is never reached`);
  const d = describe(s);
  const cls = ["pl-node", `kind-${s.kind}`, n.cls, editable ? "editable" : "", selected === s.id ? "selected" : "", problem ? "problem" : ""].join(" ");
  return html`<div class=${cls} data-step=${s.id} data-x=${s.x} data-y=${s.y} style=${`left:${s.x + ox}px;top:${s.y + oy}px`}
      tabindex=${editable ? "0" : nothing} role=${editable ? "button" : nothing} aria-label=${editable ? `${s.name}, ${d.who}` : nothing}
      @keydown=${editable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); on?.select?.(s.id); } } : nothing}
      @click=${editable ? (e) => { e.stopPropagation(); on?.select?.(s.id); } : nothing}>
    ${editable ? html`<span class="pl-port in" aria-hidden="true"></span>` : nothing}
    ${body({ iconKind: s.kind, name: s.name, mark: run ? n.mark : "", who: d.who, does: run ? n.note : d.does, tags: d.tags })}
    ${editable ? OUTCOMES.map((o) => html`<span class=${`pl-port out ${o}`} data-outcome=${o} title=${`On ${LINE_WORDS[o]}`} style=${`top:${PORT_Y[o] * 100}%`}></span>`) : nothing}
  </div>`;
}

export function canvas({ def: d, run = null, editable = false, selected = null, problems = [], on = {}, key, bar = nothing }) {
  const lay = layout(d);
  const at = Object.fromEntries(d.steps.map((s) => [s.id, s]));
  const lines = [];
  const first = at[d.start];
  if (first) {
    const a = { x: lay.start.x + lay.ox + NODE_W, y: lay.start.y + lay.oy + NODE_H / 2 };
    lines.push({ cls: "pass taken-start", from: "@start", outcome: "start", to: first.id, ...line(a, inPort(first, lay.ox, lay.oy)), word: "" });
  }
  for (const s of d.steps) {
    for (const o of OUTCOMES) {
      const to = s.next?.[o];
      if (!at[to]) continue;
      const taken = run && run.steps?.[s.id]?.outcome === o && run.steps?.[to];
      const picked = selected === `line:${s.id}:${o}`;
      lines.push({ cls: `${o} ${taken ? "taken" : ""} ${picked ? "selected" : ""}`, from: s.id, outcome: o, to, word: LINE_WORDS[o], ...line(outPort(s, o, lay.ox, lay.oy), inPort(at[to], lay.ox, lay.oy)) });
    }
  }
  const trigger = d.trigger || { kind: "manual" };
  return html`<div class=${`pl-canvas ${editable ? "editable" : ""}`} aria-label=${editable ? "Pipeline builder canvas" : "Steps of this run"}
      data-key=${key} data-width=${lay.width} data-height=${lay.height} data-ox=${lay.ox} data-oy=${lay.oy}
      @pointerdown=${(e) => grab(e, on)} @pointermove=${(e) => drag(e, on)} @pointerup=${(e) => letGo(e, on)} @pointercancel=${(e) => letGo(e, on)} @wheel=${wheel}>
    <div class="pl-pan">
      <div class="pl-canvas-inner" style=${`width:${lay.width}px;height:${lay.height}px`}>
        <svg width=${lay.width} height=${lay.height} aria-hidden="true">
          <defs>${["pass", "fail", "needs_you", "taken"].map((k) => svg`<marker id=${`pl-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z" class=${`pl-arrowhead ${k}`}></path></marker>`)}</defs>
          ${lines.map((l) => svg`<path class=${`pl-edge ${l.cls}`} d=${l.d} marker-end=${`url(#pl-arrow-${l.cls.includes("taken") && !l.cls.includes("taken-start") ? "taken" : l.cls.split(" ")[0]})`}></path>`)}
          ${editable ? lines.filter((l) => l.from !== "@start").map((l) => svg`<path class="pl-edge-hit" d=${l.d} data-from=${l.from} data-outcome=${l.outcome} data-to=${l.to}
            @click=${(e) => { e.stopPropagation(); on?.select?.(`line:${l.from}:${l.outcome}`); }}></path>`) : nothing}
          ${editable ? lines.filter((l) => l.from === "@start").map((l) => svg`<path class="pl-edge-hit start" d=${l.d} data-from="@start" data-outcome="start" data-to=${l.to}></path>`) : nothing}
          <path class="pl-ghost" d=""></path>
        </svg>
        ${lines.filter((l) => l.word && l.outcome !== "pass").map((l) => html`<span class=${`pl-edge-word ${l.outcome}`} style=${`left:${l.label.x}px;top:${l.label.y}px`}>${l.word}</span>`)}
        <div class=${`pl-node pl-start ${editable && selected === "@start" ? "selected" : ""} ${editable ? "editable" : ""}`} data-step="@start"
            tabindex=${editable ? "0" : nothing} role=${editable ? "button" : nothing} aria-label=${editable ? "Start when, the trigger" : nothing}
            @keydown=${editable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); on?.select?.("@start"); } } : nothing}
            style=${`left:${lay.start.x + lay.ox}px;top:${lay.start.y + lay.oy}px`}
            @click=${editable ? (e) => { e.stopPropagation(); on?.select?.("@start"); } : nothing}>
          ${body({ iconKind: "start", name: "Start when", mark: "", who: "Trigger", does: triggerWords(trigger), tags: [TRIGGER_TAGS[trigger.kind] || "by hand", trigger.kind === "manual" ? "Run now" : "checked every 3 min"] })}
          ${editable ? html`<span class="pl-port out pass" data-outcome="start" title="The first step" style="top:50%"></span>` : nothing}
        </div>
        ${d.steps.map((s) => card(s, { run, editable, selected, problems, on, ox: lay.ox, oy: lay.oy }))}
      </div>
    </div>
    ${bar}
    <div class="pl-zoom">
      <button class="btn" type="button" aria-label="Zoom out" title="Zoom out" @click=${(e) => zoomBy(e, 1 / 1.25)}>−</button>
      <span class="pl-zoom-pct" aria-live="polite">100%</span>
      <button class="btn" type="button" aria-label="Zoom in" title="Zoom in" @click=${(e) => zoomBy(e, 1.25)}>+</button>
      <button class="btn" type="button" @click=${(e) => fitAll(e.target.closest(".pl-canvas"))}>Fit</button>
    </div>
    ${minimap(d, lay, run)}
  </div>`;
}

// Called after every render: a canvas seen for the first time is fitted, others keep their view.
const origins = new Map();

export function settle() {
  for (const c of document.querySelectorAll(".pl-canvas")) {
    const ox = Number(c.dataset.ox), oy = Number(c.dataset.oy);
    const was = origins.get(c.dataset.key);
    origins.set(c.dataset.key, { ox, oy });
    const v = viewOf(c);
    if (!v) {
      fit(c);
      continue;
    }
    if (was && (was.ox !== ox || was.oy !== oy)) {
      views.set(c.dataset.key, { ...v, x: v.x - (ox - was.ox) * v.k, y: v.y - (oy - was.oy) * v.k });
    }
    place(c);
  }
}

export function centreOf(canvas) {
  const r = canvas.getBoundingClientRect();
  return toWorld(canvas, r.left + r.width / 2, r.top + r.height / 2);
}
