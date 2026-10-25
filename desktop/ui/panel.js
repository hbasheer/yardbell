const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const RATED = 85;
const FULL = 95;
let shown = "";

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function gb(kb) {
  return (kb / 1048576).toFixed(1);
}

function level(machine) {
  if (!machine.up) return "bad";
  return machine.memory && machine.memory.percent >= RATED ? "warn" : "ok";
}

function heat(percent) {
  return percent >= FULL ? " full" : percent >= RATED ? " hot" : "";
}

function meter(name, percent, title, segments, value) {
  return `<span class="meter${heat(percent)}" title="${esc(title)}">
    <span>${name}</span>
    <span class="mem-bar" role="img" aria-label="${esc(title)}">${segments}</span>
    <span class="value"><span class="pct">${percent}%</span>${value}</span>
  </span>`;
}

function memory(m) {
  const used = Math.min(m.used_kb / m.total_kb, 1);
  const agents = Math.min(m.agent_kb / m.total_kb, used);
  const segments = `<span class="mem-agents" style="width:${(agents * 100).toFixed(1)}%"></span><span class="mem-other" style="width:${((used - agents) * 100).toFixed(1)}%"></span>`;
  const title = `Memory ${m.percent}% used of ${gb(m.total_kb)} GB, agents ${gb(m.agent_kb)} GB`;
  return meter("Memory", m.percent, title, segments, ` of ${gb(m.total_kb)} GB`);
}

function cpu(c) {
  const segments = `<span class="mem-other" style="width:${c.percent}%"></span>`;
  const title = `1-minute load ${c.load1.toFixed(1)} across ${c.cpus} CPUs`;
  return meter("CPU", c.percent, title, segments, ` · ${c.cpus} cores`);
}

function disk(d) {
  const segments = `<span class="mem-other" style="width:${Math.min(d.percent, 100)}%"></span>`;
  const title = `Disk ${d.percent}% used of ${gb(d.total_kb)} GB, ${gb(d.total_kb - d.used_kb)} GB free`;
  return meter("Disk", d.percent, title, segments, ` of ${gb(d.total_kb)} GB`);
}

function machineRow(machine) {
  const state = machine.up
    ? `<span class="state">up</span>`
    : `<span class="state bad">${esc(machine.reason ? `down (${machine.reason})` : "down")}</span>`;
  const meters = machine.up ? `${machine.memory ? memory(machine.memory) : ""}${machine.cpu ? cpu(machine.cpu) : ""}${machine.disk ? disk(machine.disk) : ""}` : "";
  return `<button class="row machine" type="button" data-machine="${esc(machine.name)}">
    <span class="machine-head"><span class="dot ${level(machine)}"></span><span class="name">${esc(machine.name)}</span>${state}</span>
    ${meters}
  </button>`;
}

function switchRow(s) {
  return `<label class="switch"><span>${esc(s.label)}</span><input type="checkbox" data-id="${esc(s.id)}"${s.on ? " checked" : ""}></label>`;
}

function renderSwitches(switches) {
  $("notifications").innerHTML = switches.filter((s) => s.id.startsWith("notify-")).map(switchRow).join("");
  $("startup").innerHTML = switches.filter((s) => !s.id.startsWith("notify-")).map(switchRow).join("");
}

function showSettings(open) {
  $("main-view").hidden = open;
  $("settings-view").hidden = !open;
  resize();
  (open ? $("back") : $("open-settings")).focus();
}

function resize() {
  invoke("panel_resize", { height: Math.ceil($("panel").getBoundingClientRect().height) });
}

function sessionRow(session) {
  const badge = session.working ? `<span class="badge">Working</span>` : "";
  return `<button class="row session" type="button" role="listitem" data-machine="${esc(session.machine)}" data-tmux="${esc(session.tmux)}">
    <span class="label">${esc(session.label)}</span>${badge}
  </button>`;
}

function render(view) {
  const next = JSON.stringify(view);
  if (next === shown) return;
  shown = next;
  const machines = $("machines");
  const ready = view.state === "ready";
  if (view.state === "pending") machines.innerHTML = `<p class="note">Connecting…</p>`;
  else if (view.state === "unreachable") machines.innerHTML = `<p class="note bad">Can't reach the server</p>`;
  else if (!view.machines.length) machines.innerHTML = `<p class="note">No machines yet</p>`;
  else machines.innerHTML = view.machines.map(machineRow).join("");
  $("sessions-section").hidden = !ready;
  if (ready) {
    $("sessions").innerHTML = view.sessions.length
      ? view.sessions.map(sessionRow).join("")
      : `<p class="note">No sessions to open</p>`;
  }
  resize();
}

$("machines").addEventListener("click", (e) => {
  const row = e.target.closest(".machine");
  if (row) invoke("panel_open_machine", { name: row.dataset.machine });
});

$("sessions").addEventListener("click", (e) => {
  const row = e.target.closest(".session");
  if (row) invoke("panel_open_session", { machine: row.dataset.machine, tmux: row.dataset.tmux });
});

$("open-app").addEventListener("click", () => invoke("panel_open_app"));
$("new-session").addEventListener("click", () => invoke("panel_new_session"));
$("disconnect").addEventListener("click", () => invoke("panel_disconnect"));
$("quit").addEventListener("click", () => invoke("panel_quit"));

$("open-settings").addEventListener("click", () => showSettings(true));
$("back").addEventListener("click", () => showSettings(false));

$("settings-view").addEventListener("change", (e) => {
  if (e.target.dataset.id) invoke("panel_toggle", { id: e.target.dataset.id });
});

addEventListener("blur", () => {
  if (!$("settings-view").hidden) showSettings(false);
});

addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  if ($("settings-view").hidden) invoke("panel_close");
  else showSettings(false);
});

async function init() {
  await listen("panel", (event) => render(event.payload));
  await listen("panel-switches", (event) => renderSwitches(event.payload));
  renderSwitches(await invoke("panel_switches"));
  render(await invoke("panel_state"));
}

init();
