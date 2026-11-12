(function () {
  const where = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const dock = document.getElementById("term-dock");
  if (!dock || where[0] !== "term" || where[1] === "_onboarding" || !where[2]) return;
  const [, machine, name] = where;
  const api = `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/agent`;

  const ESC = "\x1b";
  // Keys pressed one after another need a gap: Esc Esc in one write reads as Alt+Esc.
  const STEP_MS = 120;
  // A pressed key changes the screen, and until the server has read it again the old choices
  // could answer the next question by mistake, so only the safe keys show for a while.
  const SETTLE_MS = 6000;
  const STOP = { word: "Stop", combo: "Esc", writes: [ESC] };
  const KEYS = {
    claude: {
      working: [STOP, { word: "Send now", combo: "⌃X ⌃S", writes: ["\x18\x13"] }],
      idle: [
        { word: "Mode", combo: "⇧Tab", writes: ["\x1b[Z"] },
        { word: "History", combo: "↑", writes: ["\x1b[A"] },
        { word: "Clear line", combo: "⌃U", writes: ["\x15"] },
      ],
    },
    codex: {
      working: [STOP],
      idle: [{ word: "History", combo: "↑", writes: ["\x1b[A"] }],
    },
  };
  const AGENTS = { claude: "claude", "claude-code": "claude", codex: "codex" };
  const ROLE_WORDS = { yes: "Yes", always: "Always", no: "No" };
  const TYPE_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 10h6"/></svg>';

  const phoneSized = () => {
    try { return window.top.innerWidth <= 760; } catch { return window.innerWidth <= 760; }
  };
  const touch = matchMedia("(pointer: coarse)");
  const wanted = () => touch.matches || phoneSized();

  let info = null;
  let settling = null;
  let shownHtml = "";

  const row = document.createElement("div");
  row.className = "agent-row";
  row.setAttribute("role", "toolbar");
  row.setAttribute("aria-label", "Agent keys");
  dock.append(row);

  if (!document.querySelector("link[data-geist]")) {
    const font = document.createElement("link");
    font.rel = "stylesheet";
    font.href = "https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.2.6/index.css";
    font.integrity = "sha384-p+EgvS3+MmUG4ztXXPqzFtb7IwR4h5ljta/AfLhM0vj1rtoFd3fsPDFTy2+m+W5U";
    font.crossOrigin = "anonymous";
    font.dataset.geist = "";
    document.head.append(font);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function comboOf(keys) {
    return keys === ESC ? "Esc" : keys;
  }

  function choiceKeys(choices, state) {
    if (state === "permission") {
      const order = ["yes", "always", "no"];
      return choices
        .filter((c) => order.includes(c.role))
        .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
        .map((c) => ({ word: ROLE_WORDS[c.role], combo: comboOf(c.keys), writes: [c.keys], title: c.label, primary: c.role === "yes", answers: true }));
    }
    return [
      ...choices.map((c) => ({ word: c.label, combo: String(c.number), writes: [c.keys], title: c.label, numbered: true, answers: true })),
      { word: "Cancel", combo: "Esc", writes: [ESC] },
    ];
  }

  function keysFor(now) {
    const agent = AGENTS[now?.agent];
    if (!agent) return { state: "", keys: [] };
    const fresh = !settling || (now.screen && now.screen !== settling.screen) || Date.now() - settling.at > SETTLE_MS;
    if (fresh) settling = null;
    const state = now.state;
    if (fresh && (state === "permission" || state === "question") && now.choices?.length) {
      return { state, keys: choiceKeys(now.choices, state) };
    }
    const own = fresh ? KEYS[agent][state] : null;
    return own ? { state, keys: own } : { state: "unknown", keys: [STOP] };
  }

  function keyHtml(k, i) {
    const label = k.numbered ? `${k.combo}. ${k.word}` : k.word;
    const aria = `${label}, sends ${k.combo}`;
    const cls = ["agent-key", k.primary ? "primary" : "", k.numbered ? "numbered" : ""].filter(Boolean).join(" ");
    const word = k.numbered ? `<span class="agent-key-num">${esc(k.combo)}</span><span class="agent-key-word">${esc(k.word)}</span>` : `<span class="agent-key-word">${esc(k.word)}</span><span class="agent-key-combo">${esc(k.combo)}</span>`;
    return `<button type="button" class="${cls}" data-agent-key="${i}" aria-label="${esc(aria)}" title="${esc(k.title || aria)}">${word}</button>`;
  }

  let current = [];

  function render() {
    const show = wanted();
    dock.classList.toggle("on", show);
    if (!show) return;
    const { state, keys } = keysFor(info);
    current = keys;
    const html = `${keys.length ? `<div class="agent-keys" data-state="${esc(state)}">${keys.map(keyHtml).join("")}</div>` : '<div class="agent-keys"></div>'}
      <button type="button" class="agent-key agent-type" data-compose aria-label="Type a message" title="Type a message, dictate it or attach a file">${TYPE_ICON}<span class="agent-key-word">Type</span></button>`;
    if (html === shownHtml) return;
    shownHtml = html;
    row.innerHTML = html;
    row.dataset.agent = AGENTS[info?.agent] || "";
    row.dataset.state = state;
  }

  let following = false;

  // A desktop pane never shows the row, so it never holds a socket open for it either.
  async function load() {
    if (!wanted()) return render();
    if (!following && window.YardbellLive) {
      following = true;
      window.YardbellLive.follow(load, 3000);
    }
    try {
      const res = await fetch(api, { headers: { Accept: "application/json" } });
      if (res.status === 401) { location.href = "/login"; return; }
      info = res.ok ? await res.json() : null;
    } catch {
      info = null;
    }
    render();
  }

  function write(bytes) {
    window.YardbellTerm?.send(bytes);
  }

  function press(k) {
    k.writes.forEach((bytes, i) => (i ? setTimeout(() => write(bytes), i * STEP_MS) : write(bytes)));
    if (k.answers || k === STOP) {
      settling = { screen: info?.screen || "", at: Date.now() };
      render();
    }
    setTimeout(() => fetch(api, { method: "POST", headers: { Accept: "application/json" } }).catch(() => {}), 400);
    setTimeout(render, SETTLE_MS + 50);
  }

  // The terminal keeps the keyboard: a press does not move the focus to the button.
  row.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) e.preventDefault();
  });
  row.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-compose")) {
      window.dispatchEvent(new CustomEvent("yardbell-compose", { detail: { open: true } }));
      return;
    }
    const k = current[Number(b.dataset.agentKey)];
    if (!k) return;
    b.classList.add("pressed");
    setTimeout(() => b.classList.remove("pressed"), 140);
    press(k);
  });

  // The terminal fits itself to the window only, so the row and the message box growing or
  // shrinking under it is passed on as a resize.
  let dockHeight = 0;
  new ResizeObserver(() => {
    const now = dock.offsetHeight;
    if (now === dockHeight) return;
    dockHeight = now;
    window.dispatchEvent(new Event("resize"));
  }).observe(dock);

  touch.addEventListener("change", load);
  window.addEventListener("resize", () => {
    if (wanted() !== dock.classList.contains("on")) load();
  });

  window.YardbellAgentKeys = { load, keys: () => current.map((k) => ({ word: k.word, combo: k.combo, writes: k.writes })) };
  render();
  load();
})();
