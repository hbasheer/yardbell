(function () {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const SHOWN = 80;
  const WORDS = { working: "Working", waiting: "Waiting for you", idle: "Idle" };
  const TONES = { working: "ok", waiting: "warn", idle: "" };

  function duration(secs) {
    const mins = Math.floor(secs / 60);
    if (mins < 1) return "under a minute";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
  }

  function clock(stamp) {
    const d = new Date(stamp);
    if (Number.isNaN(d.getTime())) return "";
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
  }

  function times(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function summary(data) {
    const t = data.timeline;
    if (!t) return `<p class="ins-since">Yardbell has not recorded this session yet. Its timeline starts with the next check.</p>`;
    const since = t.started ? `Started ${esc(clock(t.since))}` : `Running when Yardbell started watching it, ${esc(clock(t.since))}`;
    const end = t.ended ? ` · Ended ${esc(clock(t.ended))}` : data.live ? "" : " · No longer running";
    const waits = t.periods.filter((p) => p.state === "waiting").length;
    const tests = t.runs.filter((r) => r.ok !== undefined);
    const failed = tests.filter((r) => r.ok === false).length;
    const parts = [
      `<span><span class="dot ok"></span><span>Working <b>${esc(duration(t.totals.working))}</b></span></span>`,
      `<span><span class="dot warn"></span><span>Waiting for you <b>${esc(duration(t.totals.waiting))}</b>${waits ? `, ${esc(times(waits, "time"))}` : ""}</span></span>`,
      `<span><span class="dot"></span><span>Idle <b>${esc(duration(t.totals.idle))}</b></span></span>`,
    ];
    if (tests.length) parts.push(`<span><span>Test results <b>${tests.length - failed} passed</b>${failed ? `, <b class="ins-bad">${failed} failed</b>` : ""}</span></span>`);
    return `<p class="ins-since">${since}${end}</p><p class="ins-totals">${parts.join("")}</p>${bar(t)}`;
  }

  function bar(t) {
    const total = t.periods.reduce((n, p) => n + p.seconds, 0);
    if (!total) return "";
    return `<div class="ins-bar" aria-hidden="true">${t.periods.map((p) => `<span class="ins-seg ${p.state}" style="flex-grow:${Math.max(p.seconds, total / 400)}" title="${esc(`${WORDS[p.state]}, ${duration(p.seconds)} from ${clock(p.from)}`)}"></span>`).join("")}</div>`;
  }

  function runRow(r, at) {
    const result = r.ok === true ? `<span class="ins-result ok">Passed</span>` : r.ok === false ? `<span class="ins-result bad">Failed</span>` : "";
    const glyph = r.kind === "test"
      ? '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4M6.5 2.5v4L3 12.5a1 1 0 0 0 .9 1.5h8.2a1 1 0 0 0 .9-1.5L9.5 6.5v-4"/></svg>'
      : '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6 8l-3 3.5M8 11.5h5"/></svg>';
    return `<li class="ins-run is-${r.kind}"><span class="ins-time">${esc(at)}</span><span class="ins-mark" title="${r.kind === "test" ? "Test run" : "Tool call"}">${glyph}</span><span class="ins-text"><code>${esc(r.text)}</code></span>${result}</li>`;
  }

  function periodRow(p) {
    const lasting = p.to ? duration(p.seconds) : `${duration(p.seconds)} so far`;
    return `<li class="ins-period ${p.state}"><span class="ins-time">${esc(clock(p.from))}</span><span class="ins-mark"><span class="dot ${TONES[p.state]}"></span></span><span class="ins-text">${WORDS[p.state]}</span><span class="ins-len">${esc(lasting)}</span></li>`;
  }

  function rows(data, all) {
    const t = data.timeline;
    if (!t) return "";
    const items = [
      ...t.periods.map((p) => ({ at: p.from, html: periodRow(p) })),
      ...t.runs.map((r) => ({ at: r.at, html: runRow(r, clock(r.at)) })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (t.ended) items.push({ at: t.ended, html: `<li class="ins-period ended"><span class="ins-time">${esc(clock(t.ended))}</span><span class="ins-mark"></span><span class="ins-text">Ended</span></li>` });
    if (!items.length) return "";
    const hidden = all ? 0 : Math.max(0, items.length - SHOWN);
    const more = hidden ? `<li class="ins-more"><button class="link-btn" type="button" data-ins="all">Show ${hidden} earlier</button></li>` : "";
    const cut = t.dropped ? `<li class="ins-more">${esc(times(t.dropped, "older change"))} no longer kept.</li>` : "";
    return `<h3 class="ins-head">Timeline</h3><ol class="ins-list">${cut}${more}${items.slice(hidden).map((i) => i.html).join("")}</ol>`;
  }

  function earlier(data) {
    if (data.scrollback_error) return `<p class="help">Could not read the scrollback: ${esc(data.scrollback_error)}</p>`;
    if (!data.earlier?.length) return "";
    return `<h3 class="ins-head">Earlier, from the scrollback</h3>
      <p class="help ins-note">Tool calls and test runs on the screen from before Yardbell recorded them, oldest first. Their times are not known.</p>
      <ol class="ins-list">${data.earlier.map((r) => runRow(r, "")).join("")}</ol>`;
  }

  function task(data) {
    const from = data.from
      ? `<p class="help ins-note">From the task <strong>${esc(data.from.name)}</strong>, version ${data.from.version}${data.from.current !== data.from.version ? `. It is at version ${data.from.current} now` : ""}.</p>`
      : "";
    if (!data.task) return from;
    return `<h3 class="ins-head">Task</h3><pre class="ins-task">${esc(data.task)}</pre>${from}`;
  }

  function body(data, all) {
    const t = data.timeline;
    const where = [data.machine, t?.folder, t?.branch].filter(Boolean).map(esc);
    return `<div class="ins-top"><h2>Insights for ${esc(data.name)}</h2><p class="ins-where">on ${where.join(" · ")}</p></div>
      <div class="ins-body">${summary(data)}${rows(data, all)}${earlier(data)}${task(data)}</div>
      <div class="dialog-foot">
        <p class="where">Asks Dispatch to read this session and propose a clearer prompt for next time.</p>
        <button class="btn quiet" type="button" data-ins="close">Close</button>
        <button class="btn primary" type="button" data-ins="suggest">Suggest a better prompt</button>
      </div>`;
  }

  async function load(machine, name) {
    const res = await fetch(`/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/insights`, { headers: { Accept: "application/json" } });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("Log in again");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // onSuggest gets the session's insights, with the message for Dispatch in `suggest`.
  function open({ machine, name, onSuggest }) {
    const dialog = document.createElement("dialog");
    dialog.className = "ins-dialog";
    dialog.setAttribute("aria-label", `Insights for ${name}`);
    dialog.innerHTML = `<div class="ins-top"><h2>Insights for ${esc(name)}</h2><p class="ins-where">Reading ${esc(name)} on ${esc(machine)}…</p></div>
      <div class="dialog-foot"><p class="where"></p><button class="btn quiet" type="button" data-ins="close">Close</button></div>`;
    document.body.append(dialog);
    const back = document.activeElement;
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    });
    let data = null;
    dialog.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ins]");
      if (!b) return;
      if (b.dataset.ins === "close") dialog.close();
      if (b.dataset.ins === "all" && data) dialog.innerHTML = body(data, true);
      if (b.dataset.ins === "suggest" && data) {
        dialog.close();
        onSuggest?.(data);
      }
    });
    dialog.showModal();
    load(machine, name)
      .then((loaded) => {
        if (!dialog.isConnected) return;
        data = loaded;
        dialog.innerHTML = body(data, false);
        dialog.querySelector('[data-ins="suggest"]').focus();
      })
      .catch((err) => {
        if (!dialog.isConnected) return;
        dialog.querySelector(".ins-where").outerHTML = `<p class="wt-error" role="alert">${esc(err.message)}</p>`;
      });
  }

  // Pages other than Dispatch hand the request over this way, so Dispatch starts it only when
  // the person picked it here, never from a link.
  const KEY = "yardbell.suggest";

  function handOver(data) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ machine: data.machine, name: data.name, at: Date.now() }));
    } catch {}
    location.href = "/dispatch";
  }

  function takeOver() {
    try {
      const raw = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
      const wanted = raw ? JSON.parse(raw) : null;
      return wanted && Date.now() - wanted.at < 60000 ? wanted : null;
    } catch {
      return null;
    }
  }

  window.YardbellInsights = { open, load, handOver, takeOver };
})();
