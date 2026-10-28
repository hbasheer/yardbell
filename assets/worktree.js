(function () {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (path) => String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
  const SHOWN = 12;

  async function call(method, url, body) {
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
    return { ok: res.ok, status: res.status, data };
  }

  function open(label) {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm wt-dialog";
    dialog.setAttribute("aria-label", label);
    document.body.append(dialog);
    const back = document.activeElement;
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    });
    dialog.showModal();
    return dialog;
  }

  function list(items) {
    const more = items.length > SHOWN ? `<li class="wt-more">and ${items.length - SHOWN} more</li>` : "";
    return `<ul class="wt-list">${items.slice(0, SHOWN).map((i) => `<li>${esc(i)}</li>`).join("")}${more}</ul>`;
  }

  function closeButton(word = "Close") {
    return `<div class="dialog-actions"><button class="btn primary" type="button" data-wt="close">${word}</button></div>`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // What removing would lose, shown before anything is removed; the server refuses the same
  // things on its own, so a stale dialog cannot remove more than it showed.
  function removeBody(machine, info, error) {
    const w = info.worktree;
    if (!w.linked) {
      return `<h2>Not a worktree</h2><p><code>${esc(short(w.path))}</code> is the repository's main checkout. Yardbell only removes worktrees.</p>${closeButton()}`;
    }
    if (info.sessions?.length) {
      return `<h2>A session still runs there</h2><p>${esc(info.sessions.join(", "))} runs in <code>${esc(short(w.path))}</code> on ${esc(machine)}. Stop it first, then remove the worktree.</p>${closeButton()}`;
    }
    const risky = w.dirty.length || w.unpushed.length;
    const dirty = w.dirty.length ? `<p class="wt-warn">${esc(plural(w.dirty.length, "uncommitted change", "uncommitted changes"))} would be lost:</p>${list(w.dirty)}` : "";
    const commits = w.unpushed.length ? `<p class="wt-warn">${esc(plural(w.unpushed.length, "commit", "commits"))} on <code>${esc(w.branch)}</code> that no remote or other branch has:</p>${list(w.unpushed)}` : "";
    const branch = !w.branch ? "" : w.merged_into
      ? `<label class="check"><input type="checkbox" data-wt="delete-branch"><span>Also delete branch <code>${esc(w.branch)}</code>, merged into <code>${esc(w.merged_into)}</code></span></label>`
      : `<p class="help">Branch <code>${esc(w.branch)}</code> is kept${w.unpushed.length ? ", so its commits stay unless you delete it yourself" : ""}.</p>`;
    const failed = error ? `<p class="wt-error" role="alert">${esc(error)}</p>` : "";
    return `<h2>Remove this worktree?</h2>
      <p>Removes <code>${esc(short(w.path))}</code> on ${esc(machine)} with <code>git worktree remove</code> and prunes. The main checkout <code>${esc(short(w.main))}</code> is not touched.</p>
      ${dirty}${commits}${branch}${failed}
      <div class="dialog-actions">
        <button class="btn quiet" type="button" data-wt="close">Cancel</button>
        <button class="btn ${risky ? "danger-solid" : "primary"}" type="button" data-wt="remove" data-force="${risky ? "1" : ""}">${risky ? "Remove and lose these" : "Remove worktree"}</button>
      </div>`;
  }

  async function remove({ machine, path, toast = () => {}, done = () => {} }) {
    const dialog = open("Remove worktree");
    dialog.innerHTML = `<h2>Remove this worktree?</h2><p>Checking <code>${esc(short(path))}</code> on ${esc(machine)}…</p>${closeButton("Cancel")}`;
    let info = null;
    const show = (error) => {
      dialog.innerHTML = removeBody(machine, info, error);
      (dialog.querySelector('[data-wt="remove"]') || dialog.querySelector("button")).focus();
    };
    dialog.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-wt]");
      if (!b || b.tagName !== "BUTTON") return;
      if (b.dataset.wt === "close") { dialog.close(); return; }
      if (b.dataset.wt !== "remove") return;
      b.disabled = true;
      b.textContent = "Removing…";
      const body = { path: info.worktree.path, force: Boolean(b.dataset.force), delete_branch: Boolean(dialog.querySelector('[data-wt="delete-branch"]')?.checked) };
      try {
        const res = await call("POST", `/worktrees/${encodeURIComponent(machine)}/remove`, body);
        if (res.ok) {
          dialog.close();
          toast(res.data.removed?.note || "Removed the worktree", "ok");
          done(res.data);
          return;
        }
        if (res.data.worktree) info = { ...info, worktree: res.data.worktree };
        show(res.data.error || `Request failed (${res.status})`);
      } catch (err) {
        show(err.message);
      }
    });
    try {
      const res = await call("POST", `/worktrees/${encodeURIComponent(machine)}/inspect`, { path });
      if (!dialog.isConnected) return;
      if (!res.ok) {
        dialog.innerHTML = `<h2>Cannot remove this worktree</h2><p class="wt-error" role="alert">${esc(res.data.error || `Request failed (${res.status})`)}</p>${closeButton()}`;
        return;
      }
      info = res.data;
      show();
    } catch (err) {
      dialog.innerHTML = `<h2>Cannot remove this worktree</h2><p class="wt-error" role="alert">${esc(err.message)}</p>${closeButton()}`;
    }
  }

  function setupNote(run) {
    if (!run) return "";
    return run.ok ? `Setup ran: ${run.command}` : `Setup failed: ${run.command}`;
  }

  function showSetup(run) {
    const dialog = open("Worktree setup");
    const title = run.ok ? "Setup finished" : run.timed_out ? "Setup timed out" : "Setup failed";
    const what = run.ok
      ? `It finished in ${run.seconds} s.`
      : run.timed_out
      ? `It was stopped after ${run.seconds} s, its timeout. The agent started anyway and was told.`
      : `It ${run.exit == null ? "could not run" : `ended with exit code ${run.exit}`}. The agent started anyway and was told.`;
    const log = run.log ? `<p class="help">Full output: <code>${esc(run.log)}</code></p>` : "";
    dialog.innerHTML = `<h2>${title}</h2>
      <p><code>${esc(run.command)}</code> in <code>${esc(short(run.path))}</code>. ${esc(what)}</p>
      <pre class="wt-output">${esc(run.output || "No output.")}</pre>${log}${closeButton()}`;
    dialog.addEventListener("click", (e) => { if (e.target.closest('[data-wt="close"]')) dialog.close(); });
    dialog.querySelector("button").focus();
  }

  function room(m) {
    const h = m.health;
    if (!h) return 0;
    const free = Math.max(0, h.mem_total_kb - h.mem_used_kb);
    return h.limit_kb ? Math.min(free, Math.max(0, h.limit_kb - h.limit_used_kb)) : free;
  }

  function gb(kb) {
    return (kb / 1048576).toFixed(1);
  }

  async function move({ session, state, toast = () => {}, done = () => {}, openTerm }) {
    const s = session;
    const others = (state?.machines || []).filter((m) => m.up && m.name !== s.machine).sort((a, b) => room(b) - room(a));
    const dialog = open("Move session");
    if (!others.length) {
      dialog.innerHTML = `<h2>Nowhere to move it</h2><p>No other machine is connected right now.</p>${closeButton()}`;
      dialog.addEventListener("click", (e) => { if (e.target.closest('[data-wt="close"]')) dialog.close(); });
      return;
    }
    const has = (m) => (state.folders || []).some((f) => f.machine === m.name && f.label === s.folder);
    const options = others.map((m) => `<option value="${esc(m.name)}">${esc(m.name)} · ${gb(room(m))} GB free${m.health ? ` · load ${Number(m.health.load1).toFixed(1)}` : ""}${has(m) ? "" : " · folder not listed"}</option>`).join("");
    dialog.innerHTML = `<h2>Move ${esc(s.tmux)} to another machine</h2>
      <p>The branch <code>${esc(s.branch || "")}</code> and its uncommitted changes go over ssh into a worktree there. Nothing is committed or pushed. The same agent starts there with this task and a note that it continued from ${esc(s.machine)}.</p>
      <label>Move to<select data-wt="to"><option value="">The machine with the most room</option>${options}</select></label>
      <label>Task<textarea rows="4" data-wt="task" placeholder="What the agent should do there"></textarea></label>
      <label class="check"><input type="checkbox" data-wt="stop"><span>Stop the original once the new one runs</span></label>
      <p class="wt-error" role="alert" hidden></p>
      <div class="dialog-actions">
        <button class="btn quiet" type="button" data-wt="close">Cancel</button>
        <button class="btn primary" type="button" data-wt="move">Move session</button>
      </div>`;
    const task = dialog.querySelector('[data-wt="task"]');
    call("GET", `/sessions/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}/task`)
      .then((res) => { if (res.ok && !task.value) task.value = res.data.task || ""; })
      .catch(() => {});
    let moved = null;
    dialog.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-wt]");
      if (!b) return;
      const act = b.dataset.wt;
      if (act === "close") { dialog.close(); return; }
      if (act === "open" && moved) { dialog.close(); openTerm?.(moved.machine, moved.name); return; }
      if (act === "stop-original" && moved) {
        b.disabled = true;
        const res = await call("POST", `/sessions/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}/stop`).catch((err) => ({ ok: false, data: { error: err.message } }));
        if (res.ok) {
          toast(`Stopped ${s.tmux} on ${s.machine}`, "ok");
          dialog.close();
          done(moved);
        } else {
          b.disabled = false;
          toast(res.data.error || "Could not stop it");
        }
        return;
      }
      if (act !== "move") return;
      const error = dialog.querySelector(".wt-error");
      error.hidden = true;
      b.disabled = true;
      b.textContent = "Moving…";
      const body = {
        to: dialog.querySelector('[data-wt="to"]').value,
        task: task.value,
        stop_original: dialog.querySelector('[data-wt="stop"]').checked,
      };
      try {
        const res = await call("POST", `/sessions/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux)}/move`, body);
        if (!res.ok) throw new Error(res.data.error || `Request failed (${res.status})`);
        moved = res.data;
        const setup = moved.setup && !moved.setup.ok ? `<p class="wt-warn">${esc(setupNote(moved.setup))}. The agent was told.</p>` : "";
        const stopped = moved.from?.stopped;
        dialog.innerHTML = `<h2>Moved to ${esc(moved.machine)}</h2>
          <p>${esc(moved.name)} runs in <code>${esc(short(moved.path))}</code> on ${esc(moved.machine)}${moved.changes_moved ? ", with the uncommitted changes" : ""}. ${stopped ? `${esc(s.tmux)} on ${esc(s.machine)} was stopped.` : `${esc(s.tmux)} still runs on ${esc(s.machine)}.`}</p>
          ${setup}
          <div class="dialog-actions">
            ${stopped ? "" : `<button class="btn quiet danger" type="button" data-wt="stop-original">Stop the original</button>`}
            <button class="btn" type="button" data-wt="close">Done</button>
            <button class="btn primary" type="button" data-wt="open">Open</button>
          </div>`;
        dialog.querySelector('[data-wt="open"]').focus();
        if (stopped) done(moved);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        b.disabled = false;
        b.textContent = "Move session";
      }
    });
    dialog.querySelector('[data-wt="to"]').focus();
  }

  window.YardbellWorktree = { remove, move, showSetup, setupNote };
})();
