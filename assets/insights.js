(function () {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const SHOWN = 80;
  const LONG_TEXT = 240;
  const STATES = ["working", "waiting", "idle"];
  const WORDS = { working: "Working", waiting: "Waiting for you", idle: "Idle" };
  const TONES = { working: "ok", waiting: "warn", idle: "" };
  const MEANS = {
    working: "The agent was busy: thinking, editing files or running commands.",
    waiting: "It stopped at a question or a permission prompt until you answered.",
    idle: "Nothing was happening, usually because it had finished and was at its prompt.",
  };
  const NOW = { active: "working now", blocked: "waiting for you now", idle: "idle now" };
  const TOOL = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6 8l-3 3.5M8 11.5h5"/></svg>';
  const PULL = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H7"/></svg>';
  const FLASK = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4M6.5 2.5v4L3 12.5a1 1 0 0 0 .9 1.5h8.2a1 1 0 0 0 .9-1.5L9.5 6.5v-4"/></svg>';

  function duration(secs) {
    const mins = Math.floor(secs / 60);
    if (mins < 1) return "under a minute";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
  }

  function amount(secs) {
    if (!secs) return "0 min";
    return secs < 60 ? "<1 min" : duration(secs);
  }

  function clock(stamp) {
    const d = new Date(stamp);
    if (Number.isNaN(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString() ? hour(stamp) : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${hour(stamp)}`;
  }

  function hour(stamp) {
    const d = new Date(stamp);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function day(stamp) {
    const d = new Date(stamp);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    const year = d.getFullYear() === today.getFullYear() ? undefined : "numeric";
    return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year });
  }

  function times(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // Whole percentages that add up to 100, so the three shares never read as 101%.
  function shares(values) {
    const total = values.reduce((a, b) => a + b, 0);
    if (!total) return values.map(() => 0);
    const raw = values.map((v) => (v * 100) / total);
    const out = raw.map(Math.floor);
    const left = 100 - out.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => out[i]++);
    return out;
  }

  function facts(data) {
    const t = data.timeline;
    const status = t?.ended ? "Ended" : data.live ? (NOW[data.activity] ? `Running, ${NOW[data.activity]}` : "Running") : "No longer running";
    const items = [
      ["Status", status],
      t && [t.started ? "Started" : "Watched since", clock(t.since)],
      t?.ended && ["Ended", clock(t.ended)],
      ["Machine", data.machine],
      t?.folder && ["Folder", t.folder],
      t?.branch && ["Branch", t.branch],
      t?.agent && ["Agent", t.agent],
    ].filter(Boolean);
    const note = t && !t.started
      ? `<p class="help ins-note">It was already running when Yardbell started watching it, so the figures below start at ${esc(clock(t.since))}.</p>`
      : "";
    return `<dl class="ins-facts">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${pulled(data.pull)}${note}`;
  }

  function pulled(p) {
    if (!p) return "";
    const P = window.YardbellPull;
    const { word, tone } = P.status(p);
    const says = P.details(p);
    return `<div class="ins-pull"><span class="ins-mark" title="${esc(P.noun(p))}" aria-hidden="true">${PULL}</span>
      <a href="${esc(p.url)}" target="_blank" rel="noopener"><span class="ins-pull-ref">${esc(P.ref(p))}</span> ${esc(p.title)}</a>
      <span class="pr-badge ${tone}">${esc(word)}</span>${says.length ? `<span class="ins-pull-says">${esc(says.join(". "))}.</span>` : ""}</div>`;
  }

  function spent(t) {
    const secs = STATES.map((s) => t.totals[s]);
    const total = secs.reduce((a, b) => a + b, 0);
    const pct = shares(secs);
    const waits = t.periods.filter((p) => p.state === "waiting").length;
    const tiles = STATES.map((state, i) => {
      const share = secs[i] ? `${pct[i] ? pct[i] : "under 1"}% of the time` : "";
      const count = state === "waiting" ? (waits ? times(waits, "time") : "Never waited") : "";
      const sub = [count, share].filter(Boolean).join(", ");
      return `<div class="ins-stat"><dt><span class="dot ${TONES[state]}"></span>${WORDS[state]}</dt>
        <dd class="ins-figure">${esc(amount(secs[i]))}</dd>${sub ? `<dd class="ins-sub">${esc(sub)}</dd>` : ""}<dd class="ins-means">${MEANS[state]}</dd></div>`;
    });
    tiles.push(tested(t));
    const all = duration(total);
    const span = total ? `${esc(all[0].toUpperCase() + all.slice(1))} in all, from ${esc(clock(t.since))} to ${t.ended ? esc(clock(t.ended)) : "now"}. ` : "";
    return `<h3 class="ins-head">Time spent</h3>
      <p class="help ins-note">${span}How long the session spent in each state Yardbell tracks. The bar below draws each stretch to scale, oldest on the left.</p>
      <dl class="ins-stats">${tiles.join("")}</dl>${bar(t)}`;
  }

  function tested(t) {
    const tests = t.runs.filter((r) => r.ok !== undefined);
    const failed = tests.filter((r) => r.ok === false).length;
    const head = `<dt><span class="ins-mark">${FLASK}</span>Test results</dt>`;
    if (!tests.length) {
      return `<div class="ins-stat">${head}<dd class="ins-figure">None</dd><dd class="ins-means">No test runner's summary showed on the screen, such as one from cargo test, npm test or pytest.</dd></div>`;
    }
    const sub = `${tests.length - failed} passed, ${failed ? `<b class="ins-bad">${failed} failed</b>` : "0 failed"}`;
    return `<div class="ins-stat">${head}<dd class="ins-figure">${esc(times(tests.length, "run"))}</dd><dd class="ins-sub">${sub}</dd><dd class="ins-means">Summaries a test runner printed on the screen, each marked Passed or Failed in the timeline.</dd></div>`;
  }

  function bar(t) {
    const total = t.periods.reduce((n, p) => n + p.seconds, 0);
    if (!total) return "";
    return `<div class="ins-bar" aria-hidden="true">${t.periods.map((p) => `<span class="ins-seg ${p.state}" style="flex-grow:${Math.max(p.seconds, total / 400)}" title="${esc(`${WORDS[p.state]}, ${duration(p.seconds)} from ${clock(p.from)}`)}"></span>`).join("")}</div>
      <div class="ins-axis" aria-hidden="true"><span>${esc(clock(t.periods[0].from))}</span><span>${t.ended ? esc(clock(t.ended)) : "Now"}</span></div>`;
  }

  function runRow(r, at) {
    if (r.kind === "pull") {
      const text = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.text)}</a>` : esc(r.text);
      return `<li class="ins-run is-pull"><span class="ins-time">${esc(at)}</span><span class="ins-mark" title="Pull request or merge request" aria-label="Pull request or merge request">${PULL}</span><span class="ins-text">${text}</span></li>`;
    }
    const result = r.ok === true ? `<span class="ins-result ok">Passed</span>` : r.ok === false ? `<span class="ins-result bad">Failed</span>` : "";
    const kind = r.kind === "test" ? "Test run" : "Tool call";
    return `<li class="ins-run is-${r.kind}"><span class="ins-time">${esc(at)}</span><span class="ins-mark" title="${kind}" aria-label="${kind}">${r.kind === "test" ? FLASK : TOOL}</span><span class="ins-text"><code>${esc(r.text)}</code></span>${result}</li>`;
  }

  function line(label, text, tone = "") {
    return text ? `<p class="ins-line ${tone}"><span class="ins-who">${label}</span><span class="ins-said">${esc(text)}</span></p>` : "";
  }

  function steps(part) {
    const total = part.did.length + part.more;
    if (!total) return part.said.length > LONG_TEXT ? `<details class="ins-steps"><summary>Show all of it</summary></details>` : "";
    const older = part.more ? `<li class="ins-older">${esc(times(part.more, "older step"))} not shown.</li>` : "";
    return `<details class="ins-steps"><summary>Show ${esc(times(total, "step"))}</summary><ol>${older}${part.did.map((a) => `<li>${esc(a.what)}</li>`).join("")}</ol></details>`;
  }

  function partDetail(part) {
    if (!part) return "";
    const said = [
      ...part.asked.map((text) => line("You said", text)),
      line("It asked", part.question, "waiting"),
      line("Stopped at", part.stopped_at, "waiting"),
      line("Did", part.summary),
      line("It said", part.said),
    ].join("");
    return said ? `<div class="ins-part">${said}${steps(part)}</div>` : "";
  }

  function periodRow(p, part) {
    const lasting = p.to ? `for ${duration(p.seconds)}` : `${duration(p.seconds)} so far`;
    return `<li class="ins-period ${p.state}"><span class="ins-time">${esc(hour(p.from))}</span><span class="ins-mark"><span class="dot ${TONES[p.state]}"></span></span><span class="ins-text">${WORDS[p.state]}</span><span class="ins-len">${esc(lasting)}</span>${partDetail(part)}</li>`;
  }

  function rows(data, all) {
    const t = data.timeline;
    const told = data.parts?.periods.some((part) => part.did.length);
    const items = [
      ...t.periods.map((p, i) => ({ at: p.from, html: periodRow(p, data.parts?.periods[i]) })),
      ...t.runs.filter((r) => !(told && r.kind === "tool")).map((r) => ({ at: r.at, html: runRow(r, hour(r.at)) })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (t.ended) items.push({ at: t.ended, html: `<li class="ins-period ended"><span class="ins-time">${esc(hour(t.ended))}</span><span class="ins-mark"></span><span class="ins-text">Ended</span></li>` });
    if (!items.length) return "";
    const hidden = all ? 0 : Math.max(0, items.length - SHOWN);
    const more = hidden ? `<li class="ins-more"><button class="link-btn" type="button" data-ins="all">Show ${hidden} earlier</button></li>` : "";
    const cut = t.dropped ? `<li class="ins-more">${esc(times(t.dropped, "older change"))} no longer kept.</li>` : "";
    let last = "";
    const dated = items.slice(hidden).map((i) => {
      const d = day(i.at);
      const head = d && d !== last ? `<li class="ins-day">${esc(d)}</li>` : "";
      last = d;
      return head + i.html;
    });
    const notes = timelineNotes(data, told);
    const before = data.parts && partDetail(data.parts.before);
    const first = before && !hidden ? `<li class="ins-period before"><span class="ins-time"></span><span class="ins-mark"></span><span class="ins-text">Before Yardbell was watching</span>${before}</li>` : "";
    return `<h3 class="ins-head">Timeline</h3>
      <p class="help ins-note">${notes}</p>
      <ol class="ins-list">${cut}${more}${first}${dated.join("")}</ol>`;
  }

  function timelineNotes(data, told) {
    const t = data.timeline;
    const pulls = t.runs.some((r) => r.kind === "pull");
    const marks = told
      ? `each <span class="ins-key">${FLASK}test run</span>`
      : `each <span class="ins-key">${TOOL}tool call</span> and <span class="ins-key">${FLASK}test run</span> Yardbell saw`;
    const lead = told
      ? "What happened in each stretch of working, waiting and idle, from this session's transcript, with"
      : "Each change between working, waiting and idle with how long it lasted, and";
    const w = data.work;
    const warn = [
      w?.shared ? "Another session runs in this folder, so the detail may be from that session." : "",
      w?.partial ? "This is a long session, so older stretches may have no detail." : "",
    ].filter(Boolean).join(" ");
    return `${lead} ${marks}${pulls ? `, and what happened to its <span class="ins-key">${PULL}pull request or merge request</span>` : ""}, oldest first.${warn ? ` ${esc(warn)}` : ""}`;
  }

  function empty(data) {
    return `<div class="ins-empty"><p class="ins-empty-title">Nothing recorded yet</p>
      <p>Yardbell builds this timeline from its regular checks of ${esc(data.machine)}. It has not checked this session since it appeared, so the first entries come with the next check. Open Insights again in a moment.</p></div>`;
  }

  function earlier(data) {
    if (data.scrollback_error) return `<p class="help">Could not read the scrollback: ${esc(data.scrollback_error)}</p>`;
    if (!data.earlier?.length) return "";
    return `<h3 class="ins-head">Earlier, from the scrollback</h3>
      <p class="help ins-note">Tool calls and test runs on the screen from before Yardbell recorded them, oldest first. Their times are not known.</p>
      <ol class="ins-list">${data.earlier.map((r) => runRow(r, "")).join("")}</ol>`;
  }

  function about(data) {
    const w = data.work;
    const text = w?.title || (data.task ? "" : w?.first_prompt);
    return text ? `<p class="ins-about">${esc(text)}</p>` : "";
  }

  function terminalEnd(data) {
    if (!data.work?.screen) return "";
    return `<div class="ins-work"><h3 class="ins-head">End of its terminal</h3><p class="help ins-note">Yardbell can only read what happened in each stretch from Claude Code's sessions.</p>
      <pre class="ins-task">${esc(data.work.screen)}</pre></div>`;
  }

  function task(data) {
    const from = data.from
      ? `<p class="help ins-note">From the task <strong>${esc(data.from.name)}</strong>, version ${data.from.version}${data.from.current !== data.from.version ? `. It is at version ${data.from.current} now` : ""}.</p>`
      : "";
    if (!data.task) return from;
    return `<h3 class="ins-head">Task</h3><p class="help ins-note">The prompt this session started with.</p><pre class="ins-task">${esc(data.task)}</pre>${from}`;
  }

  function body(data, all) {
    const t = data.timeline;
    const record = t ? `${spent(t)}${rows(data, all)}` : empty(data);
    return `<div class="ins-top"><h2>Insights for ${esc(data.name)}</h2><p class="ins-where">What Yardbell saw of this session while it watched it.</p></div>
      <div class="ins-body">${about(data)}${facts(data)}${record}${terminalEnd(data)}${earlier(data)}${task(data)}</div>
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
      <div class="ins-body"></div>
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
