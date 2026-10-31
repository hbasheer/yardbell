const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
let data = null;

const LABELS = { nordvpn: "NordVPN Meshnet", tailscale: "Tailscale", headscale: "Headscale", netbird: "NetBird", zerotier: "ZeroTier", none: "None" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

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
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("logged out"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

function saved(text, restart = false) {
  $("undo-bar").hidden = false;
  $("undo-title").textContent = "Saved.";
  $("undo-text").textContent = text;
  $("undo-btn").hidden = false;
  $("restart-btn").hidden = !restart || !data?.service_installed;
}

function providerOptions(selected, withDefault) {
  const opts = withDefault ? [`<option value=""${selected ? "" : " selected"}>Same as Yardbell</option>`] : [];
  for (const [v, l] of Object.entries(LABELS)) opts.push(`<option value="${v}"${selected === v ? " selected" : ""}>${l}</option>`);
  return opts.join("");
}

// Another machine's app ports are forwarded to the host, and the prefix keeps two machines'
// port 3000 apart.
function prefixHelp(m) {
  const host = (data?.machines || []).find((x) => x.local)?.name || "the host";
  if (!m.port_prefix) return `Apps on ${esc(m.name)} open on ${esc(host)} once it has a port prefix.`;
  const example = m.port_prefix * 10000 + 3000;
  return `Port prefix: apps on ${esc(m.name)} open on ${esc(host)} at the prefix times 10000 plus their port, so port 3000 opens at ${example}. Each machine needs its own prefix.`;
}

function machineForm(m) {
  const prefixes = [1, 2, 3, 4, 5, 6].map((p) => `<option${m.port_prefix === p ? " selected" : ""}>${p}</option>`).join("");
  return `<form class="panel machine-form" id="machine-${esc(m.name)}" data-name="${esc(m.name)}">
    <div class="machine-form-head">
      <strong>${esc(m.name)}</strong>${m.local ? `<span class="note">this machine</span>` : ""}
      <span class="spacer"></span>
      ${m.local ? "" : `<button class="btn quiet danger" type="button" data-remove="${esc(m.name)}">Remove</button>`}
    </div>
    <div class="grid3">
      <label>SSH host <input type="text" name="ssh" value="${esc(m.ssh || "")}" placeholder="${esc(m.name)}" autocapitalize="off" ${m.local ? "disabled" : ""}></label>
      <label>Mesh address <input type="text" name="mesh_ip" value="${esc(m.mesh_ip || "")}" placeholder="100.x.x.x" autocapitalize="off"></label>
      <label>Port prefix ${m.local ? `<input type="text" value="host ports" disabled>` : `<select name="port_prefix">${prefixes}</select>`}</label>
      <label class="span2">Project folder <input type="text" name="root" value="${esc(m.root)}" autocapitalize="off" required></label>
      <label>VPN <select name="mesh">${providerOptions(m.mesh || "", true)}</select></label>
    </div>
    <div class="form-foot">
      <p class="help">${m.local ? "Yardbell runs here. Its mesh address is where your phone reaches Yardbell. Apps on this machine keep their own port numbers." : prefixHelp(m)}</p>
      <button class="btn" type="submit">Save ${esc(m.name)}</button>
    </div>
  </form>`;
}

function clock(stamp) {
  return new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderPhone(p) {
  const f = $("phone-form");
  for (const name of ["agent_waiting", "session_ended", "machines", "memory", "pipeline_waiting", "pipeline_finished", "proposals"]) f.elements[name].checked = p[name];
  f.elements.wait_minutes.value = p.wait_minutes;
  const status = $("phone-status");
  status.textContent = p.app_connected
    ? "The Yardbell app is connected and gets these."
    : "No phone has the Yardbell app connected right now. Pair one under Connect a phone.";
  status.classList.toggle("ok", p.app_connected);
}

function renderMcp(m) {
  const on = Boolean(m.token);
  $("mcp-intro").hidden = on;
  $("mcp-panel").hidden = !on;
  $("mcp-turn-off").hidden = !on;
  if (!on) return;
  const url = m.urls.find((u) => !u.includes("//127.0.0.1:")) || m.urls[0];
  // read -s keeps the token out of the line typed, so shell history never sees it.
  $("mcp-command").textContent = `printf 'Yardbell token: ' && read -rs YB_TOKEN && echo && claude mcp add --transport http --scope user yardbell ${url} --header "Authorization: Bearer $YB_TOKEN"; unset YB_TOKEN`;
  $("mcp-token").textContent = `${m.token.slice(0, 7)}…`;
}

// Dispatch can start a session on any machine, so it offers the agents installed on at least one,
// with where they are. Until the machines answer, every agent is listed.
let installedOn = null;

function dispatchAgents() {
  const f = $("dispatch-form");
  const current = f.elements.agent.value || (data.dispatch || {}).agent || "";
  const fallback = data.agents.find((a) => a.name === data.default_agent);
  const where = (a) => installedOn ? Object.keys(installedOn).filter((m) => installedOn[m].includes(a.name)) : [];
  const shown = data.agents.filter((a) => !installedOn || where(a).length || a.name === current);
  f.elements.agent.innerHTML = `<option value="">Default agent${fallback ? ` (${esc(fallback.label)})` : ""}</option>`
    + shown.map((a) => {
      const on = where(a);
      const note = !installedOn ? "" : on.length ? ` · ${on.join(", ")}` : " · not installed anywhere";
      return `<option value="${esc(a.name)}">${esc(a.label)}${esc(note)}</option>`;
    }).join("");
  f.elements.agent.value = current;
}

function dispatchRunsOnAgents() {
  return (data.dispatch_runs_on || ["claude"]).map((name) => data.agents.find((a) => a.name === name) || { name, label: name });
}

// Dispatch itself runs on the machine Yardbell runs on, whichever agent the sessions use, so it
// offers the agents it can run on from the same list as sessions, marked when one is not there.
function dispatchRunsOn() {
  const f = $("dispatch-form");
  const select = f.elements.runs_on;
  const current = select.value || (data.dispatch || {}).runs_on || "claude";
  const agents = dispatchRunsOnAgents();
  const here = (data.machines || []).find((m) => m.local);
  const known = here && installedOn?.[here.name];
  select.innerHTML = agents.map((a) => {
    const absent = known && !known.includes(a.name) ? ` (not found on ${here.name})` : "";
    return `<option value="${esc(a.name)}">${esc(a.label)}${esc(absent)}</option>`;
  }).join("");
  select.value = current;
  for (const label of f.querySelectorAll("[data-runs-on]")) label.hidden = label.dataset.runsOn !== current;
  const name = agents.find((a) => a.name === current)?.label || current;
  $("dispatch-foot").textContent = known && !known.includes(current)
    ? `${name} is not installed on ${here.name}, where Dispatch runs, so Dispatch cannot answer until it is.`
    : `Dispatch runs ${name} on this machine. The agent it starts can be any of yours.`;
  $("codex-models").innerHTML = (data.codex_models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
  codexModelNote();
}

// Codex accepts any model name here, since its list is only what it last fetched for this account.
function codexModelNote() {
  const f = $("dispatch-form");
  const model = f.elements.codex_model.value.trim();
  const listed = data.codex_models || [];
  const note = $("codex-model-note");
  note.hidden = f.elements.runs_on.value !== "codex" || !model || !listed.length || listed.includes(model);
  note.textContent = `Codex does not list ${model} for your account, so it may refuse it. Dispatch then shows Codex's error in the conversation.`;
}

async function loadInstalled() {
  const names = (data.machines || []).map((m) => m.name);
  const answers = await Promise.all(names.map((name) =>
    api("GET", `/machines/${encodeURIComponent(name)}/agents`).then((r) => [name, r.installed]).catch(() => null)));
  const found = answers.filter(Boolean);
  if (!found.length) return;
  installedOn = Object.fromEntries(found);
  dispatchAgents();
  dispatchRunsOn();
}

function renderDispatch() {
  const f = $("dispatch-form");
  const d = data.dispatch || {};
  f.elements.agent.value = "";
  dispatchAgents();
  f.elements.instructions.value = d.instructions || "";
  f.elements.agent.value = d.agent || "";
  f.elements.runs_on.value = "";
  f.elements.model.value = d.model || "";
  f.elements.codex_model.value = d.codex_model || "";
  dispatchRunsOn();
  f.elements.approval.value = { ask: "prompt", auto: "allow" }[d.approval] || d.approval || "prompt";
  rules = (d.rules || []).map((r) => ({ action: "any", machine: "any", folder: "", ...r }));
  renderRules();
  loadInstalled();
}

const RULE_STEPS = { any: "Any step", start_session: "Start a session", stop_session: "Stop a session", send_to_session: "Type into a session", review_session: "Start a review", scan_folder: "Start a scan", remove_worktree: "Remove a worktree", integrate_branches: "Integrate branches", push_branch: "Push a branch", move_session: "Move a session", change_settings: "Change settings", save_task: "Save a task", run_trigger: "Run a trigger", save_pipeline: "Save a pipeline", set_pipeline_enabled: "Turn a pipeline on or off", run_pipeline: "Run a pipeline", answer_run: "Answer a run", remember: "Change Dispatch's memory" };
const UNPLACED = new Set(["remember", "change_settings", "save_task", "run_trigger", "save_pipeline", "set_pipeline_enabled", "run_pipeline", "answer_run"]);
const RULE_APPROVALS = { allow: "Allow", prompt: "Ask me", deny: "Deny" };
let rules = [];
const CROSS = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

function options(choices, selected) {
  return Object.entries(choices).map(([v, l]) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(l)}</option>`).join("");
}

function renderRules() {
  const machines = { any: "Any machine", ...Object.fromEntries((data.machines || []).map((m) => [m.name, m.name])) };
  $("rule-rows").innerHTML = rules.length
    ? rules.map((r, i) => `<li class="row rule-row" data-rule="${i}">
      <select data-key="action" aria-label="Step">${options(RULE_STEPS, r.action)}</select>
      <select data-key="machine" aria-label="Machine"${UNPLACED.has(r.action) ? " disabled" : ""}>${options(machines, r.machine)}</select>
      <input type="text" data-key="folder" aria-label="Folder" value="${esc(r.folder)}" placeholder="Any folder" autocapitalize="off" spellcheck="false"${UNPLACED.has(r.action) ? " disabled" : ""}>
      <select data-key="approval" aria-label="Then">${options(RULE_APPROVALS, r.approval)}</select>
      <button class="btn quiet danger" type="button" data-remove-rule="${i}" aria-label="Remove rule" title="Remove rule">${CROSS}</button>
    </li>`).join("")
    : `<li class="row rule-empty">No rules. Every step follows the setting above.</li>`;
}

let editing = null;

function serverTarget(srv) {
  return srv.url || srv.command;
}

function renderServers() {
  const servers = data.mcp_servers || [];
  $("server-rows").hidden = !servers.length;
  $("server-rows").innerHTML = servers.map((srv, i) => `<li class="row">
    <div class="row-main"><div class="row-title"><span class="folder">${esc(srv.name)}</span></div>
      <p class="help">${esc(serverTarget(srv))} · ${srv.machines?.length ? esc(srv.machines.join(", ")) : "every machine"}</p></div>
    <div class="row-actions"><button class="btn" type="button" data-edit="${i}">Edit</button><button class="btn quiet danger" type="button" data-remove="${i}">Remove</button></div></li>`).join("");
}

function day(stamp) {
  return new Date(stamp).toLocaleDateString([], { dateStyle: "medium" });
}

function renderSecrets() {
  const s = data.secrets || { list: [], missing: [], inline: [] };
  if (s.error) toast(s.error);
  $("secrets-file").textContent = s.file || "secrets.yml";
  $("secret-rows").hidden = !s.list.length;
  $("secrets-empty").hidden = Boolean(s.list.length);
  $("secret-rows").innerHTML = s.list.map((x) => `<li class="row">
    <div class="row-main"><div class="row-title"><span class="folder secret-name">${esc(x.name)}</span><span class="note">${x.updated ? `set ${esc(day(x.updated))}` : "set"}</span></div>
      <p class="help">${x.used_by.length ? `Used by ${esc(x.used_by.join(", "))}` : "Not used by any server"}</p></div>
    <div class="row-actions"><button class="btn" type="button" data-replace="${esc(x.name)}">Replace</button><button class="btn quiet danger" type="button" data-delete="${esc(x.name)}">Delete</button></div></li>`).join("");
  $("secrets-missing").hidden = !s.missing.length;
  $("secrets-missing-text").textContent = `${s.missing.map((x) => `${x.server} uses \${secret:${x.name}}, which is not set.`).join(" ")} New Claude Code sessions that get it do not start until it is. Add it below.`;
  $("secrets-inline").hidden = !s.inline.some((x) => x.secret);
  $("inline-picks").innerHTML = s.inline.map((x, i) => `<label class="choice"><input type="checkbox" data-inline="${i}"${x.secret ? " checked" : ""}>${esc(x.label)}</label>`).join("");
}

let memory = { entries: [], history: [], bytes: 0, max_bytes: 8192, omitted: 0 };
let memoryEditing = null;

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const MEMORY_DID = { add: "Added", replace: "Changed", forget: "Forgot" };

function memoryChange(h) {
  const removed = h.change === "add" ? "" : h.old;
  const added = h.change === "forget" ? "" : h.entry;
  return `<div class="memory-diff">${removed ? `<del class="memory-diff-line"><span class="memory-diff-mark" aria-hidden="true">-</span><span>${esc(removed)}</span></del>` : ""}${added ? `<ins class="memory-diff-line"><span class="memory-diff-mark" aria-hidden="true">+</span><span>${esc(added)}</span></ins>` : ""}</div>`;
}

function renderMemory() {
  const m = memory;
  if (m.error) toast(m.error);
  $("memory-file").textContent = m.file || "memory.md";
  const pct = Math.min(100, Math.round((m.bytes / m.max_bytes) * 100));
  $("memory-meter").setAttribute("aria-valuenow", String(pct));
  $("memory-fill").style.width = `${Math.max(pct, 1)}%`;
  $("memory-fill").className = `usage-fill${pct >= 100 ? " bad" : pct >= 80 ? " warn" : ""}`;
  $("memory-size").textContent = `${kb(m.bytes)} of ${kb(m.max_bytes)} used`;
  $("memory-over").hidden = !m.omitted;
  $("memory-over-text").textContent = `Dispatch reads only the first entries that fit, and leaves out the last ${m.omitted === 1 ? "one" : m.omitted}. Delete or shorten some.`;
  $("memory-rows").hidden = !m.entries.length;
  $("memory-empty").hidden = Boolean(m.entries.length);
  $("memory-rows").innerHTML = m.entries.map((entry, i) => `<li class="row">
    <div class="row-main"><div class="row-title">${esc(entry)}</div></div>
    <div class="row-actions"><button class="btn" type="button" data-memory-edit="${i}">Edit</button><button class="btn quiet danger" type="button" data-memory-delete="${i}">Delete</button></div></li>`).join("");
  $("memory-history").hidden = !m.history.length;
  $("memory-history-summary").textContent = `History of changes (${m.history.length})`;
  $("memory-history-list").innerHTML = m.history.map((h) => `<li>
    <p class="help">${MEMORY_DID[h.change] || "Changed"} ${esc(new Date(h.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · ${h.by === "you" ? "by you, here" : "proposed by Dispatch, approved by you"}</p>
    ${memoryChange(h)}
    ${h.reason ? `<p class="help">${esc(h.reason)}</p>` : ""}
  </li>`).join("");
}

async function loadMemory() {
  memory = await api("GET", "/dispatch/memory");
  renderMemory();
}

function openMemoryForm(index) {
  const f = $("memory-form");
  f.reset();
  memoryEditing = index === null ? null : memory.entries[index];
  $("memory-form-label").textContent = memoryEditing === null ? "New entry" : "Entry";
  f.elements.entry.value = memoryEditing ?? "";
  f.hidden = false;
  f.elements.entry.focus();
}

function openSecretForm(name) {
  const f = $("secret-form");
  f.reset();
  f.elements.name.value = name || "";
  f.elements.name.readOnly = Boolean(name);
  $("secret-form-help").textContent = name
    ? `The new value replaces the one saved for ${name}. New sessions get it; running ones keep the one they started with.`
    : "Letters, digits, - and _ in the name. New sessions get the value; running ones keep the one they started with.";
  f.hidden = false;
  (name ? f.elements.value : f.elements.name).focus();
}

function showKind(kind) {
  $("server-form").querySelectorAll("[data-kind]").forEach((el) => { el.hidden = el.dataset.kind !== kind; });
  $("server-pairs-label").textContent = kind === "url" ? "Headers" : "Environment variables";
  $("server-form").elements.pairs.placeholder = kind === "url" ? "Authorization=Bearer ${secret:linear}" : "GITHUB_TOKEN=${secret:github}";
}

function openServerForm(index) {
  editing = index;
  const srv = index === null ? { name: "", command: "", url: "", env: {}, headers: {}, machines: [] } : data.mcp_servers[index];
  const f = $("server-form");
  const kind = srv.url ? "url" : "command";
  f.elements.name.value = srv.name;
  f.elements.kind.value = kind;
  f.elements.command.value = srv.command || "";
  f.elements.url.value = srv.url || "";
  f.elements.pairs.value = Object.entries((kind === "url" ? srv.headers : srv.env) || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  $("server-machines").innerHTML = data.machines.map((m) => `<label class="choice"><input type="checkbox" value="${esc(m.name)}"${srv.machines?.includes(m.name) ? " checked" : ""}>${esc(m.name)}</label>`).join("");
  showKind(kind);
  f.hidden = false;
  f.elements.name.focus();
}

function readPairs(text) {
  const pairs = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`"${line.trim()}" needs to look like NAME=value`);
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

async function saveServers(servers, message) {
  await api("POST", "/api/settings/mcp/servers", { servers });
  saved(message);
  await load();
}

async function mcpAction(url, message) {
  $("mcp").querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    await api("POST", url, {});
    toast(message, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    $("mcp").querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

function phoneBusy(busy) {
  $("phone").querySelectorAll("button").forEach((b) => { b.disabled = busy; });
}

function copyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  // select() alone selects nothing on iOS.
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
  return ok;
}

async function load() {
  data = await api("GET", "/api/settings");
  $("provider").value = data.mesh;
  $("mesh-current").textContent = `currently ${LABELS[data.mesh] || data.mesh}`;
  $("machine-forms").innerHTML = data.machines.map(machineForm).join("");
  renderPhone(data.phone);
  renderMcp(data.mcp);
  renderServers();
  renderSecrets();
  renderDispatch();
  renderPullRequests();
  pullFoldersWanted();
  await loadConnections().catch((err) => toast(err.message));
  await loadTriggers().catch((err) => toast(err.message));
  await loadSetups();
  await loadMemory().catch((err) => toast(err.message));
  if (!data.can_undo) $("undo-btn").hidden = true;
  else if (data.undo_note && $("undo-bar").hidden) {
    saved(data.undo_note);
    $("undo-title").textContent = "Changed by Dispatch.";
  }
}

$("preview-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const res = await api("POST", "/api/settings/mesh/preview", { provider: $("provider").value });
    const found = res.proposals.filter((p) => p.new_ip).length;
    $("mapping-note").textContent = res.message
      ? `${res.message} Type the new addresses below.`
      : `${res.label} lists ${res.peers.length} peers. Matched ${found} of ${res.proposals.length} machines by name. Check each address; leave a field empty to keep it unchanged.`;
    $("mapping-rows").innerHTML = res.proposals.map((p) => `<tr>
      <td class="map-machine">${esc(p.machine)}</td>
      <td><span class="num">${esc(p.old_ip || "none")}</span></td>
      <td><input type="text" class="addr" data-machine="${esc(p.machine)}" value="${esc(p.new_ip || "")}" placeholder="100.x.x.x" autocapitalize="off">
        ${p.peer ? `<span class="help">matched ${esc(p.peer)}</span>` : ""}</td>
    </tr>`).join("");
    $("mapping").hidden = false;
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$("apply-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  const provider = $("provider").value;
  const addresses = {};
  document.querySelectorAll(".addr").forEach((i) => { if (i.value.trim()) addresses[i.dataset.machine] = i.value.trim(); });
  const count = Object.keys(addresses).length;
  if (!(await Nav.confirm(`Switch Yardbell to ${LABELS[provider]}?`, `This updates ${count} ${count === 1 ? "address" : "addresses"}.`, { confirm: "Switch VPN" }))) return;
  b.disabled = true;
  try {
    const res = await api("POST", "/api/settings/mesh/apply", { provider, addresses });
    const ssh = res.ssh_updated.length ? ` Updated ~/.ssh/config for ${res.ssh_updated.join(", ")}.` : "";
    const restart = res.restart_needed
      ? data.service_installed ? " Restart Yardbell so your phone can reach it at the new address." : " Stop Yardbell and run yardbell serve again so your phone can reach it at the new address."
      : "";
    saved(`Yardbell now uses ${LABELS[provider]}.${ssh}${restart}`, res.restart_needed);
    $("mapping").hidden = true;
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$("machine-forms").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const v = (n) => f.elements[n]?.value?.trim() ?? "";
  const body = {
    ssh: v("ssh") || null,
    mesh_ip: v("mesh_ip") || null,
    port_prefix: f.elements.port_prefix ? Number(v("port_prefix")) : null,
    root: v("root"),
    mesh: v("mesh") || null,
  };
  try {
    await api("POST", `/api/settings/machines/${encodeURIComponent(f.dataset.name)}`, body);
    saved(`${f.dataset.name} updated.`);
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$("machine-forms").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  const name = b.dataset.remove;
  if (!(await Nav.confirm(`Remove ${name} from Yardbell?`, "Its tunnels close. ~/.ssh/config is not changed.", { confirm: "Remove", danger: true }))) return;
  try {
    const res = await api("POST", `/machines/${encodeURIComponent(name)}/remove`);
    if (res.ok === false) throw new Error(res.message);
    toast(res.message, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  }
});

document.querySelectorAll('input[name="theme"]').forEach((input) => {
  input.checked = input.value === window.YardbellTheme.chosen();
  input.addEventListener("change", () => window.YardbellTheme.set(input.value));
});

document.querySelectorAll('input[name="term-theme"]').forEach((input) => {
  input.checked = input.value === window.YardbellTheme.terminalChosen();
  input.addEventListener("change", () => window.YardbellTheme.setTerminal(input.value));
});

let gitlabHosts = [];

function serviceLine(why, fine) {
  if (why) return { cls: "pr-bad", text: why };
  return fine ? { cls: "pr-ok", text: fine } : { cls: "pr-wait", text: "Not checked yet. It is checked once a session has a branch here." };
}

function renderPullRequests() {
  const { value, status } = data.pull_requests;
  const f = $("pr-form");
  f.elements.enabled.checked = value.enabled;
  f.elements.cards.checked = value.cards;
  f.elements.poll_seconds.value = value.poll_seconds;
  f.elements.use_github.checked = value.use_github !== false;
  f.elements.use_gitlab.checked = value.use_gitlab !== false;
  gitlabHosts = (value.gitlab || []).map((g) => ({ host: g.host, url: g.url || "", token: g.token }));
  renderHosts();
  $("pr-github").innerHTML = (data.machines || []).map((m) => {
    const seen = Object.hasOwn(status.machines, m.name);
    const line = serviceLine(status.machines[m.name], seen ? "gh works" : "");
    return `<li class="${line.cls}"><strong>${esc(m.name)}</strong> ${esc(line.text)}</li>`;
  }).join("");
  renderFolders();
}

function renderHosts() {
  const status = data.pull_requests.status.hosts;
  const names = (data.secrets?.list || []).map((s) => `\${secret:${s.name}}`);
  const tokenOptions = (g) => {
    const all = g.token && !names.includes(g.token) ? [g.token, ...names] : names;
    const word = (t) => (t === "(hidden)" ? "Typed into yardbell.yml, kept" : t);
    const empty = names.length ? "Pick a saved secret" : "No saved secrets yet";
    return `<option value="" ${g.token ? "" : "selected"}>${empty}</option>${all.map((t) => `<option value="${esc(t)}"${t === g.token ? " selected" : ""}>${esc(word(t))}</option>`).join("")}`;
  };
  $("pr-no-hosts").hidden = gitlabHosts.length > 0;
  $("pr-hosts").hidden = !gitlabHosts.length;
  $("pr-hosts").innerHTML = gitlabHosts.map((g, i) => {
    const key = g.host.trim().toLowerCase();
    const line = serviceLine(status[key], Object.hasOwn(status, key) ? "The token works" : "");
    return `<li class="row pr-host" data-host="${i}">
    <label>Host, as in the remote address<input type="text" data-key="host" value="${esc(g.host)}" placeholder="git.example.com" autocapitalize="off" spellcheck="false"></label>
    <label>Address, only if it differs<input type="text" data-key="url" value="${esc(g.url)}" placeholder="https://git.example.com:8443" autocapitalize="off" spellcheck="false"></label>
    <label>Token<select data-key="token">${tokenOptions(g)}</select></label>
    <button class="btn quiet danger" type="button" data-remove-host="${i}" aria-label="Remove host" title="Remove host">${CROSS}</button>
    <p class="pr-host-state ${line.cls}">${esc(line.text)}</p>
  </li>`;
  }).join("");
  renderFolders();
}

let pullFolders = null;

const SERVICE = {
  github: "GitHub",
  gitlab: "GitLab",
  gitlab_unlisted: "GitLab",
  unknown: "Not known",
  none: "No remote",
};

function folderState(f) {
  const form = $("pr-form").elements;
  const listed = gitlabHosts.some((g) => g.host.trim().toLowerCase() === f.host);
  if (f.service === "none") return { cls: "pr-wait", text: "This folder has no origin remote." };
  if (f.service === "github") {
    if (!form.use_github.checked) return { cls: "pr-wait", text: "GitHub is switched off." };
    const { machines } = data.pull_requests.status;
    if (machines[f.machine]) return { cls: "pr-bad", text: machines[f.machine] };
    return Object.hasOwn(machines, f.machine) ? { cls: "pr-ok", text: "Read with gh, which works." } : { cls: "pr-wait", text: "Read with gh. Not checked yet." };
  }
  if (listed) {
    if (!form.use_gitlab.checked) return { cls: "pr-wait", text: "GitLab is switched off." };
    const { hosts } = data.pull_requests.status;
    if (hosts[f.host]) return { cls: "pr-bad", text: hosts[f.host] };
    return Object.hasOwn(hosts, f.host) ? { cls: "pr-ok", text: "Read with its token, which works." } : { cls: "pr-wait", text: "Read with its token. Not checked yet." };
  }
  if (f.service === "gitlab_unlisted") return { cls: "pr-bad", text: `Add ${f.host} to see its merge requests.`, add: "Add this host" };
  return { cls: "pr-wait", text: `Yardbell cannot tell what ${f.host} runs. If it is GitLab, add it.`, add: "Add as GitLab" };
}

function renderFolders() {
  const list = $("pr-folders");
  if (!pullFolders) {
    list.innerHTML = `<li class="pr-wait">Checking your folders...</li>`;
    return;
  }
  const rows = pullFolders.folders.map((f) => {
    const state = folderState(f);
    const word = gitlabHosts.some((g) => g.host.trim().toLowerCase() === f.host) ? "GitLab" : SERVICE[f.service];
    return `<li class="pr-folder">
      <span class="pr-folder-name"><strong>${esc(f.folder)}</strong> <small>${esc(f.machine)}${f.project ? ` · ${esc(f.host)}/${esc(f.project)}` : ""}</small></span>
      <span class="pr-service">${esc(word)}</span>
      <span class="pr-folder-state ${state.cls}">${esc(state.text)}</span>
      ${state.add ? `<button class="btn small-link" type="button" data-add-host="${esc(f.host)}">${esc(state.add)}</button>` : ""}
    </li>`;
  });
  const away = pullFolders.unreachable.map((u) => `<li class="pr-bad"><strong>${esc(u.machine)}</strong> could not be asked: ${esc(u.why)}</li>`);
  list.innerHTML = [...rows, ...away].join("") || `<li class="pr-wait">No folders yet.</li>`;
}

async function loadPullFolders() {
  pullFolders = null;
  renderFolders();
  try {
    pullFolders = await api("GET", "/api/settings/pull-requests/folders");
  } catch (err) {
    pullFolders = { folders: [], unreachable: [{ machine: "Yardbell", why: err.message }] };
  }
  renderFolders();
}

let pullFoldersAsked = false;

function pullFoldersWanted() {
  if (pullFoldersAsked || location.hash !== "#pull-requests") return;
  pullFoldersAsked = true;
  loadPullFolders();
}

window.addEventListener("hashchange", pullFoldersWanted);

$("pr-folders-refresh").addEventListener("click", loadPullFolders);

$("pr-form").addEventListener("change", (e) => {
  if (["use_github", "use_gitlab"].includes(e.target.name)) renderFolders();
});

$("pr-folders").addEventListener("click", (e) => {
  const button = e.target.closest("[data-add-host]");
  if (!button) return;
  gitlabHosts.push({ host: button.dataset.addHost, url: "", token: "" });
  renderHosts();
  $("pr-hosts").querySelector(".row:last-child [data-key=token]").focus();
});

let connections = { list: [], status: {}, starters: {} };
let connHeaders = [];
let connWas = "";

async function loadConnections() {
  connections = await api("GET", "/api/settings/connectors");
  renderConnections();
}

function renderConnections() {
  $("conn-none").hidden = connections.list.length > 0;
  $("conn-rows").hidden = !connections.list.length;
  $("conn-rows").innerHTML = connections.list.map((c) => {
    const status = connections.status[c.id];
    const line = c.missing.length
      ? { cls: "pr-bad", text: `Save the secret ${c.missing.join(", ")}` }
      : !c.enabled
        ? { cls: "pr-wait", text: "Switched off" }
        : status
          ? { cls: status.ok ? "pr-ok" : "pr-bad", text: status.message }
          : { cls: "pr-wait", text: "Not checked yet" };
    return `<li class="row conn-row" data-conn="${esc(c.id)}">
      <span class="conn-name"><strong>${esc(c.name)}</strong> <small>${esc(c.host || "")}</small>
        <span class="conn-state ${line.cls}">${esc(line.text)}</span></span>
      <span class="conn-actions">
        <button class="btn small-link" type="button" data-conn-act="test">Test</button>
        <button class="btn small-link" type="button" data-conn-act="share">Share</button>
        <button class="btn small-link" type="button" data-conn-act="edit">Edit</button>
        <button class="btn quiet danger small-link" type="button" data-conn-act="delete">Delete</button>
      </span>
    </li>`;
  }).join("");
}

function renderConnHeaders() {
  $("conn-headers").innerHTML = connHeaders.map((h, i) => `<li class="conn-header" data-header="${i}">
    <input data-key="name" aria-label="Header name" placeholder="Authorization" value="${esc(h.name)}" autocapitalize="off" spellcheck="false">
    <input data-key="value" aria-label="Header value" placeholder="Bearer \${secret:my_token}" value="${esc(h.value)}" autocapitalize="off" spellcheck="false">
    <button class="btn quiet danger" type="button" data-header-remove="${i}" aria-label="Remove header" title="Remove header">${CROSS}</button>
  </li>`).join("");
}

function openConnection(c, was) {
  connWas = was;
  const f = $("conn-form");
  f.hidden = false;
  $("conn-import").hidden = true;
  $("conn-output").hidden = true;
  for (const key of ["name", "id", "base_url", "params_yaml", "calls_yaml"]) f.elements[key].value = c[key] || "";
  f.elements.enabled.checked = c.enabled !== false;
  f.elements.allow_private.checked = !!c.allow_private;
  connHeaders = Object.entries(c.headers || {}).map(([name, value]) => ({ name, value }));
  renderConnHeaders();
  $("conn-note").textContent = c.missing?.length ? `Save the secret ${c.missing.join(", ")} before you switch this on.` : "";
  f.elements.name.focus();
}

function showConnOutput(html) {
  const out = $("conn-output");
  out.hidden = false;
  out.innerHTML = html;
}

$("conn-trello").addEventListener("click", () => openConnection(connections.starters.trello, ""));
$("conn-blank").addEventListener("click", () => openConnection({ enabled: true, headers: {} }, ""));
$("conn-cancel").addEventListener("click", () => { $("conn-form").hidden = true; });
$("conn-header-add").addEventListener("click", () => {
  connHeaders.push({ name: "", value: "" });
  renderConnHeaders();
});
$("conn-headers").addEventListener("input", (e) => {
  const row = e.target.closest("[data-header]");
  if (row && e.target.dataset.key) connHeaders[Number(row.dataset.header)][e.target.dataset.key] = e.target.value;
});
$("conn-headers").addEventListener("click", (e) => {
  const button = e.target.closest("[data-header-remove]");
  if (!button) return;
  connHeaders.splice(Number(button.dataset.headerRemove), 1);
  renderConnHeaders();
});
$("conn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    was: connWas,
    id: f.elements.id.value.trim(),
    name: f.elements.name.value.trim(),
    base_url: f.elements.base_url.value.trim(),
    enabled: f.elements.enabled.checked,
    allow_private: f.elements.allow_private.checked,
    headers: Object.fromEntries(connHeaders.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value.trim()])),
    params_yaml: f.elements.params_yaml.value,
    calls_yaml: f.elements.calls_yaml.value,
  };
  try {
    await api("POST", "/api/settings/connectors", body);
    saved(`${body.name || body.id} saved.`);
    f.hidden = true;
    await load();
  } catch (err) {
    $("conn-note").textContent = err.message;
    toast(err.message);
  }
});
$("conn-import-open").addEventListener("click", () => {
  $("conn-import").hidden = false;
  $("conn-form").hidden = true;
  $("conn-output").hidden = true;
  $("conn-import").elements.text.focus();
});
$("conn-import-cancel").addEventListener("click", () => { $("conn-import").hidden = true; });
$("conn-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const out = await api("POST", "/api/settings/connectors/import", { text: e.target.elements.text.value });
    e.target.hidden = true;
    e.target.elements.text.value = "";
    saved(`${out.id} imported, switched off.`);
    await load();
    const needs = out.secrets.length ? ` It needs the secret ${out.secrets.join(", ")}.` : "";
    showConnOutput(`<p>${esc(out.id)} can reach <strong>${esc(out.host || "")}</strong>.${esc(needs)} Read its calls, then switch it on with <strong>Edit</strong>.</p>`);
  } catch (err) {
    toast(err.message);
  }
});
$("conn-rows").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-conn-act]");
  if (!button) return;
  const id = button.closest("[data-conn]").dataset.conn;
  const c = connections.list.find((x) => x.id === id);
  const at = `/api/settings/connectors/${encodeURIComponent(id)}`;
  try {
    if (button.dataset.connAct === "edit") openConnection(c, id);
    if (button.dataset.connAct === "delete") {
      if (!(await Nav.confirm(`Delete ${c.name}?`, "A pipeline using it waits until it has another. Its secrets stay.", { confirm: "Delete", danger: true }))) return;
      await api("DELETE", at);
      saved(`${c.name} deleted.`);
      await load();
    }
    if (button.dataset.connAct === "share") {
      const { text } = await api("GET", `${at}/share`);
      showConnOutput(`<p class="help">This holds no secret values, only their names.</p><textarea id="conn-share-text" rows="12" readonly spellcheck="false">${esc(text)}</textarea>`);
    }
    if (button.dataset.connAct === "test") {
      showConnOutput(`<p class="help">Reading ${esc(c.name)}...</p>`);
      const out = await api("POST", `${at}/test`, {});
      const items = out.items.map((i) => `<li><strong>${esc(i.id)}</strong> ${esc(i.title)} <small>${esc(i.state)}</small></li>`).join("");
      const skipped = out.skipped.map((s) => `<li class="pr-bad">Skipped: ${esc(s)}</li>`).join("");
      showConnOutput(`<p><strong>${out.count} items.</strong>${out.cut_off ? ` <span class="pr-bad">${esc(out.cut_off)}</span>` : ""}</p>
        <ul class="conn-items">${skipped}${items}</ul>
        <p class="pl-field-head">Fields you can map</p>
        <p class="conn-paths">${out.paths.map((p) => `<code>${esc(p)}</code>`).join(" ")}</p>`);
      await loadConnections();
    }
  } catch (err) {
    showConnOutput(`<p class="pr-bad">${esc(err.message)}</p>`);
    await loadConnections().catch(() => {});
  }
});

$("pr-add-host").addEventListener("click", () => {
  gitlabHosts.push({ host: "", url: "", token: "" });
  renderHosts();
  $("pr-hosts").querySelector(".row:last-child [data-key=host]").focus();
});

for (const type of ["input", "change"]) {
  $("pr-hosts").addEventListener(type, (e) => {
    const row = e.target.closest("[data-host]");
    if (row && e.target.dataset.key) gitlabHosts[Number(row.dataset.host)][e.target.dataset.key] = e.target.value;
  });
}

$("pr-hosts").addEventListener("click", (e) => {
  const button = e.target.closest("[data-remove-host]");
  if (!button) return;
  gitlabHosts.splice(Number(button.dataset.removeHost), 1);
  renderHosts();
});

$("pr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    enabled: f.elements.enabled.checked,
    cards: f.elements.cards.checked,
    use_github: f.elements.use_github.checked,
    use_gitlab: f.elements.use_gitlab.checked,
    poll_seconds: Number(f.elements.poll_seconds.value),
    gitlab: gitlabHosts.map((g) => ({ host: g.host.trim(), ...(g.url.trim() ? { url: g.url.trim() } : {}), token: g.token })),
  };
  try {
    await api("POST", "/api/settings/pull-requests", body);
    saved("GitHub and GitLab updated.");
    await load();
    loadPullFolders();
  } catch (err) {
    toast(err.message);
  }
});

$("phone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    wait_minutes: Number(f.elements.wait_minutes.value.trim()),
    agent_waiting: f.elements.agent_waiting.checked,
    session_ended: f.elements.session_ended.checked,
    machines: f.elements.machines.checked,
    memory: f.elements.memory.checked,
    pipeline_waiting: f.elements.pipeline_waiting.checked,
    pipeline_finished: f.elements.pipeline_finished.checked,
    proposals: f.elements.proposals.checked,
  };
  phoneBusy(true);
  try {
    await api("POST", "/api/settings/phone", body);
    saved("Phone notifications updated.");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    phoneBusy(false);
  }
});

$("mcp-on").addEventListener("click", () => mcpAction("/api/settings/mcp/on", "The MCP server is on."));

$("mcp-rotate").addEventListener("click", async () => {
  if (!(await Nav.confirm("Make a new MCP token?", "Agents set up with the current token lose access until you add Yardbell again with the new command.", { confirm: "Make new token" }))) return;
  mcpAction("/api/settings/mcp/on", "New token made. Add Yardbell to your agents again.");
});

$("mcp-turn-off").addEventListener("click", async () => {
  if (!(await Nav.confirm("Turn off the MCP server?", "Agents lose access to Yardbell's tools. Turning it on again makes a new token.", { confirm: "Turn off", danger: true }))) return;
  mcpAction("/api/settings/mcp/off", "The MCP server is off.");
});

$("dispatch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const button = f.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("POST", "/api/settings/dispatch", {
      instructions: f.elements.instructions.value,
      agent: f.elements.agent.value,
      runs_on: f.elements.runs_on.value,
      model: f.elements.model.value,
      codex_model: f.elements.codex_model.value.trim(),
      approval: f.elements.approval.value,
      rules: rules.map((r) => ({ ...r, folder: r.folder.trim() })),
    });
    const before = (data.dispatch || {}).runs_on || "claude";
    const now = f.elements.runs_on.value;
    const name = dispatchRunsOnAgents().find((a) => a.name === now)?.label || now;
    saved(now === before
      ? "Dispatch settings saved. They apply from the next message."
      : `Dispatch settings saved. New conversations start on ${name}, and open ones carry on where they started.`);
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$("dispatch-form").elements.runs_on.addEventListener("change", dispatchRunsOn);
$("dispatch-form").elements.codex_model.addEventListener("input", codexModelNote);

$("rule-add").addEventListener("click", () => {
  rules.push({ action: "stop_session", machine: "any", folder: "", approval: "deny" });
  renderRules();
  $("rule-rows").querySelector("li:last-child select")?.focus();
});

$("rule-rows").addEventListener("input", (e) => {
  const row = e.target.closest("[data-rule]");
  if (!row || !e.target.dataset.key) return;
  const rule = rules[Number(row.dataset.rule)];
  rule[e.target.dataset.key] = e.target.value;
  if (e.target.dataset.key === "action" && UNPLACED.has(e.target.value) !== row.querySelector("[data-key=folder]").disabled) {
    if (UNPLACED.has(rule.action)) Object.assign(rule, { machine: "any", folder: "" });
    renderRules();
    $("rule-rows").querySelector(`[data-rule="${row.dataset.rule}"] [data-key=action]`)?.focus();
  }
});

$("rule-rows").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove-rule]");
  if (!remove) return;
  rules.splice(Number(remove.dataset.removeRule), 1);
  renderRules();
});

let triggerData = { zone: "", now: "", triggers: [], tasks: [] };
let editingTrigger = null;

function wall(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stamp || "");
  return m ? { date: m[1], time: m[2] } : null;
}

// Times are the server's wall clock, as the schedule is, whatever the browser's own time zone.
function serverWhen(stamp) {
  const at = wall(stamp);
  const today = wall(triggerData.now);
  if (!at || !today) return "";
  const days = Math.round((Date.parse(at.date) - Date.parse(today.date)) / 86400000);
  if (days === 0) return `${at.time} today`;
  if (days === 1) return `${at.time} tomorrow`;
  if (days === -1) return `${at.time} yesterday`;
  const day = new Date(`${at.date}T12:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${day} ${at.time}`;
}

function triggerRow(v, i) {
  const t = v.trigger;
  const schedule = v.kind === "schedule";
  const plan = !t.enabled ? "Off" : v.busy ? "Running now" : schedule && v.next ? `Next ${serverWhen(v.next)}` : !schedule && v.checked ? `Checked ${serverWhen(v.checked)}` : "";
  const last = v.last
    ? `<p class="help trigger-last" data-outcome="${esc(v.last.outcome)}">${v.last.outcome === "watching" ? "" : "Last run "}${esc(serverWhen(v.last.at))}: ${esc(v.last.text)}.${v.last.conversation ? ` <a href="/dispatch?c=${encodeURIComponent(v.last.conversation)}">Open the conversation</a>` : ""}</p>`
    : "";
  return `<li class="row trigger-row${t.enabled ? "" : " off"}">
    <input type="checkbox" class="switch" data-toggle="${i}" aria-label="${esc(t.name)} on"${t.enabled ? " checked" : ""}>
    <div class="row-main">
      <div class="row-title"><span class="folder">${esc(t.name)}</span><span class="note">${esc(v.describe)}</span></div>
      <p class="help">Runs the task <strong>${esc(t.task)}</strong>${plan ? ` · ${esc(plan)}` : ""}</p>
      ${last}
      ${v.note ? `<p class="help">${esc(v.note)}.</p>` : ""}
      ${v.problem ? `<p class="help trigger-problem">${esc(v.problem.charAt(0).toUpperCase() + v.problem.slice(1))}.</p>` : ""}
    </div>
    <div class="row-actions">
      <button class="btn" type="button" data-run="${i}"${!schedule && !t.enabled ? " disabled" : ""}>${schedule ? "Run now" : "Check now"}</button>
      <button class="btn" type="button" data-edit="${i}">Edit</button>
      <button class="btn quiet danger" type="button" data-remove="${i}">Delete</button>
    </div>
  </li>`;
}

function renderTriggers() {
  const list = triggerData.triggers;
  if (triggerData.zone) $("trigger-zone").textContent = triggerData.zone;
  $("trigger-rows").hidden = !list.length;
  $("triggers-empty").hidden = Boolean(list.length);
  $("trigger-rows").innerHTML = list.map(triggerRow).join("");
}

async function loadTriggers() {
  triggerData = await api("GET", "/api/triggers");
  renderTriggers();
}

function showTriggerKind() {
  const f = $("trigger-form");
  const kind = f.elements.kind.value;
  const repeat = f.elements.repeat.value;
  f.querySelectorAll("[data-kind]").forEach((el) => { el.hidden = !el.dataset.kind.split(" ").includes(kind); });
  f.querySelectorAll("[data-repeat]").forEach((el) => { el.hidden = !el.dataset.repeat.split(" ").includes(repeat); });
  // A field that is not shown is not checked or sent.
  f.querySelectorAll("[data-kind] input, [data-kind] select").forEach((el) => { el.disabled = Boolean(el.closest("[hidden]")); });
}

function openTriggerForm(index) {
  editingTrigger = index;
  const t = index === null
    ? { name: "", task: triggerData.tasks[0] || "", enabled: true, schedule: "daily 09:00" }
    : triggerData.triggers[index].trigger;
  const f = $("trigger-form");
  f.reset();
  const tasks = triggerData.tasks.includes(t.task) || !t.task ? triggerData.tasks : [...triggerData.tasks, t.task];
  f.elements.task.innerHTML = tasks.map((name) => `<option value="${esc(name)}">${esc(name)}${triggerData.tasks.includes(name) ? "" : " (deleted)"}</option>`).join("");
  f.elements.name.value = t.name;
  f.elements.task.value = t.task;
  f.elements.kind.value = t.linear ? "linear" : t.github ? "github" : "schedule";
  const words = (t.schedule || "daily 09:00").split(/\s+/);
  f.elements.repeat.value = ["daily", "weekdays", "every", "cron"].includes(words[0]) ? words[0] : "daily";
  if (words[0] === "daily" || words[0] === "weekdays") f.elements.at.value = (words[1] || "09:00").padStart(5, "0");
  if (words[0] === "every") f.elements.hours.value = parseInt(words[1], 10) || 4;
  if (words[0] === "cron") f.elements.cron.value = words.slice(1).join(" ");
  f.elements.linear_assigned.checked = t.linear ? Boolean(t.linear.assigned) : true;
  f.elements.states.value = (t.linear?.states || []).join(", ");
  f.elements.gh_assigned.checked = Boolean(t.github?.assigned);
  f.elements.gh_review.checked = t.github ? Boolean(t.github.review_requested) : true;
  f.elements.enabled.checked = t.enabled !== false;
  f.hidden = false;
  showTriggerKind();
  f.elements.name.focus();
}

function readTrigger(f) {
  const e = f.elements;
  const t = { name: e.name.value.trim(), task: e.task.value, enabled: e.enabled.checked };
  if (e.kind.value === "linear") {
    t.linear = { assigned: e.linear_assigned.checked, states: e.states.value.split(",").map((s) => s.trim()).filter(Boolean) };
  } else if (e.kind.value === "github") {
    t.github = { assigned: e.gh_assigned.checked, review_requested: e.gh_review.checked };
  } else {
    const repeat = e.repeat.value;
    t.schedule = repeat === "every" ? `every ${e.hours.value.trim()}h` : repeat === "cron" ? `cron ${e.cron.value.trim()}` : `${repeat} ${e.at.value}`;
  }
  return t;
}

async function saveTriggers(list, message) {
  triggerData = await api("POST", "/api/triggers", { triggers: list });
  renderTriggers();
  saved(message);
}

$("trigger-add").addEventListener("click", () => openTriggerForm(null));
$("trigger-cancel").addEventListener("click", () => { $("trigger-form").hidden = true; });
$("trigger-form").elements.kind.addEventListener("change", showTriggerKind);
$("trigger-form").elements.repeat.addEventListener("change", showTriggerKind);

$("trigger-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const button = f.querySelector("button[type=submit]");
  const t = readTrigger(f);
  const list = triggerData.triggers.map((v) => v.trigger);
  if (editingTrigger === null) list.push(t);
  else list[editingTrigger] = t;
  button.disabled = true;
  try {
    await saveTriggers(list, `Trigger ${t.name} saved.`);
    f.hidden = true;
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$("trigger-rows").addEventListener("change", async (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (!toggle) return;
  const t = triggerData.triggers[Number(toggle.dataset.toggle)].trigger;
  try {
    triggerData = await api("POST", "/api/triggers/enable", { name: t.name, enabled: toggle.checked });
    saved(`Trigger ${t.name} is ${toggle.checked ? "on" : "off"}.`);
  } catch (err) {
    toast(err.message);
  }
  renderTriggers();
});

$("trigger-rows").addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit]");
  if (edit) { openTriggerForm(Number(edit.dataset.edit)); return; }
  const remove = e.target.closest("[data-remove]");
  if (remove) {
    const index = Number(remove.dataset.remove);
    const t = triggerData.triggers[index].trigger;
    if (!(await Nav.confirm(`Delete the trigger ${t.name}?`, "Conversations it started are kept.", { confirm: "Delete", danger: true }))) return;
    try {
      await saveTriggers(triggerData.triggers.map((v) => v.trigger).filter((_, i) => i !== index), `Trigger ${t.name} deleted.`);
      if (editingTrigger === index) $("trigger-form").hidden = true;
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const run = e.target.closest("[data-run]");
  if (!run) return;
  const t = triggerData.triggers[Number(run.dataset.run)].trigger;
  run.disabled = true;
  try {
    const out = await api("POST", "/api/triggers/run", { name: t.name });
    toast(out.conversation ? `${t.name} started a conversation in Dispatch.` : `${out.text}.`, "ok");
  } catch (err) {
    toast(err.message.charAt(0).toUpperCase() + err.message.slice(1));
  }
  await loadTriggers().catch((err) => toast(err.message));
});

let pairTimer = 0;

function stopPairing(message) {
  clearInterval(pairTimer);
  $("pair-code").hidden = true;
  $("pair-code").innerHTML = "";
  $("pair-show").textContent = "Show pairing code";
  $("pair-status").textContent = message || "";
}

$("pair-show").addEventListener("click", async () => {
  const button = $("pair-show");
  button.disabled = true;
  try {
    const pair = await api("POST", "/api/settings/pair", {});
    clearInterval(pairTimer);
    $("pair-code").innerHTML = pair.qr_svg;
    $("pair-code").hidden = false;
    button.textContent = "Show a new code";
    const ends = Date.now() + pair.expires_in * 1000;
    const tick = () => {
      const left = Math.round((ends - Date.now()) / 1000);
      if (left <= 0) { stopPairing("That code expired. Show a new one to pair."); return; }
      $("pair-status").textContent = `Pairs with ${pair.server}. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`;
    };
    tick();
    pairTimer = setInterval(tick, 1000);
  } catch (err) {
    stopPairing();
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$("server-add").addEventListener("click", () => openServerForm(null));
$("server-cancel").addEventListener("click", () => { $("server-form").hidden = true; });
$("server-form").elements.kind.addEventListener("change", (e) => showKind(e.target.value));

$("server-rows").addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit]");
  if (edit) { openServerForm(Number(edit.dataset.edit)); return; }
  const remove = e.target.closest("[data-remove]");
  if (!remove) return;
  const srv = data.mcp_servers[Number(remove.dataset.remove)];
  if (!(await Nav.confirm(`Remove ${srv.name}?`, "New sessions stop getting this server. Running sessions keep it until they end.", { confirm: "Remove", danger: true }))) return;
  try {
    await saveServers(data.mcp_servers.filter((s) => s !== srv), `${srv.name} removed.`);
  } catch (err) {
    toast(err.message);
  }
});

$("server-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const url = f.elements.kind.value === "url";
  try {
    const pairs = readPairs(f.elements.pairs.value);
    const srv = {
      name: f.elements.name.value.trim(),
      command: url ? "" : f.elements.command.value.trim(),
      url: url ? f.elements.url.value.trim() : "",
      env: url ? {} : pairs,
      headers: url ? pairs : {},
      machines: [...$("server-machines").querySelectorAll("input:checked")].map((c) => c.value),
    };
    const servers = [...(data.mcp_servers || [])];
    if (editing === null) servers.push(srv); else servers[editing] = srv;
    await saveServers(servers, `${srv.name} saved. New Claude Code sessions get it.`);
    f.hidden = true;
  } catch (err) {
    toast(err.message);
  }
});

$("mcp-copy").addEventListener("click", () => {
  if (copyText($("mcp-command").textContent)) toast("Command copied", "ok");
  else toast("Couldn't copy. Select the command and copy it.");
});

$("mcp-token-copy").addEventListener("click", () => {
  if (copyText(data.mcp.token)) toast("Token copied. Paste it when the command asks for it.", "ok");
  else toast("Couldn't copy the token.");
});

$("memory-add").addEventListener("click", () => openMemoryForm(null));
$("memory-cancel").addEventListener("click", () => { $("memory-form").reset(); $("memory-form").hidden = true; memoryEditing = null; });

async function changeMemory(change, done) {
  memory = await api("POST", "/dispatch/memory", change);
  renderMemory();
  toast(done, "ok");
}

$("memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const entry = f.elements.entry.value.trim();
  const button = f.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const change = memoryEditing === null ? { change: "add", entry } : { change: "replace", old: memoryEditing, entry };
    await changeMemory(change, "Saved. Dispatch reads it from the next message.");
    f.reset();
    f.hidden = true;
    memoryEditing = null;
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$("memory-rows").addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-memory-edit]");
  if (edit) { openMemoryForm(Number(edit.dataset.memoryEdit)); return; }
  const del = e.target.closest("[data-memory-delete]");
  if (!del) return;
  const entry = memory.entries[Number(del.dataset.memoryDelete)];
  if (!(await Nav.confirm("Delete this entry?", `Dispatch stops reading "${entry}" from the next message. The history keeps a record of it.`, { confirm: "Delete", danger: true }))) return;
  try {
    await changeMemory({ change: "forget", old: entry }, "Deleted.");
  } catch (err) {
    toast(err.message);
  }
});

$("secret-add").addEventListener("click", () => openSecretForm(null));
$("secret-cancel").addEventListener("click", () => { $("secret-form").reset(); $("secret-form").hidden = true; });

$("secret-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.elements.name.value.trim();
  const button = f.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("POST", "/api/settings/secrets", { name, value: f.elements.value.value });
    f.reset();
    f.hidden = true;
    toast(`${name} saved. New sessions get it.`, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$("secret-rows").addEventListener("click", async (e) => {
  const replace = e.target.closest("[data-replace]");
  if (replace) { openSecretForm(replace.dataset.replace); return; }
  const del = e.target.closest("[data-delete]");
  if (!del) return;
  const name = del.dataset.delete;
  const users = (data.secrets.list.find((x) => x.name === name) || {}).used_by || [];
  const servers = users.filter((u) => u !== "Linear triggers");
  const text = users.length
    ? [
      `${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it.`,
      servers.length ? `New Claude Code sessions that get ${servers.length === 1 ? "that server" : "those servers"} do not start until you set it again.` : "",
      servers.length < users.length ? "Linear triggers stop until you set it again." : "",
    ].filter(Boolean).join(" ")
    : "No server uses it. The value cannot be brought back.";
  if (!(await Nav.confirm(`Delete the secret ${name}?`, text, { confirm: "Delete", danger: true }))) return;
  try {
    await api("POST", "/api/settings/secrets/delete", { name });
    toast(`${name} deleted.`, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$("secrets-move").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const items = [...$("inline-picks").querySelectorAll("input:checked")]
    .map((c) => data.secrets.inline[Number(c.dataset.inline)])
    .map(({ kind, server, key }) => ({ kind, server, key }));
  if (!items.length) { toast("Tick the values to move first."); return; }
  button.disabled = true;
  try {
    const res = await api("POST", "/api/settings/secrets/move", { items });
    $("undo-bar").hidden = true;
    toast(`Moved ${res.moved.length} ${res.moved.length === 1 ? "value" : "values"} into secrets.`, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$("pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.elements.new.value !== f.elements.repeat.value) { toast("The two new passcodes do not match"); return; }
  try {
    await api("POST", "/api/settings/passcode", { current: f.elements.current.value, new: f.elements.new.value });
    f.reset();
    toast("Passcode changed", "ok");
  } catch (err) {
    toast(err.message);
  }
});

$("logout-all").addEventListener("click", async () => {
  if (!(await Nav.confirm("Sign out every other phone and browser?", "They need the passcode to log in again.", { confirm: "Log out everywhere", danger: true }))) return;
  try {
    await api("POST", "/api/settings/logout-all", {});
    toast("Every other device is signed out", "ok");
  } catch (err) {
    toast(err.message);
  }
});

$("undo-btn").addEventListener("click", async () => {
  try {
    await api("POST", "/api/settings/undo", {});
    $("undo-title").textContent = "Undone.";
    $("undo-text").textContent = "The previous settings are back.";
    $("undo-btn").hidden = true;
    $("restart-btn").hidden = true;
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$("restart-btn").addEventListener("click", async () => {
  try {
    const res = await api("POST", "/api/settings/restart", {});
    toast(res.message, "ok");
    setTimeout(() => location.reload(), 4000);
  } catch (err) {
    toast(err.message);
  }
});

const EXTERNAL = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3H13v3.5M13 3 7.5 8.5M11 9.5V13H3V5h3.5"/></svg>`;
let updatesAsked = false;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function uptime(secs) {
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days) return hours ? `${plural(days, "day")}, ${plural(hours, "hour")}` : plural(days, "day");
  if (hours) return mins ? `${plural(hours, "hour")}, ${plural(mins, "minute")}` : plural(hours, "hour");
  return mins ? plural(mins, "minute") : "less than a minute";
}

function versionParts(v) {
  return String(v || "").split(/[-+]/)[0].split(".").map(Number);
}

function olderThan(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

async function appVersion() {
  try { return (await window.__TAURI__?.app?.getVersion?.()) || null; } catch { return null; }
}

function renderAbout(a, app) {
  $("about-version").textContent = a.version;
  const since = new Date(a.started_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const system = `${esc(a.os)} · ${esc(a.arch)}${a.container ? ` <span class="note">in a container</span>` : ""}`;
  const facts = [
    app && ["This app", app === a.version ? `${esc(app)}, the same as the server` : esc(app)],
    ["Build", `<code>${esc(a.build)}</code>`],
    ["Machine", `${esc(a.machine)} <code>${esc(a.address)}</code>`],
    ["System", system],
    ["Running for", `<span title="Since ${esc(since)}">${uptime(a.uptime_secs)}</span>`],
    ["Config", `<code>${esc(a.config)}</code>`],
    ["State", `<code>${esc(a.state)}</code>`],
  ].filter(Boolean);
  $("about-facts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}${EXTERNAL}</a>`;
  $("about-links").innerHTML = [
    link(a.links.release, `Release notes for ${esc(a.version)}`),
    link(a.links.changelog, "Changelog"),
    link(a.links.docs, "Documentation"),
  ].join("");
  const mismatch = Boolean(app) && app !== a.version;
  $("about-mismatch").hidden = !mismatch;
  if (mismatch) {
    const older = olderThan(app, a.version) ? "this app" : `the server on ${a.machine}`;
    $("about-mismatch-title").textContent = `This app is ${app}, the server on ${a.machine} is ${a.version}.`;
    $("about-mismatch-text").textContent = `Update ${older} so both run the same release. Until then, parts of the app may not match the server.`;
  }
}

function showUpdate(kind, markup) {
  const el = $("about-update");
  el.className = `about-update${kind ? ` ${kind}` : ""}`;
  el.innerHTML = markup;
  $("about-retry").hidden = kind !== "unknown";
}

async function checkUpdates() {
  updatesAsked = true;
  showUpdate("", "Checking for updates…");
  try {
    const u = await api("GET", "/app/about/updates");
    if (u.state === "available") {
      showUpdate("available", `<a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.latest)} is available</a>`);
    } else if (u.state === "up_to_date") {
      showUpdate("ok", `<span class="dot ok"></span>Up to date`);
    } else {
      throw new Error(u.reason);
    }
  } catch (err) {
    showUpdate("unknown", `<span title="${esc(err.message)}">Couldn't check for updates</span>`);
  }
}

async function loadAbout() {
  const [a, app] = await Promise.all([api("GET", "/app/about"), appVersion()]);
  renderAbout(a, app);
}

$("about-retry").addEventListener("click", checkUpdates);

load()
  .then(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  })
  .catch((err) => toast(err.message));

// One section at a time, picked in the section list, so each part of Settings stands on its own.
function showSection() {
  const sections = [...document.querySelectorAll(".page-body > section")];
  const wanted = location.hash.slice(1);
  const target = wanted ? document.getElementById(wanted) : null;
  const order = [...document.querySelectorAll(".settings-nav a")].map((a) => a.hash.slice(1));
  const pick = sections.find((sec) => sec.contains(target)) || sections.find((sec) => sec.id === order[0]);
  sections.forEach((sec) => { sec.hidden = sec !== pick; });
  if (pick.id === "about" && !updatesAsked) checkUpdates();
  document.querySelectorAll(".settings-nav a").forEach((a) => {
    if (a.hash === `#${pick.id}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.querySelector(".settings-nav [aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

window.addEventListener("hashchange", () => {
  showSection();
  const target = document.getElementById(location.hash.slice(1));
  if (target && target.tagName !== "SECTION") { target.scrollIntoView({ block: "start" }); return; }
  document.querySelector(".main")?.scrollTo({ top: 0 });
  window.scrollTo({ top: 0 });
});
showSection();
loadAbout().catch((err) => toast(err.message));

let setups = [];

function renderSetups() {
  const machines = { any: "Any machine", ...Object.fromEntries((data.machines || []).map((m) => [m.name, m.name])) };
  $("setup-rows").innerHTML = setups.length
    ? setups.map((x, i) => `<li class="row setup-row" data-setup="${i}">
      <input type="text" data-key="folder" aria-label="Folder" value="${esc(x.folder)}" placeholder="acme/web" autocapitalize="off" spellcheck="false">
      <select data-key="machine" aria-label="Machine">${options(machines, x.machine)}</select>
      <input type="text" class="mono" data-key="command" aria-label="Command" value="${esc(x.command)}" placeholder="bin/setup" autocapitalize="off" spellcheck="false">
      <input type="text" class="mono" data-key="teardown" aria-label="When a run ends" title="Runs when a pipeline run that used this worktree ends" value="${esc(x.teardown || "")}" placeholder="When a run ends: docker compose down" autocapitalize="off" spellcheck="false">
      <input type="number" data-key="timeout_seconds" aria-label="Timeout in seconds" title="Timeout in seconds" value="${esc(x.timeout_seconds)}" min="1" max="3600">
      <button class="btn quiet danger" type="button" data-remove-setup="${i}" aria-label="Remove command" title="Remove command">${CROSS}</button>
    </li>`).join("")
    : `<li class="row rule-empty">No setup commands. New worktrees start the agent right away.</li>`;
}

async function loadSetups() {
  try {
    const res = await api("GET", "/api/settings/worktree-setup");
    setups = (res.setups || []).map((x) => ({ machine: "any", timeout_seconds: 300, ...x }));
  } catch {
    setups = [];
  }
  renderSetups();
}

$("setup-add").addEventListener("click", () => {
  setups.push({ folder: "", machine: "any", command: "", timeout_seconds: 300 });
  renderSetups();
  $("setup-rows").querySelector("li:last-child input")?.focus();
});

$("setup-rows").addEventListener("input", (e) => {
  const row = e.target.closest("[data-setup]");
  if (!row || !e.target.dataset.key) return;
  const key = e.target.dataset.key;
  setups[Number(row.dataset.setup)][key] = key === "timeout_seconds" ? Number(e.target.value) : e.target.value;
});

$("setup-rows").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove-setup]");
  if (!remove) return;
  setups.splice(Number(remove.dataset.removeSetup), 1);
  renderSetups();
});

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("POST", "/api/settings/worktree-setup", { setups });
    saved("Worktree setup saved. It applies to the next worktree Yardbell creates.");
    await loadSetups();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});
