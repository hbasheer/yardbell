(function () {
  const KEY = "yardbell.side";
  const root = document.documentElement;
  const ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6 3v10"/></svg>';

  function railed() {
    try { return localStorage.getItem(KEY) === "rail"; } catch { return false; }
  }

  function paint(button) {
    const rail = root.classList.contains("side-rail");
    button.title = rail ? "Expand sidebar" : "Collapse sidebar";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!rail));
  }

  // In the rail only icons show, so each link keeps its words as a tooltip.
  function label(el) {
    if (!el.title) el.title = el.textContent.trim();
  }

  function initials(name) {
    const word = String(name).split("/").filter((w) => w && w !== "~").pop() || String(name);
    return word.slice(0, 2);
  }

  function set(rail, button) {
    root.classList.toggle("side-rail", rail);
    try {
      if (rail) localStorage.setItem(KEY, "rail");
      else localStorage.removeItem(KEY);
    } catch {}
    paint(button);
    window.dispatchEvent(new Event("resize"));
  }

  root.classList.toggle("side-rail", railed());
  document.addEventListener("DOMContentLoaded", () => {
    const head = document.querySelector(".side-head, .ws-side-head");
    if (!head) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn quiet icon-btn side-toggle";
    button.innerHTML = ICON;
    paint(button);
    button.addEventListener("click", () => set(!root.classList.contains("side-rail"), button));
    head.append(button);
    document.querySelectorAll(".side-link:not(.theme-toggle), .nav-add").forEach(label);
  });
  window.YardbellSide = { initials };
})();
