(function () {
  const app = window.__TAURI__;
  const mac = /Mac/.test(navigator.platform);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let asked = 0;

  function ask(title, body, { confirm = "OK", danger = false } = {}) {
    const back = document.activeElement;
    const id = `confirm-${++asked}`;
    const dialog = document.createElement("dialog");
    dialog.className = "confirm";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    dialog.setAttribute("aria-describedby", `${id}-body`);
    dialog.innerHTML = `<h2 id="${id}-title">${esc(title)}</h2>
      <p id="${id}-body">${esc(body)}</p>
      <div class="dialog-actions">
        <button class="btn quiet" type="button" data-answer="no">Cancel</button>
        <button class="btn ${danger ? "danger-solid" : "primary"}" type="button" data-answer="yes">${esc(confirm)}</button>
      </div>`;
    document.body.append(dialog);
    return new Promise((resolve) => {
      const finish = (yes) => {
        if (!dialog.isConnected) return;
        dialog.close();
        dialog.remove();
        if (back instanceof HTMLElement && back.isConnected) back.focus();
        resolve(yes);
      };
      dialog.addEventListener("click", (e) => {
        const answer = e.target.closest("[data-answer]");
        if (answer) finish(answer.dataset.answer === "yes");
      });
      dialog.addEventListener("close", () => finish(false));
      dialog.showModal();
      dialog.querySelector('[data-answer="no"]').focus();
    });
  }

  function appKey(e) {
    if (!app || e.altKey) return "";
    const held = mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && !e.metaKey;
    return held ? e.key.toLowerCase() : "";
  }

  function tabKey(e) {
    if (!app || e.altKey) return "";
    if (e.key === "Tab") return e.ctrlKey && !e.metaKey ? (e.shiftKey ? "tab-prev" : "tab-next") : "";
    const key = appKey(e);
    return /^[1-9]$/.test(key) ? `tab-${key}` : "";
  }

  let build = "";

  function checkBuild(res) {
    const next = res.headers.get("x-yardbell-build");
    if (!next) return;
    if (!build) build = next;
    else if (next !== build && !document.querySelector("dialog[open]")) location.reload();
  }

  if (app) {
    document.addEventListener("keydown", (e) => {
      const tab = tabKey(e);
      if (tab) {
        e.preventDefault();
        app.event.emit("shortcut", tab).catch(() => {});
        return;
      }
      const key = appKey(e);
      if (key !== "w" && key !== "q") return;
      // Cmd/Ctrl-W never closed the Workspace window before this listener moved here, so it still does not.
      if (key === "w" && document.body.dataset.page === "workspace") return;
      e.preventDefault();
      if (!e.repeat) app.event.emit("shortcut", key === "w" ? "close" : "quit").catch(() => {});
    });
  }

  const helpers = { confirm: ask, appKey, tabKey, checkBuild };
  const main = document.getElementById("main");
  // Pages still on the old sidebar have no #main, and Dispatch inside a Workspace pane draws no
  // second shell; both load this file for the helpers only.
  if (!main || (window.top !== window.self && document.body.dataset.page === "dispatch")) {
    window.YardbellShell = helpers;
    return;
  }

  const svg = (body, box = 16, style = "") => `<svg class="icon" viewBox="0 0 ${box} ${box}" aria-hidden="true"${style}>${body}</svg>`;
  const ICONS = {
    dashboard: svg('<path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5"/>'),
    workspace: svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M8 3v10M8 8h5.5"/>'),
    pipeline: svg('<circle cx="3.5" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="12.5" cy="8" r="1.5"/><path d="M5 8h1.5M9.5 8H11"/>'),
    diagrams: svg('<rect x="5.5" y="2" width="5" height="3.5" rx="1"/><rect x="1.5" y="10.5" width="5" height="3.5" rx="1"/><rect x="9.5" y="10.5" width="5" height="3.5" rx="1"/><path d="M8 5.5V8M4 10.5V8h8v2.5"/>'),
    dispatch: svg('<path d="M2.5 4.5h11v6h-6l-3 2.5v-2.5h-2z"/>'),
    proposals: svg('<path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11z"/><path d="M2.5 9.5h3.5l.5 1.5h3l.5-1.5h3.5"/>'),
    settings: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', 24, ' style="stroke-width:2.3"'),
    board: svg('<rect x="2" y="3" width="3.5" height="10" rx="1"/><rect x="6.25" y="3" width="3.5" height="7" rx="1"/><rect x="10.5" y="3" width="3.5" height="8.5" rx="1"/>'),
    usage: svg('<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>'),
    cup: svg('<path d="M3 6.5h8v3.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM11 7.5h1a1.5 1.5 0 0 1 0 3h-1.2M5.5 2.5v1.8M8.5 2.5v1.8"/>'),
    plug: svg('<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/>'),
    more: svg('<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>'),
    side: svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6 3v10"/>'),
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
    logout: svg('<path d="M6.5 3H3.5v10h3M10 5l3 3-3 3M13 8H6.5"/>'),
  };
  const PAGES = [
    { page: "dashboard", name: "Dashboard", href: "/", count: "dashboard" },
    { page: "workspace", name: "Workspace", href: "/workspace" },
    { page: "pipeline", name: "Pipelines", href: "/pipeline", count: "pipelines" },
    { page: "diagrams", name: "Diagrams", href: "/diagrams" },
    { page: "dispatch", name: "Dispatch", href: "/dispatch" },
    { page: "proposals", name: "Proposals", href: "/proposals", count: "proposals" },
    { page: "settings", name: "Settings", href: "/settings" },
  ];
  const TABS = [
    { page: "workspace", name: "Sessions", href: "/workspace", icon: "workspace" },
    { page: "dashboard", name: "Board", href: "/?view=board", icon: "board", count: "dashboard" },
    { page: "pipeline", name: "Pipelines", href: "/pipeline", icon: "pipeline", count: "pipelines" },
    { page: "dispatch", name: "Dispatch", href: "/dispatch", icon: "dispatch" },
  ];
  const MORE = ["diagrams", "proposals", "settings"];
  const key = mac ? "⌘K" : "Ctrl+K";
  const columnless = document.body.dataset.column === "none";
  const here = document.body.dataset.page;
  const current = (page) => (page === here ? ' aria-current="page"' : "");
  const count = (name) => (name ? `<span class="rail-count" data-count="${name}" hidden></span>` : "");
  const title = PAGES.find((p) => p.page === here)?.name || "";

  const search = `<button class="col-search" id="col-search" type="button" aria-label="Jump to (${key})" title="Jump to (${key})">${ICONS.search}<span class="col-search-label">Search</span><kbd class="col-search-key">${key}</kbd></button>`;
  const section = ["workspace", "dashboard"].includes(here) ? "Machines" : title;
  const navLink = (p) => `<a class="col-nav-link" data-page="${p.page}" href="${p.href}"${current(p.page)}>${ICONS[p.page]}<span class="col-nav-name">${p.name}</span>${count(p.count)}</a>`;

  const shell = document.createElement("div");
  shell.className = "shell";
  shell.id = "shell";
  shell.innerHTML = `
    <nav class="rail" id="rail" aria-label="Pages">
      ${columnless ? search : ""}
      ${PAGES.map((p) => `<a class="rail-link" data-page="${p.page}" href="${p.href}" title="${p.name}" aria-label="${p.name}"${current(p.page)}>${ICONS[p.page]}${count(p.count)}</a>`).join("")}
      <span class="rail-gap"></span>
      <button class="rail-link" type="button" data-theme-toggle></button>
      <button class="rail-link" id="logout" type="button" title="Log out" aria-label="Log out" data-logout>${ICONS.logout}</button>
    </nav>
    ${columnless ? "" : `<aside class="col" id="col" aria-label="${title}">
      <div class="col-brand" id="col-brand"><button class="btn quiet icon-btn" id="col-toggle" type="button">${ICONS.side}</button><a class="col-app" href="/">Yardbell</a></div>
      <div class="col-search-row" id="col-search-row">${search}</div>
      <nav class="col-nav" aria-label="Pages">${PAGES.filter((p) => p.page !== "settings").map(navLink).join("")}</nav>
      <header class="col-head" id="col-head">
        <h1 class="col-title">${section}</h1>
      </header>
      <div class="col-body" id="col-body"></div>
      <footer class="col-foot">
        <a class="col-foot-link" data-page="settings" href="/settings" title="Settings" aria-label="Settings"${current("settings")}>${ICONS.settings}</a>
        <button class="col-foot-link" type="button" data-theme-toggle></button>
        <button class="col-foot-link" type="button" title="Log out" aria-label="Log out" data-logout>${ICONS.logout}</button>
      </footer>
    </aside>`}`;
  main.before(shell);
  shell.append(main);

  const tabbar = document.createElement("nav");
  tabbar.className = "tabbar";
  tabbar.id = "tabbar";
  tabbar.setAttribute("aria-label", "Pages");
  tabbar.innerHTML = `
    ${TABS.map((t) => `<a class="tab" data-page="${t.page}" href="${t.href}"${current(t.page)}>${ICONS[t.icon]}<span class="tab-label">${t.name}</span>${count(t.count)}</a>`).join("")}
    <button class="tab" id="tab-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="tab-menu"${MORE.includes(here) ? ' aria-current="page"' : ""}>${ICONS.more}<span class="tab-label">More</span>${count("proposals")}</button>
    <div class="menu tab-menu" id="tab-menu" role="menu" hidden>
      <button role="menuitem" type="button" data-search>${ICONS.search}<span class="menu-label">Search</span></button>
      ${PAGES.filter((p) => MORE.includes(p.page)).map((p) => `<a role="menuitem" href="${p.href}"${current(p.page)}>${ICONS[p.page]}<span class="menu-label">${p.name}</span>${count(p.count)}</a>`).join("")}
      <button role="menuitem" type="button" data-usage-open>${ICONS.usage}<span class="menu-label">Usage</span></button>
      <button role="menuitem" type="button" data-status-open="awake">${ICONS.cup}<span class="menu-label">Keep computer awake</span><span class="menu-note" data-status-count="awake"></span></button>
      <button role="menuitem" type="button" data-status-open="ports">${ICONS.plug}<span class="menu-label">Live ports</span><span class="menu-note" data-status-count="ports">0</span></button>
      <button role="menuitem" type="button" data-theme-toggle></button>
      <button role="menuitem" type="button" data-logout>${ICONS.logout}<span class="menu-label">Log out</span></button>
    </div>`;
  shell.after(tabbar);

  const more = tabbar.querySelector("#tab-more");
  const menu = tabbar.querySelector("#tab-menu");

  function showMore(open, refocus = false) {
    menu.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("[role=menuitem]").focus();
    else if (refocus) more.focus();
  }

  more.addEventListener("click", () => showMore(menu.hidden));
  menu.querySelector("[data-search]").addEventListener("click", () => {
    showMore(false, true);
    window.YardbellPalette?.open();
  });
  menu.querySelector("[data-usage-open]").addEventListener("click", () => {
    showMore(false);
    window.YardbellUsage?.open(more);
  });
  menu.querySelectorAll("[data-status-open]").forEach((item) => item.addEventListener("click", () => {
    showMore(false);
    window.YardbellStrip?.open(item.dataset.statusOpen, more);
  }));
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !tabbar.contains(e.target)) showMore(false);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) showMore(false, true);
  });

  document.querySelectorAll("[data-logout]").forEach((b) => {
    b.hidden = Boolean(window.__TAURI__);
    b.addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" }).catch(() => {});
      location.href = "/login";
    });
  });

  const handlers = [];
  shell.addEventListener("click", (e) => {
    const link = e.target.closest("a.rail-link, a.col-nav-link");
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (handlers.some((h) => h(link.dataset.page, e))) e.preventDefault();
  });

  const SIDE_KEY = "yardbell.side";
  const toggle = shell.querySelector("#col-toggle");
  const searchButton = shell.querySelector("#col-search");
  const rail = shell.querySelector("#rail");
  const head = shell.querySelector("#col-head");
  const phone = matchMedia("(max-width: 760px)");

  function collapsed() {
    return document.documentElement.classList.contains("side-rail");
  }

  // A phone hides the rail and ignores a stored collapse, so the buttons stay in the column there.
  function paintToggle() {
    if (!toggle) return;
    const off = collapsed();
    toggle.title = off ? "Expand sidebar" : "Collapse sidebar";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!off));
    const focused = document.activeElement;
    if (off && !phone.matches) {
      rail.prepend(toggle, searchButton);
    } else {
      shell.querySelector("#col-brand").prepend(toggle);
      shell.querySelector("#col-search-row").append(searchButton);
    }
    if (focused === toggle || focused === searchButton) focused.focus();
  }

  function collapse(on, { keep = true } = {}) {
    on = Boolean(on);
    if (on === collapsed()) return;
    document.documentElement.classList.toggle("side-rail", on);
    if (keep) {
      try {
        if (on) localStorage.setItem(SIDE_KEY, "rail");
        else localStorage.removeItem(SIDE_KEY);
      } catch {}
    }
    paintToggle();
    window.dispatchEvent(new CustomEvent("yardbell-shell", { detail: { collapsed: on, kept: keep } }));
    window.dispatchEvent(new Event("resize"));
  }

  try {
    document.documentElement.classList.toggle("side-rail", localStorage.getItem(SIDE_KEY) === "rail");
  } catch {}
  paintToggle();
  phone.addEventListener("change", paintToggle);
  toggle?.addEventListener("click", () => collapse(!collapsed()));

  // The key is the one the old sidebar used, so a width picked before keeps applying.
  const WIDTH = { key: "yardbell.side.width", min: 220, normal: 256, max: 480 };
  const col = shell.querySelector("#col");
  if (col && document.body.dataset.columnMode !== "settings") {
    const edge = document.createElement("div");
    edge.className = "col-edge";
    edge.id = "col-edge";
    edge.tabIndex = 0;
    edge.title = "Drag to resize. Double-click to reset.";
    for (const [k, v] of Object.entries({ role: "separator", "aria-orientation": "vertical", "aria-label": "Resize sidebar", "aria-controls": "col", "aria-valuemin": WIDTH.min, "aria-valuemax": WIDTH.max })) edge.setAttribute(k, v);
    col.append(edge);
    const setWidth = (px, keep) => {
      const w = Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, px)));
      document.documentElement.style.setProperty("--side-width", `${w}px`);
      edge.setAttribute("aria-valuenow", w);
      if (!keep) return;
      try {
        if (w === WIDTH.normal) localStorage.removeItem(WIDTH.key);
        else localStorage.setItem(WIDTH.key, String(w));
      } catch {}
    };
    const width = () => col.getBoundingClientRect().width;
    edge.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = e.clientX;
      const from = width();
      edge.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev) => setWidth(from + ev.clientX - start, false);
      const done = () => {
        edge.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing");
        setWidth(width(), true);
        window.dispatchEvent(new Event("resize"));
      };
      edge.addEventListener("pointermove", move);
      edge.addEventListener("pointerup", done, { once: true });
      edge.addEventListener("pointercancel", done, { once: true });
    });
    edge.addEventListener("dblclick", () => setWidth(WIDTH.normal, true));
    edge.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: -20, ArrowRight: 20 }[e.key];
      if (!step) return;
      e.preventDefault();
      setWidth(width() + step, true);
    });
    let saved = 0;
    try { saved = Number(localStorage.getItem(WIDTH.key)); } catch {}
    setWidth(saved || WIDTH.normal, false);
  }

  function pressed(page, on) {
    shell.querySelectorAll(`:is(.rail-link, .col-nav-link)[data-page="${page}"]`).forEach((link) => link.setAttribute("aria-pressed", String(Boolean(on))));
  }

  searchButton.addEventListener("click", () => window.YardbellPalette?.open());

  function badge(name, n) {
    document.querySelectorAll(`[data-count="${name}"]`).forEach((el) => {
      el.textContent = n ? String(n) : "";
      el.hidden = !n;
      el.parentElement.classList.toggle("has-waiting", Boolean(n));
    });
  }

  const column = shell.querySelector("#col-body");

  async function loadState() {
    const res = await fetch("/state", { headers: { Accept: "application/json" } });
    if (res.status === 401) {
      location.href = "/login";
      return null;
    }
    if (!res.ok) return null;
    checkBuild(res);
    const state = await res.json();
    window.YardbellShell.update(state);
    return state;
  }

  // Column rows that jump to a section of the page mark the section in view. The jump scrolls the
  // page too, so a clicked row holds until the person scrolls by hand: a section near the end
  // never reaches the top, and following that scroll would mark the one above it.
  function spy() {
    if (!column) return () => {};
    let current = "";
    let held = false;
    const rows = () => [...column.querySelectorAll('a.col-row[href^="#"]')];
    const target = (row) => document.getElementById(decodeURIComponent(row.hash.slice(1)));

    function mark() {
      if (!held) {
        const line = main.getBoundingClientRect().top + 24;
        const live = rows().filter(target);
        current = (live.filter((r) => target(r).getBoundingClientRect().top <= line).pop() || live[0])?.hash || "";
      }
      for (const row of rows()) {
        if (row.hash === current) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
      }
    }

    column.addEventListener("click", (e) => {
      const row = e.target.closest('a.col-row[href^="#"]');
      if (!row || !target(row)) return;
      e.preventDefault();
      held = true;
      current = row.hash;
      target(row).scrollIntoView({ block: "start" });
      mark();
    });
    const release = () => { held = false; };
    for (const type of ["wheel", "touchstart", "pointerdown"]) main.addEventListener(type, release, { passive: true });
    document.addEventListener("keydown", release);
    main.addEventListener("scroll", mark, { passive: true });
    return mark;
  }

  window.YardbellShell = {
    ...helpers,
    column,
    head: shell.querySelector("#col-head"),
    lastState: null,
    stateOf: null,
    update(state) {
      this.lastState = state;
      badge("proposals", state.proposals || 0);
      badge("dashboard", (state.problems || []).length);
      window.YardbellStrip?.update(state);
    },
    badge,
    loadState,
    spy,
    collapsed,
    collapse,
    pressed,
    onRail(handler) {
      handlers.push(handler);
    },
  };
})();
