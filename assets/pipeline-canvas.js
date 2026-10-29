import { html, svg, nothing } from "/vendor/lit-html/lit-html.js";

export const NODE_W = 220;
export const NODE_H = 96;
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
  linear: "Linear",
  report: "Report to me",
  wait: "Wait for me",
};

const ICONS = {
  start: "M5.5 3.5v9l7-4.5z",
  agent: "M2.5 3.5h11v9h-11z M5 6.5l2 1.5-2 1.5 M8.5 10h2.5",
  plan: "M8 2.5v11 M3.5 4.5h6.5l2 1.75-2 1.75H3.5z",
  push: "M8 13V3.5 M4.5 7 8 3.5 11.5 7",
  linear: "M3 3.5h10v9H3z M5.5 8l1.75 1.75L10.5 6.5",
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
  if (current) return { cls: "now", mark: "", note: run.state === "queued" ? "queued" : `running · ${ago(run.step_since)}` };
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
  const node = canvas.querySelector(".pl-node.waiting, .pl-node.now, .pl-node.selected") || canvas.querySelector(".pl-node");
  if (!whole && w * k > cw && node) x = cw / 2 - (node.offsetLeft + node.offsetWidth / 2) * k;
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

const OWN_DRAG = ".pl-zoom, .pl-minimap, .pl-canvas-bar, button, input, select, textarea, a, .pl-port, .pl-node.editable";

function grab(e) {
  const canvas = e.currentTarget;
  if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (e.button !== 0 || e.target.closest(OWN_DRAG)) return;
  held = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  canvas.classList.add("grabbing");
}

function drag(e) {
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
  held.moved ||= Math.hypot(e.clientX - held.x, e.clientY - held.y) > 3;
  setView(canvas, { ...v, x: v.x + e.clientX - held.x, y: v.y + e.clientY - held.y });
  held = { ...held, x: e.clientX, y: e.clientY, moved: held.moved };
}

function letGo(e, on) {
  touches.delete(e.pointerId);
  const canvas = e.currentTarget;
  canvas.classList.remove("grabbing");
  if (held && held.id === e.pointerId && !held.moved && e.type === "pointerup") on?.select?.(null);
  held = null;
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

function card(s, { run, editable, selected, problems, on, ox, oy }) {
  const n = nodeState(run, s);
  const problem = problems?.some((p) => p.startsWith(`${s.name}: `) || p === `${s.name} is never reached`);
  const kind = s.kind === "agent" ? `Agent${s.read_only ? " · read only" : ""}` : s.kind === "linear" ? (s.action === "move" ? `Linear · move to ${s.state || "?"}` : "Linear · comment draft") : KINDS[s.kind];
  const text = run ? n.note : s.kind === "agent" ? s.instructions : s.kind === "wait" ? s.message : "";
  const cls = ["pl-node", `kind-${s.kind}`, n.cls, editable ? "editable" : "", selected === s.id ? "selected" : "", problem ? "problem" : ""].join(" ");
  return html`<div class=${cls} data-step=${s.id} style=${`left:${s.x + ox}px;top:${s.y + oy}px`}
      @click=${editable ? (e) => { e.stopPropagation(); on?.select?.(s.id); } : nothing}>
    ${editable ? html`<span class="pl-port in" aria-hidden="true"></span>` : nothing}
    <div class="pl-node-head">
      <span class="pl-kind-icon">${icon(s.kind)}</span>
      <b>${s.name}</b>
      ${run && n.mark ? html`<span class="pl-mark" aria-hidden="true">${n.mark}</span>` : nothing}
    </div>
    <small class="pl-node-kind">${kind}</small>
    ${text ? html`<p class="pl-node-text">${text}</p>` : nothing}
    ${editable && s.kind === "agent" ? html`<div class="pl-node-tags"><span>${machineWord(s)}</span><span>${workspaceWord(s)}</span></div>` : nothing}
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
    lines.push({ cls: "pass taken-start", ...line(a, inPort(first, lay.ox, lay.oy)), word: "" });
  }
  for (const s of d.steps) {
    for (const o of OUTCOMES) {
      const to = s.next?.[o];
      if (!at[to]) continue;
      const taken = run && run.steps?.[s.id]?.outcome === o && run.steps?.[to];
      lines.push({ cls: `${o} ${taken ? "taken" : ""}`, from: s.id, outcome: o, word: LINE_WORDS[o], ...line(outPort(s, o, lay.ox, lay.oy), inPort(at[to], lay.ox, lay.oy)) });
    }
  }
  const trigger = d.trigger || { kind: "manual" };
  return html`<div class=${`pl-canvas ${editable ? "editable" : ""}`} aria-label=${editable ? "Pipeline builder canvas" : "Steps of this run"}
      data-key=${key} data-width=${lay.width} data-height=${lay.height} data-ox=${lay.ox} data-oy=${lay.oy}
      @pointerdown=${grab} @pointermove=${drag} @pointerup=${(e) => letGo(e, on)} @pointercancel=${(e) => letGo(e, on)} @wheel=${wheel}>
    <div class="pl-pan">
      <div class="pl-canvas-inner" style=${`width:${lay.width}px;height:${lay.height}px`}>
        <svg width=${lay.width} height=${lay.height} aria-hidden="true">
          <defs>${["pass", "fail", "needs_you", "taken"].map((k) => svg`<marker id=${`pl-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z" class=${`pl-arrowhead ${k}`}></path></marker>`)}</defs>
          ${lines.map((l) => svg`<path class=${`pl-edge ${l.cls}`} d=${l.d} marker-end=${`url(#pl-arrow-${l.cls.includes("taken") && !l.cls.includes("taken-start") ? "taken" : l.cls.split(" ")[0]})`}></path>`)}
        </svg>
        ${lines.filter((l) => l.word && l.outcome !== "pass").map((l) => html`<span class=${`pl-edge-word ${l.outcome}`} style=${`left:${l.label.x}px;top:${l.label.y}px`}>${l.word}</span>`)}
        <div class=${`pl-node pl-start ${editable && selected === "@start" ? "selected" : ""} ${editable ? "editable" : ""}`} data-step="@start"
            style=${`left:${lay.start.x + lay.ox}px;top:${lay.start.y + lay.oy}px`}
            @click=${editable ? (e) => { e.stopPropagation(); on?.select?.("@start"); } : nothing}>
          <div class="pl-node-head"><span class="pl-kind-icon">${icon("start")}</span><b>Start when</b></div>
          <small class="pl-node-kind">${trigger.kind === "manual" ? "By hand" : trigger.kind.replace("_", " ")}</small>
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
export function settle() {
  for (const c of document.querySelectorAll(".pl-canvas")) {
    if (views.has(c.dataset.key)) place(c);
    else fit(c);
  }
}
