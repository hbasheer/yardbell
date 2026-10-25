(function () {
  const KEY = "yardbell.theme";
  const TERM_KEY = "yardbell.termTheme";
  const root = document.documentElement;
  const systemDark = matchMedia("(prefers-color-scheme: dark)");

  function chosen() {
    try {
      const t = localStorage.getItem(KEY);
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  }

  function terminalChosen() {
    try {
      const t = localStorage.getItem(TERM_KEY);
      return t === "light" || t === "dark" ? t : "app";
    } catch {
      return "app";
    }
  }

  function appShown(t) {
    return t === "system" ? (systemDark.matches ? "dark" : "light") : t;
  }

  function terminalShown() {
    const t = terminalChosen();
    return t === "app" ? appShown(chosen()) : t;
  }

  // The terminal page is all terminal, so its own buttons and bars follow the terminal's colours.
  function shown(t) {
    return root.dataset.termPage !== undefined ? terminalShown() : appShown(t);
  }

  // The apps draw their own bars and tab strip, so they are told too. A terminal inside a
  // Workspace pane is not the page the user sees, so it stays quiet.
  function tellApps(t) {
    if (window.top !== window) return;
    try { window.YardbellApp?.theme(shown(t)); } catch {}
    try { window.__TAURI__?.app?.setTheme?.(t === "system" ? null : t)?.catch?.(() => {}); } catch {}
    try { window.__TAURI__?.event?.emit("term-theme", terminalShown())?.catch?.(() => {}); } catch {}
  }

  function apply(t) {
    if (root.dataset.termPage !== undefined) root.dataset.theme = terminalShown();
    else if (t === "system") delete root.dataset.theme;
    else root.dataset.theme = t;
    const term = terminalShown();
    if (root.dataset.term !== term) {
      root.dataset.term = term;
      window.dispatchEvent(new CustomEvent("yardbell-term-theme", { detail: term }));
    }
    tellApps(t);
  }

  function set(t) {
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {}
    apply(t);
  }

  function setTerminal(t) {
    try {
      if (t === "app") localStorage.removeItem(TERM_KEY);
      else localStorage.setItem(TERM_KEY, t);
    } catch {}
    apply(chosen());
  }

  const NEXT = { system: "light", light: "dark", dark: "system" };
  const WORDS = { system: "Auto theme", light: "Light theme", dark: "Dark theme" };
  const ICONS = {
    system: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/></svg>',
    light: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
    dark: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z"/></svg>',
  };

  // Every page's sidebar has a theme button, so switching is one click away.
  function paintButtons() {
    const t = chosen();
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.innerHTML = `${ICONS[t]}<span class="theme-word">${WORDS[t]}</span>`;
      b.title = `${WORDS[t]}. Click for ${WORDS[NEXT[t]].toLowerCase()}`;
      b.setAttribute("aria-label", b.title);
    });
    document.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === t; });
    const term = terminalChosen();
    document.querySelectorAll('input[name="term-theme"]').forEach((input) => { input.checked = input.value === term; });
  }

  function cycle() {
    set(NEXT[chosen()]);
    paintButtons();
  }

  apply(chosen());
  systemDark.addEventListener("change", () => apply(chosen()));
  // Terminals in Workspace panes are separate pages, and hear about a change made elsewhere this way.
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY && e.key !== TERM_KEY) return;
    apply(chosen());
    paintButtons();
  });
  document.addEventListener("DOMContentLoaded", () => {
    paintButtons();
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", cycle));
  });
  window.YardbellTheme = {
    chosen,
    set: (t) => { set(t); paintButtons(); },
    terminal: terminalShown,
    terminalChosen,
    setTerminal: (t) => { setTerminal(t); paintButtons(); },
  };
})();
