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

  // The sidebar has one width on every page: set it before the page draws, so it never jumps.
  const WIDTH = { key: "yardbell.side.width", min: 220, normal: 256, max: 480 };
  let kept = 0;
  try { kept = Number(localStorage.getItem(WIDTH.key)); } catch {}
  root.style.setProperty("--side-width", `${Math.min(WIDTH.max, Math.max(WIDTH.min, kept || WIDTH.normal))}px`);

  // The sidebar and the Workspace's Dispatch panel drag wider or narrower from their right edge.
  function resizable({ handle, panel, prop, key, min, normal, max }) {
    const set = (width, keep) => {
      const w = Math.round(Math.min(max, Math.max(min, width)));
      root.style.setProperty(prop, `${w}px`);
      handle.setAttribute("aria-valuenow", w);
      if (!keep) return;
      try {
        if (w === normal) localStorage.removeItem(key);
        else localStorage.setItem(key, String(w));
      } catch {}
    };
    const width = () => panel.getBoundingClientRect().width;
    handle.setAttribute("aria-valuemin", min);
    handle.setAttribute("aria-valuemax", max);
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = e.clientX;
      const from = width();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev) => set(from + ev.clientX - start, false);
      const done = () => {
        handle.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing");
        set(width(), true);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done, { once: true });
      handle.addEventListener("pointercancel", done, { once: true });
    });
    handle.addEventListener("dblclick", () => set(normal, true));
    handle.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: -20, ArrowRight: 20 }[e.key];
      if (!step) return;
      e.preventDefault();
      set(width() + step, true);
    });
    let saved = 0;
    try { saved = Number(localStorage.getItem(key)); } catch {}
    set(saved || normal, false);
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
    const side = head.closest(".side, .ws-side");
    if (!side || document.documentElement.classList.contains("embedded")) return;
    const edge = document.createElement("div");
    edge.className = "resize-edge side-edge";
    edge.setAttribute("role", "separator");
    edge.setAttribute("aria-orientation", "vertical");
    edge.setAttribute("aria-label", "Resize the sidebar");
    edge.tabIndex = 0;
    edge.title = "Drag to resize. Double-click to reset.";
    side.append(edge);
    resizable({ handle: edge, panel: side, prop: "--side-width", ...WIDTH });
  });
  window.YardbellSide = { initials, resizable };
})();
