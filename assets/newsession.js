(function () {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (path) => String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const nm = { machine: "", listing: null, branches: null, picked: "", opts: null, installed: null, allAgents: false };
  const MORE = "__more";
  const ADD = "__add";
  let $ = null;

  const mac = /Mac/.test(navigator.platform);
  const svg = (body) => `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const ICON = {
    folder: svg('<path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/>'),
    machine: svg('<rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/>'),
    updown: '<svg class="icon nd-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 6 2.5-2.5L10.5 6M5.5 10l2.5 2.5 2.5-2.5"/></svg>',
    here: svg('<circle cx="8" cy="8" r="2"/><path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14"/>'),
    branch: svg('<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5c0 2-3 2-5.5 3"/>'),
    name: svg('<path d="M3.5 4V3h9v1M8 3v10M6 13h4"/>'),
    agent: svg('<path d="M3 4.5 6.5 8 3 11.5M8 11.5h5"/>'),
    claude: '<svg class="icon nd-claude" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2M5.5 2.1l5 11.8M10.5 2.1l-5 11.8M2.1 5.5l11.8 5M13.9 5.5l-11.8 5"/></svg>',
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
    close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    down: '<svg class="icon nd-adv-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>',
  };

  const MARKUP = `<dialog id="new-dialog" class="wide nd" aria-labelledby="new-title">
  <form method="dialog" id="new-form">
    <div class="dialog-head">
      <h2 id="new-title">New session</h2>
      <button class="btn quiet icon-btn nd-close" value="cancel" formnovalidate aria-label="Close" title="Close">${ICON.close}</button>
    </div>

    <div class="nd-body">
      <section class="step grid2 nd-pair">
        <div class="nd-field">
          <span class="nd-label" id="nd-project-label">Project</span>
          <button type="button" class="nd-select" id="nd-project" aria-labelledby="nd-project-label nd-project-name" aria-expanded="true" aria-controls="nd-browser">${ICON.folder}<span class="nd-select-text" id="nd-project-name">Home</span>${ICON.updown}</button>
        </div>
        <label class="nd-field"><span class="nd-label">Run on</span>
          <span class="nd-select-wrap">${ICON.machine}<select name="machine" id="new-machine"></select>${ICON.updown}</span></label>
      </section>

      <section class="step nd-browser" id="nd-browser" aria-label="Folder">
        <div id="recent" class="recent"></div>
        <nav id="crumbs" class="crumbs" aria-label="Folder path"></nav>
        <p id="wt-here" class="wt-here" hidden></p>
        <ul id="dir-list" class="dir-list" aria-label="Folders"></ul>
      </section>

      <section class="step nd-from" id="branch-step" hidden>
        <span class="nd-label" id="nd-from-label">Create from <span class="nd-opt">[Optional]</span></span>
        <div class="nd-tabs" role="radiogroup" aria-labelledby="nd-from-label">
          <label class="nd-tab choice"><input type="radio" name="mode" value="stay" checked>${ICON.here}<span>Current</span></label>
          <label class="nd-tab choice"><input type="radio" name="mode" value="existing">${ICON.branch}<span>Branch</span></label>
          <label class="nd-tab choice"><input type="radio" name="mode" value="new">${ICON.name}<span>Name</span></label>
        </div>
        <p class="nd-stay" id="stay-body">Stays on <b id="current-branch"></b> in this folder.</p>
        <div class="choice-body nd-existing" id="existing-body" hidden>
          <span class="nd-search">${ICON.search}<input type="text" id="branch-filter" placeholder="Filter branches" aria-label="Filter branches" autocomplete="off" autocapitalize="off"></span>
          <ul id="branch-list" class="branch-list" role="listbox" aria-label="Branches"></ul>
        </div>
        <div class="choice-body grid2 nd-newbranch" id="new-body" hidden>
          <label>Name <input type="text" id="new-branch" placeholder="eng-1234-short-description" autocomplete="off" autocapitalize="off"></label>
          <label>From <select id="new-base"></select></label>
        </div>
      </section>

      <section class="step nd-agent">
        <label class="nd-field"><span class="nd-label">Agent <span class="nd-opt">[Optional]</span></span>
          <span class="nd-select-wrap">${ICON.agent}<select name="agent" id="new-agent"></select>${ICON.updown}</span></label>
      </section>

      <section class="step" id="agent-add" hidden>
        <h3 class="step-title">Add an agent</h3>
        <div class="grid2">
          <label>Name <input type="text" id="agent-label" placeholder="Amp" autocomplete="off"></label>
          <label>Command <input type="text" id="agent-command" placeholder="amp" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        </div>
        <label>Command to continue the last conversation (optional) <input type="text" id="agent-resume" placeholder="amp threads continue" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <p class="help">Saved in Yardbell's settings and offered on every machine where the command is installed.</p>
        <div class="row-actions">
          <button class="btn" type="button" id="agent-cancel">Cancel</button>
          <button class="btn primary" type="button" id="agent-save">Add agent</button>
        </div>
      </section>

      <details class="step nd-advanced" id="nd-advanced">
        <summary>Advanced${ICON.down}</summary>
        <label class="switch-row">
          <span class="switch-text">
            <span class="switch-title">Continue the last conversation</span>
            <span class="switch-hint">Starts the agent with its resume command in this folder.</span>
          </span>
          <input type="checkbox" class="switch" name="resume">
        </label>
      </details>
    </div>

    <div class="dialog-foot">
      <p class="where" id="where"></p>
      <button class="btn primary nd-start" value="start" id="start-btn">Start session <kbd class="nd-key" aria-hidden="true">${mac ? "⌘↵" : "Ctrl ↵"}</kbd></button>
    </div>
  </form>
</dialog>`;

  function remembered(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("Log in again");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function fail(message) {
    nm.opts?.onError?.(message);
  }

  function renderAgents() {
    const select = $("new-agent");
    const agents = nm.opts.agents;
    const known = nm.installed;
    const missing = known ? agents.filter((a) => !known.includes(a.name)) : [];
    const shown = known && !nm.allAgents && missing.length < agents.length
      ? agents.filter((a) => known.includes(a.name))
      : agents;
    const current = select.value && select.value !== MORE && select.value !== ADD ? select.value : remembered("agent");
    const pick = [current, nm.opts.defaultAgent].find((name) => shown.some((a) => a.name === name)) || shown[0]?.name;
    const where = esc(nm.machine);
    select.innerHTML = shown.map((a) => {
      const absent = known && !known.includes(a.name) ? ` (not found on ${where})` : "";
      return `<option value="${esc(a.name)}"${a.name === pick ? " selected" : ""}>${esc(a.label)}${absent}</option>`;
    }).join("") + (shown.length < agents.length ? `<option value="${MORE}">Other agent…</option>` : `<option value="${ADD}">Add an agent…</option>`);
    paintAgent();
  }

  function paintAgent() {
    const select = $("new-agent");
    const claude = /claude/i.test(select.value) || /claude/i.test(select.selectedOptions[0]?.textContent || "");
    select.previousElementSibling.outerHTML = claude ? ICON.claude : ICON.agent;
  }

  function showAddAgent(open) {
    $("agent-add").hidden = !open;
    if (!open) return;
    for (const id of ["agent-label", "agent-command", "agent-resume"]) $(id).value = "";
    $("agent-label").focus();
  }

  async function addAgent() {
    const button = $("agent-save");
    button.disabled = true;
    try {
      const added = await api("POST", "/api/settings/agents", {
        label: $("agent-label").value,
        command: $("agent-command").value,
        resume: $("agent-resume").value,
      });
      nm.opts.agents = [...nm.opts.agents, added];
      remember("agent", added.name);
      showAddAgent(false);
      $("new-agent").value = "";
      await loadAgents();
      nm.allAgents = !nm.installed?.includes(added.name);
      renderAgents();
      $("new-agent").value = added.name;
    } catch (err) {
      fail(err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function loadAgents() {
    const machine = nm.machine;
    nm.installed = null;
    nm.allAgents = false;
    renderAgents();
    try {
      const res = await api("GET", `/machines/${encodeURIComponent(machine)}/agents`);
      if (machine !== nm.machine) return;
      nm.installed = res.installed;
      renderAgents();
    } catch {}
  }

  function folderIcon(git) {
    return git
      ? '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5c0 2-3 2-5.5 3"/></svg>'
      : '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/></svg>';
  }

  async function browseTo(path) {
    $("dir-list").innerHTML = `<li class="dir-empty">Loading…</li>`;
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : "";
      const l = await api("GET", `/machines/${encodeURIComponent(nm.machine)}/browse${q}`);
      nm.listing = l;
      renderBrowser(l);
      await loadBranches();
    } catch (err) {
      $("dir-list").innerHTML = `<li class="dir-empty error">${esc(err.message)}</li>`;
    }
  }

  function tail(path) {
    const parts = short(path).split("/").filter((p) => p && p !== "~");
    return parts.length ? parts.slice(-2).join("/") : short(path);
  }

  function renderRecent(recent) {
    $("recent").innerHTML = recent.length
      ? `<span class="recent-label">Recent</span>` + recent.map((p) => `<span class="recent-chip">
          <button type="button" class="recent-go" data-path="${esc(p)}" title="${esc(short(p))}">${esc(tail(p))}</button>
          <button type="button" class="recent-x" data-forget="${esc(p)}" aria-label="Remove ${esc(tail(p))} from Recent" title="Remove from Recent">
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>
          </button>
        </span>`).join("")
      : "";
  }

  async function forgetRecent(path) {
    try {
      const res = await api("POST", `/machines/${encodeURIComponent(nm.machine)}/recent/forget`, { path });
      if (nm.listing) nm.listing.recent = res.recent;
      renderRecent(res.recent);
    } catch (err) {
      fail(err.message);
    }
  }

  function renderBrowser(l) {
    renderRecent(l.recent);
    const parts = l.path.split("/").filter(Boolean);
    const crumbs = [`<button type="button" class="crumb home" data-path="~">Home</button><span class="crumb-divider"></span>`, `<button type="button" class="crumb" data-path="/">/</button>`];
    parts.forEach((p, i) => crumbs.push(`${i ? `<span class="sep">/</span>` : ""}<button type="button" class="crumb${i === parts.length - 1 ? " here" : ""}" data-path="/${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`));
    $("crumbs").innerHTML = crumbs.join("");
    $("nd-project-name").textContent = short(l.path) === "~" ? "Home" : tail(l.path);
    $("nd-project").title = short(l.path);
    $("wt-here").hidden = !l.linked;
    $("wt-here").innerHTML = l.linked
      ? `<span>This folder is a worktree${l.branch ? ` on <code>${esc(l.branch)}</code>` : ""}.</span><button type="button" class="btn quiet danger" data-remove-wt="${esc(l.path)}">Remove worktree</button>`
      : "";
    const up = parts.length ? `<li><button type="button" class="dir" data-path="/${esc(parts.slice(0, -1).join("/"))}"><span class="dir-name">..</span></button></li>` : "";
    $("dir-list").innerHTML = up + (l.entries.length
      ? l.entries.map((e) => `<li><button type="button" class="dir${e.git ? " git" : ""}" data-path="${esc(`${l.path.replace(/\/$/, "")}/${e.name}`)}">
          ${folderIcon(e.git)}<span class="dir-name">${esc(e.name)}</span>${e.git && e.branch ? `<span class="dir-branch">${esc(e.branch)}</span>` : ""}
        </button></li>`).join("")
      : `<li class="dir-empty">No subfolders</li>`);
    updateWhere();
  }

  async function loadBranches() {
    const l = nm.listing;
    nm.branches = null;
    nm.picked = "";
    $("branch-step").hidden = !l?.git;
    if (!l?.git) { updateWhere(); return; }
    $("current-branch").textContent = l.branch || "detached HEAD";
    setMode("stay");
    try {
      nm.branches = await api("GET", `/machines/${encodeURIComponent(nm.machine)}/branches?path=${encodeURIComponent(l.path)}`);
      const bases = [nm.branches.default_base, ...nm.branches.local, ...nm.branches.remote.map((r) => `origin/${r}`)].filter((v, i, a) => v && a.indexOf(v) === i);
      $("new-base").innerHTML = bases.map((b) => `<option>${esc(b)}</option>`).join("");
      renderBranchList();
    } catch (err) {
      fail(`Could not read branches: ${err.message}`);
    }
  }

  function renderBranchList() {
    const b = nm.branches;
    if (!b) return;
    const f = $("branch-filter").value.trim().toLowerCase();
    const names = [...b.local, ...b.remote].filter((n) => n !== b.current && (!f || n.toLowerCase().includes(f)));
    $("branch-list").innerHTML = names.length
      ? names.slice(0, 40).map((n) => {
          const wt = b.worktrees[n];
          const note = wt ? "has a worktree" : b.local.includes(n) ? "local" : "origin";
          const remove = wt ? `<button type="button" class="btn quiet danger dir-remove" data-remove-wt="${esc(wt)}" aria-label="Remove the worktree of ${esc(n)}" title="Remove the worktree at ${esc(short(wt))}">Remove</button>` : "";
          return `<li${wt ? ' class="has-worktree"' : ""}><button type="button" class="branch-opt${nm.picked === n ? " picked" : ""}" role="option" aria-selected="${nm.picked === n}" data-branch="${esc(n)}">
            <span class="dir-name">${esc(n)}</span><span class="dir-branch">${note}</span></button>${remove}</li>`;
        }).join("")
      : `<li class="dir-empty">No matching branches</li>`;
  }

  function removeWorktree(path) {
    const here = nm.listing?.path === path;
    window.YardbellWorktree.remove({
      machine: nm.machine,
      path,
      toast: (message, kind) => (nm.opts.onNotice || nm.opts.onError)?.(message, kind),
      done: () => {
        if (here) browseTo(nm.listing.path.replace(/\/[^/]+\/?$/, "") || "/");
        else loadBranches().then(() => setMode("existing"));
      },
    });
  }

  function showBrowser(open) {
    $("nd-browser").hidden = !open;
    $("nd-project").setAttribute("aria-expanded", String(open));
  }

  function mode() {
    return document.querySelector('#new-form input[name="mode"]:checked')?.value || "stay";
  }

  function setMode(m) {
    document.querySelector(`#new-form input[name="mode"][value="${m}"]`).checked = true;
    $("existing-body").hidden = m !== "existing";
    $("new-body").hidden = m !== "new";
    $("stay-body").hidden = m !== "stay";
    updateWhere();
  }

  function worktreePath(repo, branch) {
    const slug = branch.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return `${repo.replace(/\/$/, "")}-worktrees/${slug}`;
  }

  function updateWhere() {
    const l = nm.listing;
    const start = $("start-btn");
    if (!l) { $("where").textContent = ""; start.disabled = true; return; }
    let text = `Starts in ${short(l.path)}`;
    let ok = true;
    if (l.git && !$("branch-step").hidden) {
      const m = mode();
      if (m === "existing") {
        ok = Boolean(nm.picked);
        text = nm.picked
          ? `Starts on ${nm.picked} in ${short(nm.branches?.worktrees[nm.picked] || worktreePath(l.path, nm.picked))}`
          : "Pick a branch";
      } else if (m === "new") {
        const name = $("new-branch").value.trim();
        ok = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) && !name.includes("..");
        text = ok ? `Creates ${name} from ${$("new-base").value} in ${short(worktreePath(l.path, name))}` : "Enter a branch name";
      } else {
        text = `Starts on ${l.branch || "the current branch"} in ${short(l.path)}`;
      }
    }
    $("where").textContent = text;
    start.disabled = !ok;
  }

  function mount() {
    if ($) return;
    document.body.insertAdjacentHTML("beforeend", MARKUP);
    $ = (id) => document.getElementById(id);

    $("new-dialog").addEventListener("click", (e) => {
      const forget = e.target.closest("[data-forget]");
      if (forget) { forgetRecent(forget.dataset.forget); return; }
      const removeWt = e.target.closest("[data-remove-wt]");
      if (removeWt) { removeWorktree(removeWt.dataset.removeWt); return; }
      const target = e.target.closest("[data-path]");
      if (target) { browseTo(target.dataset.path); return; }
      const opt = e.target.closest("[data-branch]");
      if (opt) {
        nm.picked = opt.dataset.branch;
        renderBranchList();
        updateWhere();
      }
    });
    document.querySelectorAll('#new-form input[name="mode"]').forEach((r) => r.addEventListener("change", () => setMode(mode())));
    $("branch-filter").addEventListener("input", renderBranchList);
    $("nd-project").addEventListener("click", () => showBrowser($("nd-browser").hidden));
    $("new-dialog").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(mac ? e.metaKey : e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      if (!$("start-btn").disabled) $("new-form").requestSubmit($("start-btn"));
    });
    $("new-branch").addEventListener("input", updateWhere);
    $("new-base").addEventListener("change", updateWhere);
    $("new-machine").addEventListener("change", (e) => {
      nm.machine = e.target.value;
      browseTo("");
      loadAgents();
    });
    $("new-agent").addEventListener("change", (e) => {
      paintAgent();
      if (e.target.value === ADD) {
        renderAgents();
        showAddAgent(true);
        return;
      }
      if (e.target.value !== MORE) return;
      nm.allAgents = true;
      renderAgents();
      try { e.target.showPicker?.(); } catch {}
    });
    $("agent-save").addEventListener("click", addAgent);
    $("agent-cancel").addEventListener("click", () => showAddAgent(false));
    $("agent-add").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      addAgent();
    });
    $("new-form").addEventListener("submit", (e) => {
      if (e.submitter?.value !== "start") return;
      e.preventDefault();
      const l = nm.listing;
      if (!l) return;
      const agent = $("new-agent").value;
      if (agent === MORE || agent === ADD) return;
      remember("agent", agent);
      const body = { machine: nm.machine, path: l.path, agent, resume: $("new-form").querySelector('input[name="resume"]').checked };
      if (l.git && mode() === "existing") body.branch = nm.picked;
      if (l.git && mode() === "new") Object.assign(body, { branch: $("new-branch").value.trim(), new_branch: true, base: $("new-base").value });
      $("new-dialog").close();
      nm.opts.onStart(body);
    });
  }

  // opts: machines (names that are up), machine, agents, defaultAgent, path, onStart(body), onError(message)
  function open(opts) {
    mount();
    nm.opts = opts;
    const pick = opts.machines.includes(opts.machine) ? opts.machine : opts.machines[0];
    $("new-machine").innerHTML = opts.machines.map((m) => `<option${m === pick ? " selected" : ""}>${esc(m)}</option>`).join("");
    nm.machine = pick;
    $("new-agent").innerHTML = "";
    $("agent-add").hidden = true;
    loadAgents();
    nm.listing = null;
    $("branch-filter").value = "";
    $("new-branch").value = "";
    $("new-form").querySelector('input[name="resume"]').checked = false;
    $("nd-advanced").open = false;
    showBrowser(true);
    $("new-dialog").showModal();
    browseTo(opts.path || "");
  }

  function isOpen() {
    return Boolean($?.("new-dialog")?.open);
  }

  const ADD_MARKUP = `<dialog id="add-project" class="ap" aria-labelledby="ap-title">
  <form method="dialog" id="ap-form">
    <div class="dialog-head">
      <h2 id="ap-title">Add a project</h2>
      <button class="btn quiet icon-btn nd-close" value="cancel" formnovalidate aria-label="Close" title="Close">${ICON.close}</button>
    </div>
    <div class="ap-body">
      <label class="ap-host"><span>Host</span>
        <span class="nd-select-wrap ap-host-select">${ICON.machine}<select id="ap-machine" aria-label="Host"></select>${ICON.updown}</span></label>
      <div class="ap-choices" id="ap-choices">
        <button type="button" class="ap-card" id="ap-browse">
          <span class="ap-card-icon">${ICON.folder}</span>
          <span class="ap-card-text"><span class="ap-card-title">Browse folder</span><span class="ap-card-desc">A project, a Git repository or a folder with many repositories</span></span>
          <kbd class="ap-key" aria-hidden="true">↵</kbd>
        </button>
      </div>
      <div class="ap-browser" id="ap-browser" hidden>
        <nav id="ap-crumbs" class="crumbs" aria-label="Folder path"></nav>
        <ul id="ap-list" class="dir-list" aria-label="Folders"></ul>
      </div>
    </div>
    <div class="dialog-foot" id="ap-foot" hidden>
      <p class="where" id="ap-where"></p>
      <button class="btn" type="button" id="ap-back">Back</button>
      <button class="btn primary" value="add" id="ap-add" disabled>Add project</button>
    </div>
  </form>
</dialog>`;
  const ap = { machine: "", listing: null, opts: null };

  async function apBrowse(path) {
    const list = document.getElementById("ap-list");
    list.innerHTML = `<li class="dir-empty">Loading…</li>`;
    document.getElementById("ap-add").disabled = true;
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : "";
      const l = await api("GET", `/machines/${encodeURIComponent(ap.machine)}/browse${q}`);
      ap.listing = l;
      const parts = l.path.split("/").filter(Boolean);
      const crumbs = [`<button type="button" class="crumb home" data-ap-path="~">Home</button><span class="crumb-divider"></span>`, `<button type="button" class="crumb" data-ap-path="/">/</button>`];
      parts.forEach((p, i) => crumbs.push(`${i ? `<span class="sep">/</span>` : ""}<button type="button" class="crumb${i === parts.length - 1 ? " here" : ""}" data-ap-path="/${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`));
      document.getElementById("ap-crumbs").innerHTML = crumbs.join("");
      const up = parts.length ? `<li><button type="button" class="dir" data-ap-path="/${esc(parts.slice(0, -1).join("/"))}"><span class="dir-name">..</span></button></li>` : "";
      list.innerHTML = up + (l.entries.length
        ? l.entries.map((e) => `<li><button type="button" class="dir${e.git ? " git" : ""}" data-ap-path="${esc(`${l.path.replace(/\/$/, "")}/${e.name}`)}">
            ${folderIcon(e.git)}<span class="dir-name">${esc(e.name)}</span>${e.git && e.branch ? `<span class="dir-branch">${esc(e.branch)}</span>` : ""}
          </button></li>`).join("")
        : `<li class="dir-empty">No subfolders</li>`);
      document.getElementById("ap-where").textContent = `Adds ${short(l.path)}${l.git ? `, on ${l.branch || "a detached HEAD"}` : ""}`;
      document.getElementById("ap-add").disabled = false;
    } catch (err) {
      list.innerHTML = `<li class="dir-empty error">${esc(err.message)}</li>`;
    }
  }

  function apStep(browsing) {
    document.getElementById("ap-choices").hidden = browsing;
    document.getElementById("ap-browser").hidden = !browsing;
    document.getElementById("ap-foot").hidden = !browsing;
    if (browsing) apBrowse(ap.opts.path || "");
    else document.getElementById("ap-browse").focus();
  }

  function mountAdd() {
    if (document.getElementById("add-project")) return;
    document.body.insertAdjacentHTML("beforeend", ADD_MARKUP);
    const dialog = document.getElementById("add-project");
    dialog.addEventListener("click", (e) => {
      const target = e.target.closest("[data-ap-path]");
      if (target) apBrowse(target.dataset.apPath);
    });
    document.getElementById("ap-browse").addEventListener("click", () => apStep(true));
    document.getElementById("ap-back").addEventListener("click", () => apStep(false));
    document.getElementById("ap-machine").addEventListener("change", (e) => {
      ap.machine = e.target.value;
      ap.opts.path = "";
      if (!document.getElementById("ap-browser").hidden) apBrowse("");
    });
    document.getElementById("ap-form").addEventListener("submit", (e) => {
      if (e.submitter?.value !== "add") return;
      e.preventDefault();
      if (!ap.listing) return;
      dialog.close();
      ap.opts.onAdd({ machine: ap.machine, path: ap.listing.path, git: ap.listing.git });
    });
  }

  // opts: machines (names that are up), machine, path, onAdd({ machine, path, git })
  function addProject(opts) {
    mountAdd();
    ap.opts = { ...opts };
    ap.listing = null;
    const pick = opts.machines.includes(opts.machine) ? opts.machine : opts.machines[0];
    ap.machine = pick;
    document.getElementById("ap-machine").innerHTML = opts.machines.map((m) => `<option${m === pick ? " selected" : ""}>${esc(m)}</option>`).join("");
    document.getElementById("add-project").showModal();
    apStep(false);
  }

  window.YardbellNewSession = { open, isOpen, addProject };
})();
