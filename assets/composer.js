import { html, nothing, render } from "/vendor/lit-html/lit-html.js";

const SEND_KEY = "yardbell.dispatch.send";
const DRAFTS_KEY = "yardbell.dispatch.drafts";
const HISTORY_KEY = "yardbell.dispatch.history";
const HISTORY_SIZE = 50;
const NAMES_FRESH = 15000;
const MENU_HEIGHT = 320;
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
const GROUPS = ["Machines", "Sessions", "Folders"];
// "/" and "@" open a menu only at the start of a word, so a path or an email address never does.
const TRIGGER = /(?:^|\s)(?:\/([^\s/]*)|@([^\s@]*))$/;

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function short(path) {
  return String(path ?? "").replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
}

function rank(query, label, ...more) {
  const name = label.toLowerCase();
  if (!query || name.startsWith(query)) return 0;
  if (name.split(/[\s/._-]+/).some((word) => word.startsWith(query))) return 1;
  if (name.includes(query)) return 2;
  return more.some((text) => String(text ?? "").toLowerCase().includes(query)) ? 3 : null;
}

// Dispatch's tools find a session by its tmux name and a folder by its label, so those are what
// gets typed in, with the machine added when the same name exists on more than one.
function nameList(state) {
  const twice = (list) => new Set(list.filter((x, i) => list.indexOf(x) !== i));
  const sessions = state.sessions.filter((s) => s.tmux && !s.stale);
  const sameSession = twice(sessions.map((s) => s.tmux));
  const sameFolder = twice(state.folders.map((f) => f.label));
  return [
    ...state.machines.map((m) => ({
      group: "Machines",
      label: m.name,
      detail: `Machine · ${m.up ? "up" : "down"}`,
      insert: m.name,
      also: [],
    })),
    ...sessions.map((s) => ({
      group: "Sessions",
      label: s.tmux,
      detail: [`${s.agent} on ${s.machine}`, short(s.folder), s.branch].filter(Boolean).join(" · "),
      insert: sameSession.has(s.tmux) ? `${s.tmux} on ${s.machine}` : s.tmux,
      also: [s.machine, s.folder, s.branch],
    })),
    ...state.folders.map((f) => {
      const outside = f.label.startsWith("/");
      return {
        group: "Folders",
        label: outside ? f.label.split("/").filter(Boolean).pop() || f.label : f.label,
        detail: [`on ${f.machine}`, f.branch, outside && short(f.path)].filter(Boolean).join(" · "),
        insert: sameFolder.has(f.label) ? `${f.label} on ${f.machine}` : f.label,
        also: [f.machine, f.path],
        outside,
      };
    }),
  ];
}

export function composer(form, hooks) {
  const input = form.text;
  const box = input.closest(".compose-box");
  const menuBox = document.getElementById("compose-menu");
  const sendButton = document.getElementById("dispatch-send");
  const hint = document.getElementById("send-key");
  const touch = window.matchMedia("(hover: none) and (pointer: coarse)");
  let mode = read(SEND_KEY, null) || (touch.matches ? "mod" : "enter");
  let key = "new";
  let menu = null;
  let dismissed = -1;
  let recall = null;
  let names = null;
  let namesAt = 0;
  let namesError = "";
  let loading = false;
  let frame = 0;

  function atBottom() {
    const s = hooks.scroller();
    return s.scrollHeight - s.scrollTop - s.clientHeight < 24;
  }

  function fit() {
    const pinned = atBottom();
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    sendButton.disabled = !input.value.trim();
    if (pinned) hooks.scrollDown();
  }

  function drafts() {
    const all = read(DRAFTS_KEY, {});
    return all && typeof all === "object" ? all : {};
  }

  function saveDrafts(all) {
    write(DRAFTS_KEY, Object.keys(all).length ? all : null);
  }

  function saveDraft() {
    const all = drafts();
    if (input.value.trim()) all[key] = input.value;
    else delete all[key];
    saveDrafts(all);
  }

  function showMode() {
    const enter = mode === "enter";
    hint.textContent = enter ? "Enter to send, Shift+Enter for a new line" : `${MOD}+Enter to send, Enter for a new line`;
    hint.title = enter ? `Send with ${MOD}+Enter instead, so Enter starts a new line` : "Send with Enter instead";
    input.enterKeyHint = enter ? "send" : "enter";
    sendButton.title = `Send (${enter ? "Enter" : `${MOD}+Enter`})`;
  }

  function kept() {
    const list = read(HISTORY_KEY, []);
    return Array.isArray(list) ? list.filter((t) => typeof t === "string" && t.trim()) : [];
  }

  function submit() {
    const text = input.value.trim();
    if (!text || !hooks.send(text)) return;
    write(HISTORY_KEY, [text, ...kept().filter((t) => t !== text)].slice(0, HISTORY_SIZE));
    input.value = "";
    recall = null;
    hide();
    saveDraft();
    fit();
  }

  function browsing() {
    return Boolean(recall) && input.value === (recall.index < 0 ? "" : recall.list[recall.index]);
  }

  // -1 is the empty box the browsing started from; 0 is the newest message.
  function recallAt(index) {
    if (!recall) recall = { list: [...new Set([...hooks.sent().slice().reverse(), ...kept()])], index: -1 };
    if (index < -1 || index >= recall.list.length) return;
    recall.index = index;
    input.value = index < 0 ? "" : recall.list[index];
    input.setSelectionRange(input.value.length, input.value.length);
    fit();
    saveDraft();
  }

  function loadNames() {
    if (loading) return;
    loading = true;
    hooks.state()
      .then((state) => {
        names = nameList(state);
        namesAt = Date.now();
        namesError = "";
      })
      .catch((err) => {
        namesError = `Could not look up machines: ${err.message}`;
      })
      .finally(() => {
        loading = false;
        if (menu?.kind === "name") fill();
      });
  }

  function fill() {
    const query = menu.query.toLowerCase();
    const found = menu.kind === "task"
      ? hooks.tasks().map((t) => ({ label: t.name, detail: t.text, insert: t.text, rank: rank(query, t.name, t.text) }))
      : (names || []).map((n) => ({ ...n, rank: rank(query, n.label, n.insert, ...n.also) }));
    menu.items = found
      .filter((item) => item.rank !== null)
      .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.rank - b.rank || Boolean(a.outside) - Boolean(b.outside));
    menu.active = Math.min(menu.active, Math.max(0, menu.items.length - 1));
    draw();
  }

  function trigger() {
    if (input.selectionStart !== input.selectionEnd) return null;
    const at = input.selectionStart;
    const next = input.value.charAt(at);
    if (next && !/\s/.test(next)) return null;
    const m = input.value.slice(0, at).match(TRIGGER);
    if (!m) return null;
    const query = m[1] ?? m[2];
    return { kind: m[1] !== undefined ? "task" : "name", query, start: at - query.length - 1, end: at };
  }

  function onCaret() {
    const found = trigger();
    if (!found) dismissed = -1;
    if (!found || found.start === dismissed) {
      hide();
      return;
    }
    const same = menu && menu.kind === found.kind && menu.start === found.start;
    menu = { ...found, items: [], active: same ? menu.active : 0, button: same && menu.button };
    if (menu.kind === "name" && (!names || Date.now() - namesAt > NAMES_FRESH)) loadNames();
    fill();
  }

  function hide() {
    if (!menu) return;
    menu = null;
    draw();
  }

  // A trigger the Tasks or @ button typed goes away again when the menu closes unused.
  function closeMenu(dismiss) {
    if (!menu) return;
    const char = menu.kind === "task" ? "/" : "@";
    if (menu.button && input.value.slice(menu.start, menu.end) === char) {
      input.setRangeText("", menu.start, menu.end, "end");
      fit();
      saveDraft();
    } else if (dismiss) {
      dismissed = menu.start;
    }
    hide();
  }

  function pick(i) {
    const item = menu?.items[i];
    if (!item) return;
    const space = /^\s/.test(input.value.slice(menu.end)) ? "" : " ";
    input.setRangeText(item.insert + space, menu.start, menu.end, "end");
    dismissed = -1;
    hide();
    fit();
    saveDraft();
  }

  function point(i) {
    if (!menu || menu.active === i) return;
    menu.active = i;
    draw();
  }

  function start(char) {
    const kind = char === "/" ? "task" : "name";
    if (menu?.button && menu.kind === kind) {
      closeMenu(false);
      return;
    }
    input.focus();
    const at = input.selectionStart;
    const lead = /(^|\s)$/.test(input.value.slice(0, at)) ? "" : " ";
    const trail = /^(\s|$)/.test(input.value.slice(input.selectionEnd)) ? "" : " ";
    input.setRangeText(lead + char + trail, at, input.selectionEnd, "end");
    const caret = at + lead.length + 1;
    input.setSelectionRange(caret, caret);
    dismissed = -1;
    onCaret();
    if (menu) menu.button = true;
    fit();
    saveDraft();
  }

  function menuKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
      return true;
    }
    if (!menu.items.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = menu.items.length;
      menu.active = (menu.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      draw();
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      pick(menu.active);
      return true;
    }
    return false;
  }

  function room() {
    const scroller = hooks.scroller();
    const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    return Math.max(96, Math.min(MENU_HEIGHT, Math.floor(box.getBoundingClientRect().top - top - 12)));
  }

  function reveal() {
    const el = menuBox.querySelector(".compose-option.active");
    if (!el) return;
    const top = menu.active === 0 ? 0 : el.offsetTop;
    const bottom = el.offsetTop + el.offsetHeight;
    if (top < menuBox.scrollTop) menuBox.scrollTop = top;
    else if (bottom > menuBox.scrollTop + menuBox.clientHeight) menuBox.scrollTop = bottom - menuBox.clientHeight;
  }

  function option(item, i) {
    const active = i === menu.active;
    return html`<div class="compose-option ${active ? "active" : ""}" role="option" id="compose-option-${i}" aria-selected=${active ? "true" : "false"}
      @mousedown=${(e) => e.preventDefault()} @mousemove=${() => point(i)} @click=${() => pick(i)}>
      <span class="compose-option-label">${item.label}</span>
      <span class="compose-option-detail">${item.detail}</span>
    </div>`;
  }

  function group(title, options) {
    return html`<div role="group" aria-label=${title}><div class="compose-menu-head" aria-hidden="true">${title}</div>${options}</div>`;
  }

  function menuView() {
    if (menu.kind === "task") {
      return menu.items.length
        ? group("Tasks", menu.items.map(option))
        : html`<p class="compose-menu-note">No tasks yet. Type one and press Save as task to keep it.</p>`;
    }
    if (!names) return html`<p class="compose-menu-note">${namesError || "Looking up machines, sessions and folders…"}</p>`;
    if (!menu.items.length) return html`<p class="compose-menu-note">No machines, sessions or folders yet.</p>`;
    return GROUPS.map((title) => {
      const options = menu.items.map((item, i) => (item.group === title ? option(item, i) : null)).filter(Boolean);
      return options.length ? group(title, options) : nothing;
    });
  }

  function draw() {
    const open = Boolean(menu) && (menu.items.length > 0 || !menu.query || (menu.kind === "name" && !names));
    menuBox.hidden = !open;
    if (open && menu.items.length) input.setAttribute("aria-activedescendant", `compose-option-${menu.active}`);
    else input.removeAttribute("aria-activedescendant");
    if (!open) {
      render(nothing, menuBox);
      return;
    }
    menuBox.setAttribute("aria-label", menu.kind === "task" ? "Tasks" : "Machines, sessions and folders");
    menuBox.style.maxHeight = `${room()}px`;
    render(menuView(), menuBox);
    reveal();
  }

  // iOS keeps the page as tall as the screen when the keyboard opens and only shrinks the visual
  // viewport, so the page is sized to that viewport to keep the composer above the keyboard.
  function fitViewport() {
    frame = 0;
    const vv = window.visualViewport;
    if (!vv || vv.scale > 1.01) return;
    const pinned = atBottom();
    const root = document.documentElement;
    const layout = root.clientHeight;
    root.style.setProperty("--vv-height", `${Math.round(vv.height)}px`);
    root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--vv-bottom", `${Math.max(0, Math.round(layout - vv.height - vv.offsetTop))}px`);
    root.classList.toggle("keyboard", layout - vv.height > 120);
    if (pinned) hooks.scrollDown();
    if (menu) draw();
  }

  function queueViewport() {
    if (!frame) frame = requestAnimationFrame(fitViewport);
  }

  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (menu && menuKey(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter") {
      if (mod || (mode === "enter" && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (mod || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowUp" && (browsing() || !input.value)) {
      e.preventDefault();
      if (!browsing()) recall = null;
      recallAt(recall ? recall.index + 1 : 0);
    } else if (e.key === "ArrowDown" && browsing() && recall.index >= 0) {
      e.preventDefault();
      recallAt(recall.index - 1);
    } else if (e.key === "Escape" && browsing() && recall.index >= 0) {
      e.preventDefault();
      recallAt(-1);
    }
  });

  input.addEventListener("input", () => {
    recall = null;
    fit();
    saveDraft();
    onCaret();
  });
  input.addEventListener("click", onCaret);
  input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) onCaret();
  });
  input.addEventListener("blur", () => closeMenu(false));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  for (const [id, char] of [["insert-task", "/"], ["insert-name", "@"]]) {
    const button = document.getElementById(id);
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => start(char));
  }

  hint.addEventListener("click", () => {
    mode = mode === "enter" ? "mod" : "enter";
    write(SEND_KEY, mode);
    showMode();
    input.focus();
  });

  window.visualViewport?.addEventListener("resize", queueViewport);
  window.visualViewport?.addEventListener("scroll", queueViewport);
  showMode();
  fitViewport();
  fit();

  return {
    show(id) {
      key = id || "new";
      recall = null;
      dismissed = -1;
      hide();
      const text = drafts()[key] || "";
      if (input.value !== text) input.value = text;
      fit();
    },
    adopt(id) {
      const all = drafts();
      delete all[key];
      saveDrafts(all);
      key = id;
      saveDraft();
    },
    keep(ids) {
      const all = drafts();
      for (const k of Object.keys(all)) if (k !== "new" && !ids.includes(k)) delete all[k];
      saveDrafts(all);
    },
  };
}
