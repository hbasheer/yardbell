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

const HEALTH_CHECKS = ["run_queued", "run_waiting", "step_quiet", "ci_pending", "trigger_failing", "memory_short"];

function renderHealthChecks(h) {
  const f = $("health-form");
  for (const name of HEALTH_CHECKS) {
    f.elements[name].checked = h[name];
    f.elements[`${name}_minutes`].value = h[`${name}_minutes`];
  }
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

const RULE_STEPS = { any: "Any step", call_connector: "Call a connected tool", call_tool: "Call an MCP tool", save_connector: "Save a connection", start_session: "Start a session", stop_session: "Stop a session", send_to_session: "Type into a session", review_session: "Start a review", scan_folder: "Start a scan", remove_worktree: "Remove a worktree", integrate_branches: "Integrate branches", push_branch: "Push a branch", move_session: "Move a session", change_settings: "Change settings", save_task: "Save a task", run_trigger: "Run a trigger", save_pipeline: "Save a pipeline", set_pipeline_enabled: "Turn a pipeline on or off", run_pipeline: "Run a pipeline", answer_run: "Answer a run", remember: "Change Dispatch's memory" };
const UNPLACED = new Set(["save_connector", "call_connector", "call_tool", "remember", "change_settings", "save_task", "run_trigger", "save_pipeline", "set_pipeline_enabled", "run_pipeline", "answer_run"]);
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

const MORE_ICON = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="0.6"/><circle cx="8" cy="8" r="0.6"/><circle cx="12.5" cy="8" r="0.6"/></svg>`;

function rowMenu(name, items) {
  return `<span class="conn-menu"><button class="conn-more-btn" type="button" data-row-menu aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(name)}">${MORE_ICON}</button>
    <span class="menu" role="menu" hidden>${items}</span></span>`;
}

function menuItem(attrs, label, danger) {
  return `<button type="button" role="menuitem" ${danger ? 'class="danger" ' : ""}${attrs}>${esc(label)}</button>`;
}

function badge(kind, text) {
  return `<span class="conn-badge ${kind}">${esc(text)}</span>`;
}

function closeRowMenus(except) {
  document.querySelectorAll(".conn-menu .menu:not([hidden])").forEach((m) => {
    if (m === except) return;
    m.hidden = true;
    m.previousElementSibling.setAttribute("aria-expanded", "false");
  });
  if (!except) showHeldRows();
}

document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-row-menu]");
  if (!opener) { closeRowMenus(); return; }
  const menu = opener.nextElementSibling;
  closeRowMenus(menu);
  menu.hidden = !menu.hidden;
  opener.setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) menu.querySelector("button").focus();
});

document.addEventListener("keydown", (e) => {
  const menu = e.target.closest?.(".conn-menu")?.querySelector(".menu:not([hidden])");
  if (!menu) return;
  if (e.key === "Escape") {
    closeRowMenus();
    menu.previousElementSibling.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...menu.querySelectorAll("button")];
    const step = e.key === "ArrowDown" ? 1 : items.length - 1;
    items[(items.indexOf(document.activeElement) + step) % items.length].focus();
  }
});

function serverType(srv) {
  if (!srv.url) return "Command";
  return Object.keys(srv.headers || {}).length ? "Headers" : "Sign-in";
}

function serverStatus(srv) {
  const status = data.mcp_auth?.[srv.name];
  if (status === "signed_in") return badge("ok", "Signed in");
  if (status === "sign_in_again") return badge("bad", "Sign in again");
  if (status === "not_signed_in") return badge("idle", "Not signed in");
  return badge("idle", "Not checked");
}

function serverNeeds(srv) {
  const status = data.mcp_auth?.[srv.name];
  if (status !== "not_signed_in" && status !== "sign_in_again") return "";
  return `<button class="btn small-link" type="button" data-mcp-act="sign-in" data-name="${esc(srv.name)}">${status === "sign_in_again" ? "Sign in again" : "Sign in"}</button>`;
}

function serverMenu(srv, i) {
  const status = data.mcp_auth?.[srv.name];
  const name = `data-name="${esc(srv.name)}"`;
  const signOut = status === "signed_in" || status === "sign_in_again" ? menuItem(`data-mcp-act="sign-out" ${name}`, "Sign out") : "";
  const linked = connections.list.find((c) => c.server === srv.name);
  const actions = linked ? menuItem(`data-conn-edit="${esc(linked.id)}"`, "Actions") : "";
  return rowMenu(srv.name, `${menuItem(`data-mcp-act="test" ${name}`, "Test")}${actions}${menuItem(`data-edit="${i}"`, "Edit")}${signOut}${menuItem(`data-remove="${i}"`, "Remove", true)}`);
}

// Only when something changed, so a load does not lose a click on a row or close its menu.
const shownRows = new Map();

const heldRows = new Map();

function setRows(id, html) {
  if (shownRows.get(id) === html) return;
  if ($(id).querySelector(".menu:not([hidden])")) {
    heldRows.set(id, html);
    return;
  }
  shownRows.set(id, html);
  $(id).innerHTML = html;
}

function showHeldRows() {
  const held = [...heldRows];
  heldRows.clear();
  held.forEach(([id, html]) => setRows(id, html));
}

function showConnectionsEmpty() {
  $("conn-guide").open = !(data?.mcp_servers || []).length && !connections.list.length;
}

function forgeRow(key, name, where, type, state, detail) {
  return `<li class="row conn-row" data-forge="${key}">
    <span class="conn-name"><strong>${esc(name)}</strong><small>${esc(where)}</small>${detail ? `<small class="conn-detail">${esc(detail)}</small>` : ""}</span>
    <span class="conn-type">${esc(type)}</span>
    <span class="conn-status">${state}</span>
    <span class="conn-actions"><button class="btn small-link" type="button">Edit</button></span>
  </li>`;
}

function forgeBadge(on, problem, checked) {
  if (!on) return badge("idle", "Switched off");
  if (problem) return badge("bad", "Failing");
  return checked ? badge("ok", "Working") : badge("idle", "Not checked");
}

function renderForges() {
  const { value, status } = data.pull_requests;
  const githubToken = value.github_via === "token";
  const gitlabGlab = value.gitlab_via === "glab";
  const github = githubToken
    ? { problem: status.github_problem, checked: status.github_checked }
    : {
      problem: Object.values(status.machines).find(Boolean),
      checked: Object.keys(status.machines).length > 0,
    };
  const hosts = value.gitlab || [];
  const gitlab = {
    problem: hosts.length ? Object.values(status.hosts).find(Boolean) : "",
    checked: Object.keys(status.hosts).length > 0,
  };
  const on = (flag) => flag !== false;
  const linearKey = (data.secrets?.list || []).some((x) => x.name === "linear");
  setRows("forge-rows", [
    forgeRow("linear", "Linear", "Tickets for pipelines", "Token", linearKey ? badge("ok", "Saved") : badge("idle", "No key"), ""),
    forgeRow("github", "GitHub", "Pull requests and CI on sessions", githubToken ? "Token" : "gh", forgeBadge(on(value.use_github), github.problem, github.checked), on(value.use_github) ? github.problem : ""),
    forgeRow("gitlab", "GitLab", hosts.length ? hosts.map((h) => h.host).join(", ") : "Merge requests and CI on sessions", gitlabGlab ? "glab" : "Token",
      hosts.length ? forgeBadge(on(value.use_gitlab), gitlab.problem, gitlab.checked) : badge("idle", "No hosts"), on(value.use_gitlab) ? gitlab.problem : ""),
  ].join(""));
}

function showForgeFields() {
  const f = $("pr-form").elements;
  $("github-token-fields").hidden = f.github_via.value !== "token";
  $("pr-github").hidden = f.github_via.value === "token";
  $("pr-hosts").classList.toggle("no-tokens", f.gitlab_via.value === "glab");
}

function openForge(key) {
  flowAdding = false;
  showForgeFields();
  showStep(`forge-${key}`, { github: "GitHub", gitlab: "GitLab", linear: "Linear" }[key]);
}

function serverWhere(srv) {
  if (!srv.url) return srv.command;
  try { return new URL(srv.url).host; } catch { return srv.url; }
}

function renderServers() {
  renderForges();
  const servers = data.mcp_servers || [];
  $("server-rows").hidden = !servers.length;
  showConnectionsEmpty();
  setRows("server-rows", servers.map((srv, i) => {
    const limited = srv.machines?.length ? ` · ${srv.machines.join(", ")}` : "";
    return `<li class="row conn-row" data-server="${i}">
      <span class="conn-name"><strong>${esc(srv.name)}</strong><small>${esc(serverWhere(srv))}${esc(limited)}</small></span>
      <span class="conn-type">${serverType(srv)}</span>
      <span class="conn-status">${serverStatus(srv)}</span>
      <span class="conn-actions">${serverNeeds(srv)}${serverMenu(srv, i)}</span></li>`;
  }).join(""));
}

let signingIn = null;

function serverPath(name, action) {
  return `/api/settings/mcp/servers/${encodeURIComponent(name)}/${action}`;
}

function signsInHere() {
  return ["127.0.0.1", "localhost"].includes(location.hostname);
}

const FLOW_STEPS = ["conn-new-panel", "conn-tab-token", "server-form", "conn-form", "conn-import", "mcp-sign-in", "mcp-tools", "conn-output", "forge-github", "forge-gitlab", "forge-linear", "secret-form"];
const FLOW_TABS = ["conn-new-panel", "server-form", "conn-tab-token"];
let flowStep = null;
let flowAdding = false;
let flowRun = 0;

function showStep(step, title) {
  const dialog = $("conn-flow");
  flowStep = step;
  FLOW_STEPS.forEach((id) => { $(id).hidden = id !== step; });
  const tabbed = flowAdding && FLOW_TABS.includes(step);
  $("conn-tabs").hidden = !tabbed;
  $("conn-back").hidden = tabbed || !flowAdding || step === "mcp-tools";
  $("conn-tabs").querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === step)));
  $("conn-dialog-title").textContent = title || "New connection";
  $("conn-flow-error").textContent = "";
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(".conn-dialog-body").scrollTop = 0;
}

function closeFlow() {
  flowRun += 1;
  stopWaiting();
  signingIn = null;
  flowStep = null;
  flowAdding = false;
  $("mcp-sign-in").innerHTML = "";
  FLOW_STEPS.forEach((id) => { $(id).hidden = true; });
  if ($("conn-flow").open) $("conn-flow").close();
}

function tellFlow(message) {
  if ($("conn-flow").open) $("conn-flow-error").textContent = message;
  else toast(message);
}

function focusIfActive(el) {
  if (document.hasFocus()) el.focus();
}

let waiting = null;
let refreshOnReturn = false;

function stopWaiting() {
  clearInterval(waiting);
  waiting = null;
}

async function checkSignedIn() {
  const name = signingIn;
  if (!name) return;
  await refreshServerAuth();
  if (data.mcp_auth?.[name] !== "signed_in" || signingIn !== name) return;
  stopWaiting();
  await showConnected(name);
}

function waitForSignIn() {
  stopWaiting();
  waiting = setInterval(() => { checkSignedIn().catch(() => {}); }, 3000);
}

async function showConnected(name) {
  signingIn = null;
  stopWaiting();
  flowRun += 1;
  const run = flowRun;
  showStep("mcp-tools", `Connected to ${name}`);
  $("mcp-tools").innerHTML = `<p class="help" role="status">Checking what it can do.</p>`;
  await refreshServerAuth();
  await loadConnections();
  try {
    const out = await api("POST", serverPath(name, "test"));
    if (run === flowRun) showTools(name, out, `Connected to ${name}`);
  } catch (err) {
    if (run !== flowRun) return;
    $("mcp-tools").innerHTML = `<p class="help conn-error">It did not answer the check: ${esc(err.message)}</p>
      <div class="form-foot"><button class="btn primary" type="button" data-close-tools>Done</button></div>`;
  }
}

function showSignIn(name, out) {
  const panel = $("mcp-sign-in");
  signingIn = name;
  if (out.needs_sign_in === false) { showConnected(name); return; }
  showStep("mcp-sign-in", `Sign in to ${name}`);
  const cancel = `<button class="btn quiet" type="button" data-cancel>Cancel</button>`;
  if (out.needs_client) {
    panel.innerHTML = `<p class="help">${esc(out.sign_in_host)} does not let Yardbell register itself. Make an app in its developer console with this redirect address, then enter what it gives you.</p>
      <p><code>${esc(out.redirect)}</code></p>
      <div class="grid2">
        <label>Client ID <input type="text" name="client_id" autocapitalize="off" spellcheck="false"></label>
        <label>Client secret <input type="password" name="client_secret" autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
      </div>
      <div class="form-foot">${cancel}<button class="btn primary" type="button" data-client>Continue</button></div>`;
    return;
  }
  const paste = signsInHere() ? "" : `
      <p class="help">You are on another device. ${esc(out.sign_in_host)} sends you back to 127.0.0.1, which on this device is not Yardbell, so that page will not load. Copy its address and paste it here.</p>
      <label>Address of the page that did not load <input type="text" name="address" inputmode="url" autocapitalize="off" spellcheck="false"></label>`;
  panel.innerHTML = `<p>You will sign in at ${esc(out.sign_in_host)}</p>${paste}
      <div class="form-foot">${cancel}<a class="btn${paste ? "" : " primary"}" data-continue target="_blank" rel="noopener" href="${esc(out.url)}">Continue</a>${paste ? `<button class="btn primary" type="button" data-finish>Finish signing in</button>` : ""}</div>`;
}

async function refreshServerAuth() {
  const fresh = await api("GET", "/api/settings");
  data.mcp_auth = fresh.mcp_auth;
  renderServers();
}

async function startSignIn(name, client) {
  signingIn = name;
  const panel = $("mcp-sign-in");
  if (!client) {
    showStep("mcp-sign-in", `Sign in to ${name}`);
    panel.innerHTML = `<p role="status">Finding where ${esc(name)} signs you in. This can take a few seconds.</p>
      <div class="form-foot"><button class="btn quiet" type="button" data-cancel>Cancel</button></div>`;
  }
  try {
    const out = await api("POST", serverPath(name, "sign-in"), client || {});
    if (signingIn === name) showSignIn(name, out);
  } catch (err) {
    if (!client && signingIn === name) closeFlow();
    throw err;
  }
}

function showTools(name, out, heading = `${name} answered`) {
  showStep("mcp-tools", heading);
  const tools = out.tools.map((t) => `<li><code>${esc(t.name)}</code><span>${esc(t.description)}</span></li>`).join("");
  $("mcp-tools").innerHTML = `<p class="help">It offers ${out.tools.length} ${out.tools.length === 1 ? "tool" : "tools"}. None were called.</p>
    <ul class="mcp-tools">${tools}</ul>
    <div class="form-foot"><button class="btn primary" type="button" data-close-tools>Done</button></div>`;
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
  $("secret-all").hidden = !s.list.length;
  $("secret-rows").innerHTML = s.list.map((x) => `<li class="row conn-row secret-row" data-secret-row="${esc(x.name)}">
    <span class="conn-name"><code>${esc(x.name)}</code></span>
    <span class="conn-type">${x.used_by.length ? esc(x.used_by.join(", ")) : "Not used"}</span>
    <span class="conn-type">${x.updated ? esc(day(x.updated)) : ""}</span>
    <span class="conn-actions">${rowMenu(x.name, `${menuItem(`data-replace="${esc(x.name)}"`, "Replace")}${menuItem(`data-delete="${esc(x.name)}"`, "Delete", true)}`)}</span>
  </li>`).join("");
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
    : "Use it as ${secret:NAME} in a connection. Letters, digits, - and _ in the name.";
  flowAdding = false;
  showStep("secret-form", name ? `Replace ${name}` : "Add a secret");
  focusIfActive(name ? f.elements.value : f.elements.name);
}

function showKind(kind) {
  $("server-form").querySelectorAll("[data-kind]").forEach((el) => { el.hidden = el.dataset.kind !== kind; });
  $("server-pairs-label").textContent = kind === "url" ? "Headers" : "Environment variables";
  $("server-form").elements.pairs.placeholder = kind === "url" ? "Authorization=Bearer ${secret:linear}" : "GITHUB_TOKEN=${secret:github}";
}

function openServerForm(index, kind) {
  editing = index;
  const srv = index === null ? { name: "", command: "", url: "", env: {}, headers: {}, machines: [], allow_private: false } : data.mcp_servers[index];
  const f = $("server-form");
  const shown = index === null ? kind || "url" : srv.url ? "url" : "command";
  f.elements.name.value = srv.name;
  f.elements.kind.value = shown;
  f.elements.command.value = srv.command || "";
  f.elements.url.value = srv.url || "";
  f.elements.allow_private.checked = !!srv.allow_private;
  f.elements.token.value = "";
  f.elements.pairs.value = Object.entries((shown === "url" ? srv.headers : srv.env) || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  $("server-machines").innerHTML = data.machines.map((m) => `<label class="choice"><input type="checkbox" value="${esc(m.name)}"${srv.machines?.includes(m.name) ? " checked" : ""}>${esc(m.name)}</label>`).join("");
  $("server-save").textContent = index === null ? "Continue" : "Save";
  $("server-note").textContent = "";
  $("server-more").open = index !== null && Boolean(f.elements.pairs.value);
  showKind(shown);
  showStep("server-form", index === null ? "" : `Edit ${srv.name}`);
  focusIfActive(shown === "url" ? f.elements.url : f.elements.command);
}

function nameFromAddress(address) {
  const words = new URL(address).hostname.split(".").filter((w) => !["mcp", "api", "www"].includes(w));
  const base = (words[0] || "server").replace(/[^A-Za-z0-9_-]/g, "-");
  const taken = new Set((data.mcp_servers || []).map((s) => s.name));
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

const SECRET_NAME = /authori[sz]ation|token|secret|api[-_]?key|password|private/i;

async function keptAsSecret(name, value) {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 60);
  const taken = new Set((data.secrets?.list || []).map((s) => s.name));
  let clean = base;
  for (let n = 2; taken.has(clean); n += 1) clean = `${base}-${n}`;
  await api("POST", "/api/settings/secrets", { name: clean, value });
  data.secrets?.list?.push({ name: clean, used_by: [] });
  return `\${secret:${clean}}`;
}

async function tokensKept(pairs, prefix) {
  const out = {};
  for (const [key, raw] of Object.entries(pairs)) {
    const value = String(raw).trim();
    if (!value || value.includes("${secret:") || !SECRET_NAME.test(key)) {
      out[key] = raw;
      continue;
    }
    const scheme = value.match(/^(Bearer|Basic|token)\s+(.+)$/i);
    const ref = await keptAsSecret(`${prefix}_${key}`, scheme ? scheme[2] : value);
    out[key] = scheme ? `${scheme[1]} ${ref}` : ref;
  }
  return out;
}

function serverOf(f) {
  const url = f.elements.kind.value === "url";
  const address = f.elements.url.value.trim();
  const command = f.elements.command.value.trim();
  if (url && !/^https?:\/\/[^\s/]+/.test(address)) throw new Error("Paste a full address, starting with https://");
  if (!url && !command) throw new Error("Type the command that starts the server.");
  const name = f.elements.name.value.trim() || (url ? nameFromAddress(address) : command.split(/\s+/).pop().replace(/[^A-Za-z0-9_-]/g, "-"));
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    $("server-more").open = true;
    throw new Error("A name can only hold letters, digits, - and _.");
  }
  const pairs = readPairs(f.elements.pairs.value);
  return {
    name,
    command: url ? "" : command,
    url: url ? address : "",
    env: url ? {} : pairs,
    headers: url ? pairs : {},
    machines: [...$("server-machines").querySelectorAll("input:checked")].map((c) => c.value),
    allow_private: url && f.elements.allow_private.checked,
  };
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
  renderHealthChecks(data.health_checks);
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
  f.elements.github_via.value = value.github_via || "gh";
  f.elements.gitlab_via.value = value.gitlab_via || "token";
  $("forge-github").querySelector("[name=github_paste]").value = "";
  const names = (data.secrets?.list || []).map((x) => `\${secret:${x.name}}`);
  f.elements.github_token.innerHTML = `<option value="">${names.length ? "Pick a saved secret" : "No saved secrets yet"}</option>${names.map((t) => `<option value="${esc(t)}"${t === value.github_token ? " selected" : ""}>${esc(t)}</option>`).join("")}`;
  renderForges();
  showForgeFields();
  $("pr-save").hidden = true;
  gitlabHosts = (value.gitlab || []).map((g) => ({ host: g.host, url: g.url || "", token: g.token }));
  renderHosts();
  $("pr-github").hidden = value.github_via === "token";
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
    <label>Saved token<select data-key="token">${tokenOptions(g)}</select></label>
    <label class="pr-host-paste">Or paste a token<input type="password" data-key="paste" value="${esc(g.paste || "")}" autocomplete="new-password" placeholder="Saved as a secret" autocapitalize="off" spellcheck="false"></label>
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
    if (form.github_via.value === "token") {
      const { github_problem: problem, github_checked: checked } = data.pull_requests.status;
      if (problem) return { cls: "pr-bad", text: problem };
      return checked ? { cls: "pr-ok", text: "Read with the token, which works." } : { cls: "pr-wait", text: "Read with the token. Not checked yet." };
    }
    const { machines } = data.pull_requests.status;
    if (machines[f.machine]) return { cls: "pr-bad", text: machines[f.machine] };
    return Object.hasOwn(machines, f.machine) ? { cls: "pr-ok", text: "Read with gh, which works." } : { cls: "pr-wait", text: "Read with gh. Not checked yet." };
  }
  if (listed) {
    if (!form.use_gitlab.checked) return { cls: "pr-wait", text: "GitLab is switched off." };
    const { hosts } = data.pull_requests.status;
    if (hosts[f.host]) return { cls: "pr-bad", text: hosts[f.host] };
    const way = form.gitlab_via.value === "glab" ? "glab" : "its token";
    return Object.hasOwn(hosts, f.host) ? { cls: "pr-ok", text: `Read with ${way}, which works.` } : { cls: "pr-wait", text: `Read with ${way}. Not checked yet.` };
  }
  if (f.service === "gitlab_unlisted") return { cls: "pr-bad", text: `Add ${f.host} to see its merge requests.`, add: "Add this host" };
  return { cls: "pr-wait", text: `Yardbell cannot tell what ${f.host} runs. If it is GitLab, add it.`, add: "Add as GitLab" };
}

function renderFolders() {
  const list = $("pr-folders");
  if (!pullFolders) {
    list.innerHTML = `<li class="pr-wait pr-folder-note">Checking your folders...</li>`;
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
  const away = pullFolders.unreachable.map((u) => `<li class="pr-bad pr-folder-note"><strong>${esc(u.machine)}</strong> could not be asked: ${esc(u.why)}</li>`);
  list.innerHTML = [...rows, ...away].join("") || `<li class="pr-wait pr-folder-note">No folders yet.</li>`;
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
  if (pullFoldersAsked || !["#pull-requests", "#connections", "#servers"].includes(location.hash)) return;
  pullFoldersAsked = true;
  loadPullFolders();
}

window.addEventListener("hashchange", pullFoldersWanted);

$("pr-folders-refresh").addEventListener("click", loadPullFolders);

for (const type of ["input", "change"]) {
  $("pr-form").addEventListener(type, () => { $("pr-save").hidden = false; });
}

$("pr-folders").addEventListener("click", (e) => {
  const button = e.target.closest("[data-add-host]");
  if (!button) return;
  gitlabHosts.push({ host: button.dataset.addHost, url: "", token: "" });
  renderHosts();
  openForge("gitlab");
});

let connections = { list: [], status: {}, starters: {} };
let connHeaders = [];
let connWas = "";
let connServer = "";

async function loadConnections() {
  connections = await api("GET", "/api/settings/connectors");
  renderConnections();
}

function renderConnections() {
  showConnectionsEmpty();
  const own = connections.list.filter((c) => !c.server);
  $("conn-rows").hidden = !own.length;
  if (data) renderServers();
  setRows("conn-rows", own.map((c) => {
    const status = connections.status[c.id];
    const state = c.missing.length
      ? badge("warn", "Needs a secret")
      : !c.enabled ? badge("idle", "Switched off")
      : !status ? badge("idle", "Not checked")
      : status.ok ? badge("ok", "Working") : badge("bad", "Failing");
    const detail = c.missing.length
      ? `Save the secret ${c.missing.join(", ")}`
      : c.enabled && status && !status.ok ? status.message : "";
    const items = `${menuItem('data-conn-act="test"', "Test")}${menuItem('data-conn-act="edit"', "Edit")}${menuItem('data-conn-act="share"', "Share")}${menuItem('data-conn-act="delete"', "Delete", true)}`;
    return `<li class="row conn-row" data-conn="${esc(c.id)}">
      <span class="conn-name"><strong>${esc(c.name)}</strong><small>${esc(c.host || "")}</small>${detail ? `<small class="conn-detail">${esc(detail)}</small>` : ""}</span>
      <span class="conn-type">Token</span>
      <span class="conn-status">${state}</span>
      <span class="conn-actions">${rowMenu(c.name, items)}</span>
    </li>`;
  }).join(""));
}

function renderConnHeaders() {
  $("conn-headers").innerHTML = connHeaders.map((h, i) => `<li class="conn-header" data-header="${i}">
    <input data-key="name" aria-label="Header name" placeholder="Authorization" value="${esc(h.name)}" autocapitalize="off" spellcheck="false">
    <input data-key="value" aria-label="Header value" placeholder="Bearer \${secret:my_token}" value="${esc(h.value)}" autocapitalize="off" spellcheck="false">
    <button class="btn quiet danger" type="button" data-header-remove="${i}" aria-label="Remove header" title="Remove header">${CROSS}</button>
  </li>`).join("");
}

function secretLabel(name) {
  const words = name.replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

function renderConnSecrets(c) {
  const missing = c.missing || [];
  $("conn-secrets").innerHTML = missing.map((name) => `<label>${esc(secretLabel(name))}
    <input type="password" placeholder="Paste it here" data-secret="${esc(name)}" autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>`).join("");
  $("conn-secrets").hidden = !missing.length;
}

const CALL_WORDS = {
  list: "Lists items", read: "Reads one item", states: "Lists states", move: "Moves an item",
  comment: "Adds a comment", close: "Closes an item", create: "Creates an item", update: "Updates an item",
};
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
let connCalls = [];
let connChoices = [];
let connOpenCalls = new Set();

const toPairs = (object) => Object.entries(object || {}).map(([key, value]) => ({ key, value }));
const fromPairs = (pairs) => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

function callFromSaved(name, saved) {
  const { request, map, items, kind, tool, arguments: args, ...extra } = saved;
  if (tool) extra.tool = tool;
  if (args !== undefined) extra.arguments = args;
  const method = request?.method || "GET";
  const body = request?.body;
  return {
    name,
    method,
    path: request?.path || "",
    query: toPairs(request?.query),
    body: body === undefined || body === null ? "" : JSON.stringify(body, null, 2),
    items: items || "",
    map: toPairs(map),
    changes: kind ? kind === "change" : method !== "GET",
    extra,
  };
}

function callsToSave() {
  const out = {};
  for (const call of connCalls) {
    const name = call.name.trim();
    if (!name) throw new Error("Every action needs a name.");
    if (!call.path.trim() && !call.extra.tool) throw new Error(`The action ${name} needs a path.`);
    if (Object.hasOwn(out, name)) throw new Error(`There are two actions called ${name}.`);
    if (call.extra.tool) {
      const saved = { ...call.extra, kind: call.changes ? "change" : "lookup" };
      const map = fromPairs(call.map);
      if (Object.keys(map).length) saved.map = map;
      if (call.items.trim()) saved.items = call.items.trim();
      out[name] = saved;
      continue;
    }
    const request = { method: call.method, path: call.path.trim() };
    const query = fromPairs(call.query);
    if (Object.keys(query).length) request.query = query;
    if (call.body.trim() && call.method !== "GET") {
      try {
        request.body = JSON.parse(call.body);
      } catch {
        throw new Error(`The body of ${name} is not valid JSON.`);
      }
    }
    const saved = { ...call.extra, request, kind: call.changes ? "change" : "lookup" };
    const map = fromPairs(call.map);
    if (Object.keys(map).length) saved.map = map;
    if (call.items.trim()) saved.items = call.items.trim();
    out[name] = saved;
  }
  return out;
}

function pairRows(list, kind, keyHint, valueHint) {
  const rows = list.map((p, i) => `<li class="conn-pair" data-pair="${i}">
    <input data-pair-key aria-label="${esc(keyHint)}" placeholder="${esc(keyHint)}" value="${esc(p.key)}" list="conn-reply-fields" autocapitalize="off" spellcheck="false">
    <input data-pair-value aria-label="${esc(valueHint)}" placeholder="${esc(valueHint)}" value="${esc(p.value)}" autocapitalize="off" spellcheck="false">
    <button class="btn quiet danger" type="button" data-pair-remove="${i}" aria-label="Remove" title="Remove">${CROSS}</button>
  </li>`).join("");
  return `<ul class="conn-pairs" data-pairs="${kind}">${rows}</ul><button class="btn small-link" type="button" data-pair-add="${kind}">Add</button>`;
}

function callCard(call, i) {
  const word = CALL_WORDS[call.name] || call.name || "New action";
  const extras = [call.extra.page && "reads page by page", call.extra.before?.length && "asks something first"].filter(Boolean);
  return `<details class="conn-call" data-call="${i}" data-call-name="${esc(call.name)}"${connOpenCalls.has(i) ? " open" : ""}>
    <summary><span class="conn-method">${esc(call.extra.tool ? "TOOL" : call.method)}</span><span class="conn-call-title"><strong>${esc(word)}</strong><small>${esc(call.extra.tool || call.path || "No path yet")}</small></span>${badge(call.changes ? "warn" : "idle", call.changes ? "Changes" : "Reads")}</summary>
    <div class="conn-call-body">
      <label>Name<input data-field="name" value="${esc(call.name)}" placeholder="list" autocapitalize="off" spellcheck="false"></label>
      ${call.extra.tool ? `<p class="help">Calls the tool <code>${esc(call.extra.tool)}</code> with <code>${esc(JSON.stringify(call.extra.arguments || {}))}</code>.</p>` : `<div class="conn-request">
        <label>Method<select data-field="method">${METHODS.map((m) => `<option${m === call.method ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <label>Path<input data-field="path" value="${esc(call.path)}" placeholder="/boards/{{board}}/cards" autocapitalize="off" spellcheck="false"></label>
      </div>
      <p class="help">Values like <code>{{board}}</code> fill in from the run. It is added to the connection's address.</p>
      <div class="conn-sub"><strong>Query</strong>${pairRows(call.query, "query", "Field", "Value")}</div>
      <label class="conn-body-field"${call.method === "GET" ? " hidden" : ""}>Body, as JSON<textarea data-field="body" rows="4" spellcheck="false">${esc(call.body)}</textarea></label>`}
      <label>Where the list is in the reply<input data-field="items" value="${esc(call.items)}" placeholder="Leave empty if the reply is the list" autocapitalize="off" spellcheck="false"></label>
      <div class="conn-sub"><strong>Reply fields to keep</strong><p class="help">The name Yardbell uses, then where it is in the reply. Use <strong>Test</strong> after saving to see the reply's fields.</p>${pairRows(call.map, "map", "item_id", "id")}</div>
      <label class="choice"><input type="checkbox" data-field="changes"${call.changes ? " checked" : ""}>Changes something in the tool, so your Dispatch rules can refuse it</label>
      ${extras.length ? `<p class="help">It also ${esc(extras.join(" and "))}, which stays as it is.</p>` : ""}
      <div class="conn-call-foot"><button class="btn quiet danger small-link" type="button" data-remove-call="${i}">Remove action</button></div>
    </div>
  </details>`;
}

function renderCalls() {
  $("conn-call-list").innerHTML = connCalls.map(callCard).join("") || `<p class="help">No actions yet.</p>`;
}

function renderChoices() {
  $("conn-choice-list").innerHTML = connChoices.map((c, i) => `<li class="conn-choice" data-choice="${i}">
    <input data-key="name" aria-label="Name" placeholder="board" value="${esc(c.name)}" autocapitalize="off" spellcheck="false">
    <input data-key="label" aria-label="Label" placeholder="Board" value="${esc(c.label)}">
    <select data-key="options" aria-label="Options from"><option value="">Typed in</option>${connCalls.filter((x) => x.name).map((x) => `<option value="${esc(x.name)}"${x.name === c.options ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <label class="choice" title="Optional. It narrows which items start a run."><input type="checkbox" data-key="filter"${c.filter ? " checked" : ""}>Filter</label>
    <button class="btn quiet danger" type="button" data-choice-remove="${i}" aria-label="Remove" title="Remove">${CROSS}</button>
  </li>`).join("");
}

function showConnTab(tab) {
  document.querySelectorAll("#conn-more-tabs [data-more]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.more === tab)));
  document.querySelectorAll(".conn-more-tab").forEach((p) => { p.hidden = p.id !== tab; });
}

$("conn-more-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-more]");
  if (tab) showConnTab(tab.dataset.more);
});

$("conn-action-add").addEventListener("click", () => {
  connCalls.push(callFromSaved("", { request: { method: "GET", path: "" } }));
  connOpenCalls.add(connCalls.length - 1);
  renderCalls();
});

$("conn-call-list").addEventListener("toggle", (e) => {
  const card = e.target.closest?.("[data-call]");
  if (!card) return;
  if (card.open) connOpenCalls.add(Number(card.dataset.call));
  else connOpenCalls.delete(Number(card.dataset.call));
}, true);

function editCall(e) {
  const card = e.target.closest("[data-call]");
  if (!card) return;
  const call = connCalls[Number(card.dataset.call)];
  const pairs = e.target.closest("[data-pair]");
  if (pairs) {
    const list = call[pairs.closest("[data-pairs]").dataset.pairs];
    list[Number(pairs.dataset.pair)][e.target.hasAttribute("data-pair-key") ? "key" : "value"] = e.target.value;
    return;
  }
  const field = e.target.dataset.field;
  if (!field) return;
  call[field] = field === "changes" ? e.target.checked : e.target.value;
  if (field === "name") card.dataset.callName = call.name;
  if (field === "method") {
    call.changes = call.method !== "GET";
    card.querySelector(".conn-method").textContent = call.method;
    card.querySelector("[data-field=changes]").checked = call.changes;
    card.querySelector(".conn-body-field").hidden = call.method === "GET";
  }
  if (field === "path") card.querySelector(".conn-call-title small").textContent = call.path || "No path yet";
  if (field === "name") card.querySelector(".conn-call-title strong").textContent = CALL_WORDS[call.name] || call.name || "New action";
  if (field === "method" || field === "changes") {
    card.querySelector(".conn-badge").outerHTML = badge(call.changes ? "warn" : "idle", call.changes ? "Changes" : "Reads");
  }
}
$("conn-call-list").addEventListener("input", editCall);
$("conn-call-list").addEventListener("change", editCall);

$("conn-call-list").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove-call]");
  if (remove) {
    connCalls.splice(Number(remove.dataset.removeCall), 1);
    connOpenCalls = new Set();
    renderCalls();
    return;
  }
  const add = e.target.closest("[data-pair-add]");
  const gone = e.target.closest("[data-pair-remove]");
  if (!add && !gone) return;
  const call = connCalls[Number(e.target.closest("[data-call]").dataset.call)];
  if (add) call[add.dataset.pairAdd].push({ key: "", value: "" });
  else call[gone.closest("[data-pairs]").dataset.pairs].splice(Number(gone.dataset.pairRemove), 1);
  renderCalls();
});

$("conn-choice-add").addEventListener("click", () => {
  connChoices.push({ name: "", label: "", options: "", filter: false });
  renderChoices();
});

$("conn-choice-list").addEventListener("input", (e) => {
  const row = e.target.closest("[data-choice]");
  if (row && e.target.dataset.key) connChoices[Number(row.dataset.choice)][e.target.dataset.key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
});

$("conn-choice-list").addEventListener("click", (e) => {
  const button = e.target.closest("[data-choice-remove]");
  if (!button) return;
  connChoices.splice(Number(button.dataset.choiceRemove), 1);
  renderChoices();
});

function openConnection(c, was) {
  connWas = was;
  connServer = c.server || "";
  const f = $("conn-form");
  f.querySelector("[name=base_url]").closest("label").hidden = Boolean(connServer);
  $("conn-output").hidden = true;
  for (const key of ["name", "id", "base_url"]) f.elements[key].value = c[key] || "";
  const known = Object.keys(CALL_WORDS);
  const rank = (name) => (known.includes(name) ? known.indexOf(name) : known.length);
  connCalls = Object.entries(c.calls || {})
    .map(([name, saved]) => callFromSaved(name, saved))
    .sort((a, b) => rank(a.name) - rank(b.name));
  connChoices = (c.params || []).map((p) => ({ name: p.name, label: p.label || "", options: p.options || "", filter: !!p.filter }));
  connOpenCalls = new Set();
  renderCalls();
  renderChoices();
  showConnTab("conn-actions");
  f.elements.enabled.checked = c.enabled !== false;
  f.elements.allow_private.checked = !!c.allow_private;
  connHeaders = Object.entries(c.headers || {}).map(([name, value]) => ({ name, value }));
  renderConnHeaders();
  const blank = !Object.keys(c.calls || {}).length;
  $("conn-about").textContent = was ? "" : c.missing?.length
    ? `${c.about || ""} Create what it asks for in ${c.name}, then paste it here. Yardbell keeps it in secrets and never shows it again.`
    : blank ? "Describe the tool's API under More options." : c.about || "";
  $("conn-about").hidden = !$("conn-about").textContent;
  renderConnSecrets(c);
  $("conn-more").open = blank;
  $("conn-note").textContent = "";
  showStep("conn-form", was ? `Edit ${c.name}` : c.name ? `Connect ${c.name}` : "");
  focusIfActive(c.missing?.length ? $("conn-secrets").querySelector("input") : f.elements.name);
}

function showConnOutput(html, title) {
  showStep("conn-output", title);
  $("conn-output").innerHTML = `${html}<div class="form-foot"><button class="btn primary" type="button" data-close-output>Done</button></div>`;
}

$("conn-output").addEventListener("click", (e) => {
  if (e.target.closest("[data-close-output]")) closeFlow();
});

const brandMark = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const CONN_LOGOS = {
  linear: brandMark("M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"),
  notion: brandMark("M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"),
  slack: brandMark("M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"),
  clickup: brandMark("M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z"),
  sentry: brandMark("M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"),
  datadog: brandMark("M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749"),
  pagerduty: brandMark("M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37 1.975-1.303 3.004-3.484 3.004-6.007 0-2.716-1.262-4.896-3.305-5.994zm-5.5 10.326h-4.21V3.113l3.977-.027c3.62-.028 5.43 1.234 5.43 4.128 0 3.113-2.248 4.292-5.197 4.292zM3.73 17.61h3.525V24H3.73Z"),
  posthog: brandMark("M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z"),
  vercel: brandMark("M24 22.525H0l12-21.05 12 21.05z"),
  supabase: brandMark("M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"),
  stripe: brandMark("M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"),
  figma: brandMark("M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z"),
  hubspot: brandMark("M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z"),
  intercom: brandMark("M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z"),
  airtable: brandMark("M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z"),
  zapier: brandMark("M4.157 0A4.151 4.151 0 0 0 0 4.161v15.678A4.151 4.151 0 0 0 4.157 24h15.682A4.152 4.152 0 0 0 24 19.839V4.161A4.152 4.152 0 0 0 19.839 0H4.157Zm10.61 8.761h.03a.577.577 0 0 1 .23.038.585.585 0 0 1 .201.124.63.63 0 0 1 .162.431.612.612 0 0 1-.162.435.58.58 0 0 1-.201.128.58.58 0 0 1-.23.042.529.529 0 0 1-.235-.042.585.585 0 0 1-.332-.328.559.559 0 0 1-.038-.235.613.613 0 0 1 .17-.431.59.59 0 0 1 .405-.162Zm2.853 1.572c.03.004.061.004.095.004.325-.011.646.064.937.219.238.144.431.355.552.609.128.279.189.582.185.888v.193a2 2 0 0 1 0 .219h-2.498c.003.227.075.45.204.642a.78.78 0 0 0 .646.265.714.714 0 0 0 .484-.136.642.642 0 0 0 .23-.318l.915.257a1.398 1.398 0 0 1-.28.537c-.14.159-.321.284-.521.355a2.234 2.234 0 0 1-.836.136 1.923 1.923 0 0 1-1.001-.245 1.618 1.618 0 0 1-.665-.703 2.221 2.221 0 0 1-.227-1.036 1.95 1.95 0 0 1 .48-1.398 1.9 1.9 0 0 1 1.3-.488Zm-9.607.023c.162.004.325.026.48.079.207.065.4.174.563.314.26.302.393.692.366 1.088v2.276H8.53l-.109-.711h-.065c-.064.163-.155.31-.272.439a1.122 1.122 0 0 1-.374.264 1.023 1.023 0 0 1-.453.083 1.334 1.334 0 0 1-.866-.264.965.965 0 0 1-.329-.801.993.993 0 0 1 .076-.431 1.02 1.02 0 0 1 .242-.363 1.478 1.478 0 0 1 1.043-.303h.952v-.181a.696.696 0 0 0-.136-.454.553.553 0 0 0-.438-.154.695.695 0 0 0-.378.086.48.48 0 0 0-.193.254l-.99-.144a1.26 1.26 0 0 1 .257-.563c.14-.174.321-.302.533-.378.261-.091.54-.136.82-.129.053-.003.106-.007.163-.007Zm4.384.007c.174 0 .347.038.506.114.182.083.34.211.458.374.257.423.377.911.351 1.406a2.53 2.53 0 0 1-.355 1.448 1.148 1.148 0 0 1-1.009.517c-.204 0-.401-.045-.582-.136a1.052 1.052 0 0 1-.48-.457 1.298 1.298 0 0 1-.114-.234h-.045l.004 1.784h-1.059v-4.713h.904l.117.805h.057c.068-.208.177-.401.328-.56a1.129 1.129 0 0 1 .843-.344h.076v-.004Zm7.559.084h.903l.113.805h.053a1.37 1.37 0 0 1 .235-.484.813.813 0 0 1 .313-.242.82.82 0 0 1 .39-.076h.234v1.051h-.401a.662.662 0 0 0-.313.008.623.623 0 0 0-.272.155.663.663 0 0 0-.174.26.683.683 0 0 0-.027.314v1.875h-1.054v-3.666Zm-17.515.003h3.262v.896L3.73 13.104l.034.113h1.973l.042.9H2.4v-.9l1.931-1.754-.045-.117H2.441v-.896Zm11.815 0h1.055v3.659h-1.055V10.45Zm3.443.684.019.016a.69.69 0 0 0-.351.045.756.756 0 0 0-.287.204c-.11.155-.174.336-.189.522h1.545c-.034-.526-.257-.787-.74-.787h.003Zm-5.718.163c-.026 0-.057 0-.083.004a.78.78 0 0 0-.31.053.746.746 0 0 0-.257.189 1.016 1.016 0 0 0-.204.695v.064c-.015.257.057.507.204.711a.634.634 0 0 0 .253.196.638.638 0 0 0 .314.061.644.644 0 0 0 .578-.265c.14-.223.204-.48.189-.74a1.216 1.216 0 0 0-.181-.711.677.677 0 0 0-.503-.257Zm-4.509 1.266a.464.464 0 0 0-.268.102.373.373 0 0 0-.114.276c0 .053.008.106.027.155a.375.375 0 0 0 .087.132.576.576 0 0 0 .397.11v.004a.863.863 0 0 0 .563-.182.573.573 0 0 0 .211-.457v-.14h-.903Z"),
  dropbox: brandMark("M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z"),
  trello: brandMark("M21.147 0H2.853A2.86 2.86 0 000 2.853v18.294A2.86 2.86 0 002.853 24h18.294A2.86 2.86 0 0024 21.147V2.853A2.86 2.86 0 0021.147 0zM10.34 17.287a.953.953 0 01-.953.953h-4a.954.954 0 01-.954-.953V5.38a.953.953 0 01.954-.953h4a.954.954 0 01.953.953zm9.233-5.467a.944.944 0 01-.953.947h-4a.947.947 0 01-.953-.947V5.38a.953.953 0 01.953-.953h4a.954.954 0 01.953.953z"),
  github: brandMark("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"),
  gitlab: brandMark("m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"),
  jira: brandMark("M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"),
  asana: brandMark("M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z"),
  "": `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
};

function pickTile(logo, attrs, title, about, action, connected) {
  const mark = CONN_LOGOS[logo] ?? esc(title.charAt(0));
  return `<li class="conn-card" ${attrs}><span class="conn-logo">${mark}</span><span class="conn-starter-text"><strong>${esc(title)}</strong><small>${esc(about)}</small></span>${connected ? badge("ok", "Connected") : `<button class="btn small-link" type="button">${esc(action)}</button>`}</li>`;
}

function openPicker(step = "conn-new-panel") {
  $("conn-sign-in-search").value = "";
  $("conn-sign-in-none").hidden = true;
  const signedIn = (t) => {
    const have = (data.mcp_servers || []).find((s) => s.url === t.url);
    if (!have || data.mcp_auth?.[have.name] !== "signed_in") return false;
    return !t.template || connections.list.some((c) => c.server === have.name);
  };
  $("conn-sign-in-list").innerHTML = [
    ...(connections.sign_in || []).map((t) => pickTile(t.id, signedIn(t) ? "" : `data-sign-in="${esc(t.id)}"`, t.name, t.needs_client ? `${t.about} Needs an app you make in its developer console.` : t.about, "Connect", signedIn(t))),
  ].join("");
  $("conn-new-list").innerHTML = [
    ...connections.templates.map((name) => {
      const c = connections.starters[name];
      return pickTile(name, `data-starter="${esc(name)}"`, c.name, c.about, "Set up");
    }),
    pickTile("", 'data-starter=""', "Start blank", "Any tool with a web API.", "Set up"),
  ].join("");
  flowAdding = true;
  if (step === "server-form") openServerForm(null);
  else showStep(step);
}

$("conn-new").addEventListener("click", () => openPicker());

$("conn-sign-in-search").addEventListener("input", (e) => {
  const want = e.target.value.trim().toLowerCase();
  let shown = 0;
  $("conn-sign-in-list").querySelectorAll(".conn-card").forEach((tile) => {
    tile.hidden = !tile.textContent.toLowerCase().includes(want);
    if (!tile.hidden) shown += 1;
  });
  $("conn-sign-in-none").hidden = shown > 0;
});

async function connectByTool(tool) {
  const run = flowRun;
  const out = await api("POST", "/api/settings/connectors/connect", { template: tool.id });
  await load();
  await loadConnections();
  if (run !== flowRun) return;
  if (out.signed_in) await showConnected(out.server);
  else await startSignIn(out.server);
}

$("conn-new-panel").addEventListener("click", (e) => {
  if (e.target.closest("[data-another]")) openPicker("server-form");
});

$("conn-sign-in-list").addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-sign-in]");
  if (!pick) return;
  try {
    await connectByTool(connections.sign_in.find((t) => t.id === pick.dataset.signIn));
  } catch (err) {
    tellFlow(err.message);
  }
});

$("conn-new-list").addEventListener("click", (e) => {
  const button = e.target.closest("[data-starter]");
  if (!button) return;
  const name = button.dataset.starter;
  openConnection(name ? connections.starters[name] : { enabled: true, headers: {} }, "");
});
$("conn-cancel").addEventListener("click", closeFlow);
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
function freeConnectionId(wanted) {
  if (connWas || !connections.list.some((c) => c.id === wanted)) return wanted;
  const base = `${wanted}-token`;
  let id = base;
  for (let n = 2; connections.list.some((c) => c.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

function slugOf(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

$("conn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.elements.name.value.trim();
  let calls;
  try {
    calls = callsToSave();
  } catch (err) {
    $("conn-more").open = true;
    showConnTab("conn-actions");
    $("conn-note").textContent = err.message;
    return;
  }
  const choices = connChoices.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), label: c.label, ...(c.options ? { options: c.options } : {}), ...(c.filter ? { filter: true } : {}) }));
  const body = {
    was: connWas,
    id: freeConnectionId(f.elements.id.value.trim() || slugOf(name)),
    name,
    base_url: connServer ? "" : f.elements.base_url.value.trim(),
    server: connServer,
    enabled: f.elements.enabled.checked,
    allow_private: f.elements.allow_private.checked,
    headers: Object.fromEntries(connHeaders.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value.trim()])),
    params_yaml: choices.length ? JSON.stringify(choices) : "",
    calls_yaml: JSON.stringify(calls),
  };
  try {
    if (!body.base_url && !connServer) throw new Error("Type the tool's address, starting with https://");
    body.headers = await tokensKept(body.headers, body.id);
    connHeaders = toPairs(body.headers).map(({ key, value }) => ({ name: key, value }));
    renderConnHeaders();
    await api("POST", "/api/settings/connectors", body);
    const typed = [...$("conn-secrets").querySelectorAll("input")].filter((i) => i.value);
    for (const input of typed) await api("POST", "/api/settings/secrets", { name: input.dataset.secret, value: input.value });
    typed.forEach((i) => { i.value = ""; });
    saved(`${body.name || body.id} saved.`);
    closeFlow();
    await load();
    const left = connections.list.find((c) => c.id === body.id);
    if (typed.length && left && !left.missing.length && left.enabled) {
      api("POST", `/api/settings/connectors/${encodeURIComponent(body.id)}/test`, {}).catch(() => {}).then(loadConnections).catch(() => {});
    }
  } catch (err) {
    $("conn-note").textContent = err.message;
    if (/call|param|header/i.test(err.message)) $("conn-more").open = true;
  }
});
$("conn-import-open").addEventListener("click", () => {
  $("conn-output").hidden = true;
  showStep("conn-import", "Paste a shared connection");
  focusIfActive($("conn-import").elements.text);
});
$("conn-import-cancel").addEventListener("click", closeFlow);
$("conn-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const out = await api("POST", "/api/settings/connectors/import", { text: e.target.elements.text.value });
    e.target.elements.text.value = "";
    saved(`${out.id} imported, switched off.`);
    closeFlow();
    await load();
    const needs = out.secrets.length ? ` It needs the secret ${out.secrets.join(", ")}.` : "";
    showConnOutput(`<p>${esc(out.id)} can reach <strong>${esc(out.host || "")}</strong>.${esc(needs)} Read its calls, then switch it on with <strong>Edit</strong>.</p>`, `${out.id} imported`);
  } catch (err) {
    toast(err.message);
  }
});
$("conn-rows").addEventListener("click", async (e) => {
  if (!e.target.closest("button")) {
    const row = e.target.closest("[data-conn]");
    if (row) openConnection(connections.list.find((x) => x.id === row.dataset.conn), row.dataset.conn);
    return;
  }
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
      showConnOutput(`<p class="help">This holds no secret values, only their names.</p><textarea id="conn-share-text" rows="12" readonly spellcheck="false">${esc(text)}</textarea>`, `Share ${c.name}`);
    }
    if (button.dataset.connAct === "test") {
      showConnOutput(`<p class="help" role="status">Reading ${esc(c.name)}...</p>`, `Test ${c.name}`);
      const out = await api("POST", `${at}/test`, {});
      const items = out.items.map((i) => `<li><strong>${esc(i.id)}</strong> ${esc(i.title)} <small>${esc(i.state)}</small></li>`).join("");
      const skipped = out.skipped.map((s) => `<li class="pr-bad">Skipped: ${esc(s)}</li>`).join("");
      showConnOutput(`<p><strong>${out.count} items.</strong>${out.cut_off ? ` <span class="pr-bad">${esc(out.cut_off)}</span>` : ""}</p>
        <ul class="conn-items">${skipped}${items}</ul>
        <p class="pl-field-head">Fields you can map</p>
        <p class="conn-paths">${out.paths.map((p) => `<code>${esc(p)}</code>`).join(" ")}</p>`, `Test ${c.name}`);
      await loadConnections();
    }
  } catch (err) {
    showConnOutput(`<p class="pr-bad">${esc(err.message)}</p>`, c.name);
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
    github_via: f.elements.github_via.value,
    github_token: f.elements.github_token.value,
    gitlab_via: f.elements.gitlab_via.value,
    gitlab: gitlabHosts.map((g) => ({ host: g.host.trim(), ...(g.url.trim() ? { url: g.url.trim() } : {}), token: g.token })),
  };
  const paste = $("forge-github").querySelector("[name=github_paste]");
  try {
    for (const [i, g] of gitlabHosts.entries()) {
      if (!g.paste?.trim()) continue;
      body.gitlab[i].token = await keptAsSecret(`gitlab_${g.host.trim()}`, g.paste.trim());
      g.paste = "";
    }
    if (paste.value.trim()) {
      await api("POST", "/api/settings/secrets", { name: "github_pr", value: paste.value.trim() });
      body.github_token = "${secret:github_pr}";
    }
    await api("POST", "/api/settings/pull-requests", body);
    paste.value = "";
    saved("GitHub and GitLab updated.");
    closeFlow();
    await load();
    loadPullFolders();
  } catch (err) {
    tellFlow(err.message);
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

$("health-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {};
  for (const name of HEALTH_CHECKS) {
    body[name] = f.elements[name].checked;
    body[`${name}_minutes`] = Number(f.elements[`${name}_minutes`].value.trim());
  }
  const button = f.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("POST", "/api/settings/health", body);
    saved("Health checks updated.");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
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

$("server-cancel").addEventListener("click", closeFlow);
$("conn-back").addEventListener("click", () => {
  const from = flowStep;
  stopWaiting();
  signingIn = null;
  openPicker(from === "conn-form" || from === "conn-import" ? "conn-tab-token" : "conn-new-panel");
});
$("conn-close").addEventListener("click", closeFlow);
$("conn-flow").addEventListener("close", () => {
  if (!$("conn-flow").open) closeFlow();
});
$("conn-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) openPicker(tab.dataset.tab);
});
$("conn-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const at = FLOW_TABS.indexOf(flowStep);
  const next = FLOW_TABS[(at + (e.key === "ArrowRight" ? 1 : 2)) % 3];
  openPicker(next);
  $("conn-tabs").querySelector(`[data-tab="${next}"]`).focus();
});
$("server-form").elements.kind.addEventListener("change", (e) => showKind(e.target.value));

$("mcp-sign-in").addEventListener("click", async (e) => {
  const panel = $("mcp-sign-in");
  const name = signingIn;
  if (e.target.closest("[data-cancel]")) { closeFlow(); return; }
  if (e.target.closest("[data-continue]")) {
    if (signsInHere()) {
      panel.innerHTML = `<p role="status">Finish signing in on the page that opened. This page moves on by itself.</p>
        <div class="form-foot"><button class="btn quiet" type="button" data-cancel>Cancel</button></div>`;
    }
    refreshOnReturn = true;
    waitForSignIn();
    return;
  }
  try {
    if (e.target.closest("[data-client]")) {
      const field = (key) => panel.querySelector(`[name=${key}]`).value;
      await startSignIn(name, { client_id: field("client_id"), client_secret: field("client_secret") });
    } else if (e.target.closest("[data-finish]")) {
      await api("POST", serverPath(name, "finish"), { address: panel.querySelector("[name=address]").value });
      await showConnected(name);
    }
  } catch (err) {
    tellFlow(err.message);
  }
});

$("mcp-tools").addEventListener("click", (e) => {
  if (e.target.closest("[data-close-tools]")) closeFlow();
});

window.addEventListener("focus", () => {
  if (waiting) checkSignedIn().catch((err) => toast(err.message));
  else if (refreshOnReturn) refreshServerAuth().catch(() => {});
});

$("forge-rows").addEventListener("click", (e) => {
  const row = e.target.closest("[data-forge]");
  if (row) openForge(row.dataset.forge);
});

$("conn-flow").addEventListener("click", (e) => {
  if (!e.target.closest("[data-cancel-forge]")) return;
  closeFlow();
  renderPullRequests();
});

$("forge-linear").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = e.target.elements.linear_key;
  try {
    await api("POST", "/api/settings/secrets", { name: "linear", value: key.value.trim() });
    key.value = "";
    closeFlow();
    await load();
  } catch (err) {
    tellFlow(err.message);
  }
});

$("conn-flow").addEventListener("change", (e) => {
  if (["use_github", "use_gitlab", "gitlab_via"].includes(e.target.name)) renderFolders();
  if (["github_via", "gitlab_via"].includes(e.target.name)) showForgeFields();
});

$("server-rows").addEventListener("click", async (e) => {
  if (!e.target.closest("button")) {
    const row = e.target.closest("[data-server]");
    if (row) openServerForm(Number(row.dataset.server));
    return;
  }
  const linked = e.target.closest("[data-conn-edit]");
  if (linked) {
    openConnection(connections.list.find((c) => c.id === linked.dataset.connEdit), linked.dataset.connEdit);
    $("conn-more").open = true;
    return;
  }
  const act = e.target.closest("[data-mcp-act]");
  if (act) {
    const name = act.dataset.name;
    act.disabled = true;
    try {
      if (act.dataset.mcpAct === "sign-in") await startSignIn(name);
      if (act.dataset.mcpAct === "test") showTools(name, await api("POST", serverPath(name, "test")));
      if (act.dataset.mcpAct === "sign-out") {
        await api("POST", serverPath(name, "sign-out"));
        saved(`Signed out of ${name}.`);
        await refreshServerAuth();
      }
    } catch (err) {
      toast(err.message);
    } finally {
      act.disabled = false;
    }
    return;
  }
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
  const adding = editing === null;
  const run = flowRun;
  try {
    const srv = serverOf(f);
    srv.headers = await tokensKept(srv.headers, srv.name);
    srv.env = await tokensKept(srv.env, srv.name);
    const token = f.elements.token.value.trim();
    if (srv.url && token) srv.headers.Authorization = `Bearer ${await keptAsSecret(`${srv.name}_token`, token)}`;
    f.elements.token.value = "";
    f.elements.pairs.value = "";
    const servers = [...(data.mcp_servers || [])];
    if (adding) servers.push(srv); else servers[editing] = srv;
    await saveServers(servers, `${srv.name} saved.`);
    if (run !== flowRun) return;
    if (!adding) { closeFlow(); return; }
    if (srv.url && !Object.keys(srv.headers).length) await startSignIn(srv.name);
    else await showConnected(srv.name);
  } catch (err) {
    $("server-note").textContent = err.message;
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
$("secret-cancel").addEventListener("click", () => { $("secret-form").reset(); closeFlow(); });

$("secret-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.elements.name.value.trim();
  const button = f.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("POST", "/api/settings/secrets", { name, value: f.elements.value.value });
    f.reset();
    closeFlow();
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
  const text = users.length
    ? `${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it, and will stop working until you set it again.`
    : "Nothing uses it. The value cannot be brought back.";
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

let setupsAdded = false;

async function loadSetups() {
  try {
    const res = await api("GET", "/api/settings/worktree-setup");
    if (setupsAdded) return;
    setups = (res.setups || []).map((x) => ({ machine: "any", timeout_seconds: 300, ...x }));
  } catch {
    setups = [];
  }
  renderSetups();
}

$("setup-add").addEventListener("click", () => {
  setupsAdded = true;
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
    setupsAdded = false;
    await loadSetups();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});
