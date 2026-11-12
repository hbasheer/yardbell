const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
const setup = parts[1] === "_onboarding";
const nameEl = document.getElementById("name");
if (setup) {
  nameEl.innerHTML = "<strong>Machine setup</strong>";
  document.title = "Machine setup · Yardbell";
} else {
  nameEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = parts[2] || "";
  const span = document.createElement("span");
  span.textContent = ` on ${parts[1] || ""}`;
  nameEl.append(strong, span);
  document.title = `${parts[2]} on ${parts[1]} · Yardbell`;
}
const embedded = new URLSearchParams(location.search).has("embed");
document.body.classList.toggle("embedded", embedded);

const FONT = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
const THEMES = {
  dark: {
    background: "#2a2c33",
    foreground: "#f2f2f2",
    cursor: "#ffffff",
    cursorAccent: "#2a2c33",
    selectionBackground: "#5a7898",
    selectionForeground: "#ffffff",
    black: "#1d1f21",
    red: "#e06c75",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#81a2be",
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#c5c8c6",
    brightBlack: "#7f848e",
    brightRed: "#ef7a7f",
    brightGreen: "#b9ca4a",
    brightYellow: "#e7c547",
    brightBlue: "#7aa6da",
    brightMagenta: "#c397d8",
    brightCyan: "#70c0b1",
    brightWhite: "#eaeaea",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#2563eb",
    cursorAccent: "#ffffff",
    selectionBackground: "#bfdbfe",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};
// Agents that assume a dark terminal paint pale text, which the light theme darkens until it reads.
const CONTRAST = { dark: 1, light: 4.5 };
const shade = () => window.YardbellTheme?.terminal() === "light" ? "light" : "dark";
const coarse = matchMedia("(pointer: coarse)");
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20];
const FONT_KEY = "yardbell.term.fontSize";

function storedFont() {
  try {
    const size = Number(localStorage.getItem(FONT_KEY));
    return FONT_SIZES.includes(size) ? size : 0;
  } catch {
    return 0;
  }
}

const term = new Terminal({
  cursorBlink: true,
  fontFamily: FONT,
  fontSize: storedFont() || (coarse.matches ? 13 : 14),
  letterSpacing: 0,
  lineHeight: 1.15,
  scrollback: 5000,
  theme: THEMES[shade()],
  minimumContrastRatio: CONTRAST[shade()],
});
window.addEventListener("yardbell-term-theme", () => {
  term.options.theme = THEMES[shade()];
  term.options.minimumContrastRatio = CONTRAST[shade()];
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

const RETRY = [1000, 2000, 5000, 10000];
let socket = null;
let attempt = 0;
let ended = false;

function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function sendInput(data) {
  const key = modsHeld() ? typedKey(data) : null;
  if (key) {
    data = encodeKey(key, heldMods());
    releaseMods();
  }
  send({ t: "in", d: data });
}

// The server lets only the terminal in use set the session's size. A hidden Workspace tab sits
// in a zero-sized frame, so it must not pull the agent's screen down to its size.
let shown = null;
let appAway = false;

function reportView() {
  const now = !appAway && document.visibilityState === "visible" && window.innerWidth > 0 && window.innerHeight > 0;
  if (now === shown) return;
  shown = now;
  send({ t: "view", on: now });
}

let sentSize = "";

function sendSize() {
  const size = `${term.rows}x${term.cols}`;
  if (size === sentSize) return;
  sentSize = size;
  send({ t: "resize", rows: term.rows, cols: term.cols });
}

function resize() {
  if (!term.element) return;
  if (touchUi()) {
    refit();
    return;
  }
  fit.fit();
  sentSize = "";
  sendSize();
  reportView();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}${location.pathname}/ws`);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    attempt = 0;
    document.getElementById("banner").style.display = "none";
    shown = null;
    sentSize = "";
    resize();
  };
  socket.onmessage = (e) => {
    if (typeof e.data === "string") {
      const frame = JSON.parse(e.data);
      if (frame.t === "exit") {
        ended = true;
        term.write(`\r\n\x1b[33m[${frame.msg}]\x1b[0m\r\n`);
      }
      return;
    }
    term.write(new Uint8Array(e.data));
  };
  socket.onclose = () => {
    if (ended) return;
    document.getElementById("banner").style.display = "inline";
    setTimeout(connect, RETRY[Math.min(attempt++, RETRY.length - 1)]);
  };
}

const app = window.__TAURI__;
const mac = /Mac/.test(navigator.platform);
let appClipboard = Boolean(app?.clipboardManager);
let pending = "";
let noticeTimer = 0;

function notice(text, { offer = "", ms = offer ? 8000 : 1600 } = {}) {
  const el = document.getElementById("notice");
  document.getElementById("notice-text").textContent = text;
  el.classList.toggle("ask", Boolean(offer));
  const sheet = document.getElementById("more-sheet");
  const above = document.getElementById(sheet.hidden ? "term-bottom" : "more-sheet");
  el.style.bottom = touchUi() ? `${Math.round(innerHeight - above.getBoundingClientRect().top + 12)}px` : "";
  el.classList.add("show");
  pending = offer;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// Selecting the textarea takes the focus from the terminal, so it is handed back afterwards.
function copyNow(text) {
  const back = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  // select() alone selects nothing on iOS.
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
  back?.focus({ preventScroll: true });
  return ok;
}

async function copy(text) {
  if (!text) return;
  if (appClipboard) {
    try {
      await app.clipboardManager.writeText(text);
      notice("Copied");
      return;
    } catch {
      // Once refused, stop awaiting it: the await moves the fallback copy out of the click that allows it.
      appClipboard = false;
    }
  }
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  }
  // tmux sends a copy to every viewer of the pane, and only the one in use may take the focus for
  // the fallback: the desktop app gives the keyboard to a hidden page that does.
  if (!ok && document.hasFocus()) ok = copyNow(text);
  if (ok) notice("Copied");
  else notice("Selection ready", { offer: text });
}

function decodeBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

term.parser.registerOscHandler(52, (data) => {
  const b64 = data.slice(data.indexOf(";") + 1);
  if (!b64 || b64 === "?") return true;
  try { copy(decodeBase64(b64)); } catch {}
  return true;
});

document.getElementById("term").addEventListener("mouseup", () => {
  if (!sel.on && term.hasSelection()) copy(term.getSelection());
});

document.getElementById("notice-copy").addEventListener("click", () => {
  if (copyNow(pending)) notice("Copied");
  else notice("Couldn't copy. Use Copy text to select it.", { ms: 5000 });
  focusShown();
});

function screenText() {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\s+$/, "");
}

const textView = document.getElementById("text-view");
const textCopy = document.getElementById("text-copy");
const textShown = () => textView.classList.contains("show");

// Keys go to what is on screen, never to the terminal under the screen text, where Esc would stop
// the agent.
function focusShown() {
  if (textShown()) textCopy.focus();
  else term.focus();
}

function showText() {
  closeMore();
  endSelection();
  document.getElementById("text-body").textContent = screenText();
  textView.classList.add("show");
  focusShown();
}

function closeText() {
  textView.classList.remove("show");
  term.focus();
}

document.getElementById("text-btn").addEventListener("click", showText);
document.getElementById("text-close").addEventListener("click", closeText);
textCopy.addEventListener("click", () => {
  if (!copyNow(document.getElementById("text-body").textContent)) {
    notice("Couldn't copy. Select the text and copy it.", { ms: 5000 });
    return;
  }
  closeText();
  notice("Copied");
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !textShown()) return;
  e.preventDefault();
  e.stopPropagation();
  closeText();
}, true);

async function paste() {
  try {
    const text = await app.clipboardManager.readText();
    if (text) term.paste(text);
    else notice("Nothing to paste");
  } catch {
    notice("Can't read the clipboard");
  }
}

function appKey(e) {
  if (e.altKey) return "";
  const held = mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
  return held ? e.key.toLowerCase() : "";
}

function tabKey(e) {
  if (e.altKey) return "";
  if (e.key === "Tab") return e.ctrlKey && !e.metaKey ? (e.shiftKey ? "tab-prev" : "tab-next") : "";
  const held = mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && !e.metaKey && !e.shiftKey;
  return held && /^[1-9]$/.test(e.key) ? `tab-${e.key}` : "";
}

if (app) {
  term.attachCustomKeyEventHandler((e) => {
    if (tabKey(e)) return false;
    const key = appKey(e);
    const copying = key === "c" && term.hasSelection();
    if (!copying && key !== "v") return true;
    e.preventDefault();
    if (e.type === "keydown") {
      if (copying) copy(term.getSelection());
      else paste();
    }
    return false;
  });
  document.addEventListener("keydown", (e) => {
    const tab = tabKey(e);
    if (tab) {
      e.preventDefault();
      app.event.emit("shortcut", tab).catch(() => {});
      return;
    }
    const key = appKey(e);
    if (key !== "w" && key !== "q") return;
    e.preventDefault();
    if (!e.repeat) app.event.emit("shortcut", key === "w" ? "close" : "quit").catch(() => {});
  });
}

term.onData(sendInput);
window.addEventListener("resize", () => (touchUi() ? queueSettle() : resize()));
document.addEventListener("visibilitychange", reportView);
window.addEventListener("focus", () => send({ t: "focus" }));
document.getElementById("term").addEventListener("pointerdown", () => send({ t: "focus" }));

// The phone app says when it goes to the background, which its web view does not report itself.
function appState(state) {
  appAway = state === "background";
  reportView();
  if (!appAway && shown) send({ t: "focus" });
}
window.addEventListener("yardbell-app", (e) => appState(e.detail));
window.addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data?.yardbell === "app") appState(e.data.state);
});

const termEl = document.getElementById("term");
let scrollQueued = 0;
let scrollTimer = 0;

function scrollLines(lines) {
  if (!lines) return;
  scrollQueued += lines;
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = 0;
    if (scrollQueued) send({ t: "scroll", lines: scrollQueued });
    scrollQueued = 0;
  }, 40);
}

function lineHeight() {
  const screen = term.element?.querySelector(".xterm-screen");
  return screen && term.rows ? screen.clientHeight / term.rows : 16;
}

// tmux draws on the alternate screen, where xterm.js has no scrollback: a swipe would do
// nothing and the wheel would send arrow keys to the agent. Both scroll tmux's history instead.
const touch = { y: 0, t: 0, v: 0, rest: 0, glide: 0, x0: 0, y0: 0, t0: 0, moved: false, press: 0, selecting: false, el: null };
const LONG_PRESS = 450;
const TAP_SLOP = 8;

function drag(px) {
  touch.rest += px;
  const h = lineHeight();
  const lines = Math.trunc(touch.rest / h);
  if (!lines) return;
  touch.rest -= lines * h;
  scrollLines(-lines);
}

// xterm.js replaces row elements as the screen redraws, and touch events keep going to the
// element the finger first landed on even once it is detached, so they never bubble up here.
function touchMove(e) {
  if (e.touches.length !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  const p = e.touches[0];
  if (!touch.moved && Math.hypot(p.clientX - touch.x0, p.clientY - touch.y0) > TAP_SLOP) {
    touch.moved = true;
    clearTimeout(touch.press);
  }
  if (touch.selecting) {
    dragSelection(p.clientX, p.clientY);
    return;
  }
  const y = p.clientY;
  const dy = y - touch.y;
  touch.v = dy / Math.max(1, e.timeStamp - touch.t);
  touch.y = y;
  touch.t = e.timeStamp;
  drag(dy);
}

function touchEnd(e) {
  const el = e.currentTarget;
  el.removeEventListener("touchmove", touchMove);
  el.removeEventListener("touchend", touchEnd);
  el.removeEventListener("touchcancel", touchEnd);
  clearTimeout(touch.press);
  if (touch.selecting) {
    touch.selecting = false;
    if (e.cancelable) e.preventDefault();
    placeSelection();
    return;
  }
  if (e.type === "touchend" && !touch.moved && e.timeStamp - touch.t0 < LONG_PRESS) {
    if (tapAt(touch.x0, touch.y0)) {
      if (e.cancelable) e.preventDefault();
      return;
    }
  }
  if (e.timeStamp - touch.t > 80 || Math.abs(touch.v) < 0.3) return;
  let v = touch.v;
  let last = performance.now();
  const step = (now) => {
    const dt = now - last;
    last = now;
    drag(v * dt);
    v *= Math.pow(0.95, dt / 16);
    if (Math.abs(v) > 0.05) touch.glide = requestAnimationFrame(step);
  };
  touch.glide = requestAnimationFrame(step);
}

termEl.addEventListener("touchstart", (e) => {
  if (setup) return;
  if (e.touches.length === 2) {
    clearTimeout(touch.press);
    startTouchPinch(e);
    return;
  }
  if (e.touches.length !== 1) return;
  cancelAnimationFrame(touch.glide);
  const p = e.touches[0];
  Object.assign(touch, {
    y: p.clientY, t: e.timeStamp, v: 0, rest: 0,
    x0: p.clientX, y0: p.clientY, t0: e.timeStamp, moved: false, selecting: false, el: e.target,
  });
  clearTimeout(touch.press);
  touch.press = setTimeout(() => {
    touch.selecting = true;
    startSelection(touch.x0, touch.y0);
  }, LONG_PRESS);
  e.target.addEventListener("touchmove", touchMove, { passive: false });
  e.target.addEventListener("touchend", touchEnd);
  e.target.addEventListener("touchcancel", touchEnd);
}, { capture: true, passive: true });

let wheelRest = 0;
termEl.addEventListener("wheel", (e) => {
  if (setup || term.modes.mouseTrackingMode !== "none") return;
  e.preventDefault();
  e.stopPropagation();
  const h = lineHeight();
  wheelRest += e.deltaMode === 1 ? e.deltaY * h : e.deltaMode === 2 ? e.deltaY * h * term.rows : e.deltaY;
  const lines = Math.trunc(wheelRest / h);
  wheelRest -= lines * h;
  scrollLines(lines);
}, { capture: true, passive: false });

if (embedded) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.yardbell === "text") showText();
    if (e.data?.yardbell === "focus") focusShown();
  });
  const WORKSPACE_KEYS = /^(Digit[1-9]|Backslash|Minus|KeyX|KeyT|BracketLeft|BracketRight|ArrowUp|ArrowDown)$/;
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || !WORKSPACE_KEYS.test(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ yardbell: "key", code: e.code }, location.origin);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!((mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyK")) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ yardbell: "palette" }, location.origin);
  }, true);
}

// Touch screens and phone widths get the key bar. Inside a Workspace pane the width that counts is
// the Workspace's own, since a narrow pane on a desktop is not a phone.
const root = document.documentElement;
const phoneWidth = (() => {
  try {
    if (embedded && window.frameElement) return parent.matchMedia("(max-width: 760px)");
  } catch {}
  return matchMedia("(max-width: 760px)");
})();
const touchUi = () => !setup && (coarse.matches || phoneWidth.matches);

function showTouchUi() {
  root.classList.toggle("touch-ui", touchUi());
  if (!touchUi()) {
    root.classList.remove("kb-fixed", "kb-open");
    kept = false;
    lift = 0;
    applyTransform();
    closeMore();
  }
  if (term.element) resize();
}
coarse.addEventListener("change", showTouchUi);
phoneWidth.addEventListener("change", showTouchUi);

// Sticky modifiers: a tap arms one for the next key, a quick second tap locks it until tapped again.
const latch = { ctrl: "off", alt: "off", shift: "off" };
const lastTap = { ctrl: 0, alt: 0, shift: 0 };
const DOUBLE_TAP = 350;

const modsHeld = () => latch.ctrl !== "off" || latch.alt !== "off" || latch.shift !== "off";
const heldMods = () => ({ ctrl: latch.ctrl !== "off", alt: latch.alt !== "off", shift: latch.shift !== "off" });

function tapModifier(mod) {
  const now = performance.now();
  const quick = latch[mod] === "once" && now - lastTap[mod] < DOUBLE_TAP;
  lastTap[mod] = now;
  latch[mod] = quick ? "locked" : latch[mod] === "off" ? "once" : "off";
  showLatches();
}

function releaseMods() {
  let changed = false;
  for (const mod of Object.keys(latch)) {
    if (latch[mod] !== "once") continue;
    latch[mod] = "off";
    changed = true;
  }
  if (changed) showLatches();
}

function showLatches() {
  document.querySelectorAll("button[data-mod]").forEach((b) => {
    const state = latch[b.dataset.mod];
    b.dataset.latch = state;
    b.setAttribute("aria-pressed", state === "off" ? "false" : "true");
    b.title = state === "locked" ? `${KEYS[b.dataset.key].name} locked, tap to release` : state === "once" ? `${KEYS[b.dataset.key].name} for the next key, tap again to lock` : "";
  });
}

function ctrlChar(c) {
  if (c === " " || c === "@" || c === "2") return "\x00";
  if (c === "?" || c === "8") return "\x7f";
  if (c === "/") return "\x1f";
  if (c >= "3" && c <= "7") return String.fromCharCode(c.charCodeAt(0) - 24);
  const n = c.charCodeAt(0);
  return c.length === 1 && n >= 64 && n <= 126 ? String.fromCharCode(n & 0x1f) : c;
}

const FN_TILDE = [15, 17, 18, 19, 20, 21, 23, 24];

// Modified cursor and function keys carry xterm's parameter: 1 plus Shift 1, Alt 2 and Ctrl 4.
function encodeKey(k, m) {
  const p = 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
  if (k.fixed) return k.fixed;
  if (k.csi) return p > 1 ? `\x1b[1;${p}${k.csi}` : `\x1b[${k.csi}`;
  if (k.fn && k.fn <= 4) return p > 1 ? `\x1b[1;${p}${"PQRS"[k.fn - 1]}` : `\x1bO${"PQRS"[k.fn - 1]}`;
  const tilde = k.fn ? FN_TILDE[k.fn - 5] : k.tilde;
  if (tilde) return p > 1 ? `\x1b[${tilde};${p}~` : `\x1b[${tilde}~`;
  let s;
  if (k.name === "tab") {
    if (m.shift) return m.alt ? "\x1b\x1b[Z" : "\x1b[Z";
    s = "\t";
  } else if (k.name === "enter") {
    s = "\r";
  } else if (k.name === "esc") {
    s = "\x1b";
  } else if (k.name === "bksp") {
    s = m.ctrl ? "\x08" : "\x7f";
  } else {
    s = m.shift ? k.char.toUpperCase() : k.char;
    if (m.ctrl) s = ctrlChar(s);
  }
  return m.alt ? `\x1b${s}` : s;
}

// What the soft keyboard or xterm.js sent, as a key the armed modifiers can change. Anything else,
// such as a mouse report or a paste, goes through untouched and leaves them armed.
function typedKey(d) {
  if (d === "\r") return { name: "enter" };
  if (d === "\t") return { name: "tab" };
  if (d === "\x7f" || d === "\b") return { name: "bksp" };
  if (d === "\x1b") return { name: "esc" };
  let m = /^\x1b[[O]([ABCDHF])$/.exec(d);
  if (m) return { csi: m[1] };
  m = /^\x1b\[(\d+)~$/.exec(d);
  if (m) return { tilde: Number(m[1]) };
  m = /^\x1bO([PQRS])$/.exec(d);
  if (m) return { fn: "PQRS".indexOf(m[1]) + 1 };
  return [...d].length === 1 && d >= " " ? { char: d } : null;
}

const ICON = (path) => `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
const KEYS = {
  esc: { label: "Esc", name: "Escape", k: { name: "esc" } },
  tab: { label: "Tab", name: "Tab", k: { name: "tab" }, repeat: true },
  stab: { label: "⇧Tab", name: "Shift-Tab", k: { fixed: "\x1b[Z" }, repeat: true },
  ctrl: { label: "Ctrl", name: "Ctrl", mod: "ctrl" },
  alt: { label: "Alt", name: "Alt", mod: "alt" },
  shift: { label: "Shift", name: "Shift", mod: "shift" },
  up: { label: ICON("M8 12.5V3.5M4 7.5l4-4 4 4"), name: "Arrow up", k: { csi: "A" }, repeat: true },
  down: { label: ICON("M8 3.5v9M4 8.5l4 4 4-4"), name: "Arrow down", k: { csi: "B" }, repeat: true },
  left: { label: ICON("M12.5 8h-9M7.5 4l-4 4 4 4"), name: "Arrow left", k: { csi: "D" }, repeat: true },
  right: { label: ICON("M3.5 8h9M8.5 4l4 4-4 4"), name: "Arrow right", k: { csi: "C" }, repeat: true },
  slash: { label: "/", name: "Slash", k: { char: "/" }, sym: true },
  pipe: { label: "|", name: "Pipe", k: { char: "|" }, sym: true },
  tilde: { label: "~", name: "Tilde", k: { char: "~" }, sym: true },
  dash: { label: "-", name: "Dash", k: { char: "-" }, sym: true },
  enter: { label: "Enter", name: "Enter", k: { name: "enter" } },
  ctrlc: { label: "Ctrl-C", name: "Ctrl-C", k: { fixed: "\x03" } },
  ctrld: { label: "Ctrl-D", name: "Ctrl-D", k: { fixed: "\x04" } },
  paste: { label: "Paste", name: "Paste", act: () => pasteClipboard() },
  home: { label: "Home", name: "Home", k: { csi: "H" } },
  end: { label: "End", name: "End", k: { csi: "F" } },
  pgup: { label: "PgUp", name: "Page up", k: { tilde: 5 }, repeat: true },
  pgdn: { label: "PgDn", name: "Page down", k: { tilde: 6 }, repeat: true },
  bksp: { label: ICON("M6 3.5h7.5v9H6L2.5 8zM8 6l3 4M11 6l-3 4"), name: "Backspace", k: { name: "bksp" }, repeat: true },
  del: { label: "Del", name: "Delete", k: { tilde: 3 }, repeat: true },
  ctrlz: { label: "Ctrl-Z", name: "Ctrl-Z", k: { fixed: "\x1a" } },
  ctrll: { label: "Ctrl-L", name: "Ctrl-L", k: { fixed: "\x0c" } },
  ctrlr: { label: "Ctrl-R", name: "Ctrl-R", k: { fixed: "\x12" } },
};
for (let n = 1; n <= 12; n++) KEYS[`f${n}`] = { label: `F${n}`, name: `F${n}`, k: { fn: n } };
const DEFAULT_BAR = ["esc", "tab", "stab", "ctrl", "alt", "shift", "up", "down", "left", "right", "slash", "pipe", "tilde", "dash", "enter", "ctrlc", "ctrld", "paste"];
const EXTRA = ["home", "end", "pgup", "pgdn", "bksp", "del", "ctrlz", "ctrll", "ctrlr", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)];
const BAR_KEY = "yardbell.term.keys";

function storedBar() {
  try {
    const ids = JSON.parse(localStorage.getItem(BAR_KEY));
    if (Array.isArray(ids)) return [...new Set(ids.filter((id) => KEYS[id]))];
  } catch {}
  return [...DEFAULT_BAR];
}

let bar = storedBar();

function saveBar() {
  try {
    if (bar.join() === DEFAULT_BAR.join()) localStorage.removeItem(BAR_KEY);
    else localStorage.setItem(BAR_KEY, JSON.stringify(bar));
  } catch {}
}

function keyButton(id) {
  const def = KEYS[id];
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tk${def.sym ? " sym" : ""}`;
  b.dataset.key = id;
  if (def.mod) b.dataset.mod = def.mod;
  b.innerHTML = def.label;
  if (def.label.startsWith("<") || def.label !== def.name) b.setAttribute("aria-label", def.name);
  return b;
}

function renderBar() {
  document.getElementById("keys-row").replaceChildren(...bar.map(keyButton));
  const more = [...EXTRA, ...Object.keys(KEYS).filter((id) => !bar.includes(id) && !EXTRA.includes(id))];
  document.getElementById("more-keys").replaceChildren(...more.map(keyButton));
  showLatches();
}

function fire(id) {
  const def = KEYS[id];
  if (!def) return;
  if (def.mod) {
    tapModifier(def.mod);
    return;
  }
  if (def.act) {
    def.act();
    return;
  }
  const data = encodeKey(def.k, heldMods());
  releaseMods();
  send({ t: "in", d: data });
}

// Keys fire on release, so a swipe along the bar scrolls it instead. A held repeating key fires
// after a pause and then quickly until let go. Pressing never moves the focus, so the on-screen
// keyboard stays up.
const REPEAT_DELAY = 400;
const REPEAT_EVERY = 50;
let press = null;

function endPress(fired) {
  if (!press) return;
  clearTimeout(press.timer);
  press.b.classList.remove("pressed");
  if (fired && !press.repeating) fire(press.id);
  press = null;
}

function repeatKey() {
  if (!press) return;
  press.repeating = true;
  fire(press.id);
  press.timer = setTimeout(repeatKey, REPEAT_EVERY);
}

function bindKeys(container) {
  container.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b || e.button > 0) return;
    e.preventDefault();
    endPress(false);
    press = { b, id: b.dataset.key, pointer: e.pointerId, x: e.clientX, y: e.clientY, repeating: false, timer: 0 };
    b.classList.add("pressed");
    if (KEYS[press.id]?.repeat) press.timer = setTimeout(repeatKey, REPEAT_DELAY);
  });
  container.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (b && e.detail === 0) fire(b.dataset.key);
  });
}

window.addEventListener("pointermove", (e) => {
  if (press && e.pointerId === press.pointer && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) endPress(false);
});
window.addEventListener("pointerup", (e) => {
  if (press && e.pointerId === press.pointer) endPress(true);
});
window.addEventListener("pointercancel", (e) => {
  if (press && e.pointerId === press.pointer) endPress(false);
});
window.addEventListener("blur", () => endPress(false));

const keysEl = document.getElementById("keys");
const moreSheet = document.getElementById("more-sheet");
const moreBtn = document.getElementById("keys-more");
bindKeys(document.getElementById("keys-row"));
bindKeys(document.getElementById("more-keys"));

// Buttons around the terminal act on click but must not take the focus on the way.
for (const el of [moreBtn, moreSheet, document.getElementById("sel-menu")]) {
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") && !e.target.closest("#more-editor")) e.preventDefault();
  });
}

function openMore() {
  endSelection();
  showEditor(false);
  document.getElementById("notice").classList.remove("show");
  moreSheet.hidden = false;
  moreBtn.setAttribute("aria-expanded", "true");
  showFont();
}

function closeMore() {
  if (moreSheet.hidden) return;
  moreSheet.hidden = true;
  moreBtn.setAttribute("aria-expanded", "false");
  showEditor(false);
}

moreBtn.addEventListener("click", () => (moreSheet.hidden ? openMore() : closeMore()));
document.getElementById("more-close").addEventListener("click", closeMore);
document.getElementById("more-edit").addEventListener("click", () => showEditor(document.getElementById("more-editor").hidden));
document.getElementById("more-text").addEventListener("click", showText);
document.getElementById("more-select").addEventListener("click", () => {
  closeMore();
  selectCursorLine();
});
termEl.addEventListener("pointerdown", () => closeMore(), true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!moreSheet.hidden) closeMore();
  else if (sel.on) endSelection();
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

function showEditor(on) {
  document.getElementById("more-editor").hidden = !on;
  document.getElementById("more-body").hidden = on;
  document.getElementById("more-title").textContent = on ? "Edit key bar" : "More keys";
  document.getElementById("more-edit").textContent = on ? "Back" : "Edit bar";
  if (on) renderEditor();
}

function renderEditor() {
  const list = document.getElementById("edit-list");
  const rest = Object.keys(KEYS).filter((id) => !bar.includes(id));
  list.replaceChildren(...[...bar, ...rest].map((id) => {
    const def = KEYS[id];
    const on = bar.includes(id);
    const at = bar.indexOf(id);
    const li = document.createElement("li");
    li.dataset.id = id;
    li.classList.toggle("off", !on);
    li.innerHTML = `<label><input type="checkbox" data-edit="show"${on ? " checked" : ""}><span class="edit-key">${def.label}</span><span class="edit-name"></span></label>
      <button type="button" class="edit-move" data-edit="up" aria-label="Move ${def.name} earlier"${on && at > 0 ? "" : " disabled"}>${ICON("M8 12.5V3.5M4 7.5l4-4 4 4")}</button>
      <button type="button" class="edit-move" data-edit="down" aria-label="Move ${def.name} later"${on && at < bar.length - 1 ? "" : " disabled"}>${ICON("M8 3.5v9M4 8.5l4 4 4-4")}</button>`;
    li.querySelector(".edit-name").textContent = def.name;
    return li;
  }));
}

function editBar(id, how) {
  const at = bar.indexOf(id);
  if (how === "show") {
    if (at < 0) bar.push(id);
    else bar.splice(at, 1);
  } else if (at >= 0) {
    const to = how === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= bar.length) return;
    [bar[at], bar[to]] = [bar[to], bar[at]];
  }
  saveBar();
  renderBar();
  renderEditor();
  const again = document.querySelector(`#edit-list li[data-id="${id}"] [data-edit="${how}"]:not(:disabled)`);
  again?.focus({ preventScroll: true });
}

document.getElementById("edit-list").addEventListener("click", (e) => {
  const control = e.target.closest("[data-edit]");
  if (!control || control.dataset.edit === "show") return;
  editBar(control.closest("li").dataset.id, control.dataset.edit);
});
document.getElementById("edit-list").addEventListener("change", (e) => {
  if (e.target.dataset.edit === "show") editBar(e.target.closest("li").dataset.id, "show");
});
document.getElementById("edit-reset").addEventListener("click", () => {
  bar = [...DEFAULT_BAR];
  saveBar();
  renderBar();
  renderEditor();
});

// Paste: the apps and secure pages read the clipboard; over plain http the browser will not, so a
// box takes the paste from the system menu instead.
const pasteView = document.getElementById("paste-view");
const pasteText = document.getElementById("paste-text");

async function pasteClipboard() {
  let text = null;
  if (app?.clipboardManager) {
    try { text = await app.clipboardManager.readText(); } catch {}
  }
  if (text === null && navigator.clipboard?.readText && window.isSecureContext) {
    try { text = await navigator.clipboard.readText(); } catch {}
  }
  if (text === null) {
    openPasteBox();
    return;
  }
  if (text) term.paste(text);
  else notice("Nothing to paste");
}

function openPasteBox() {
  closeMore();
  pasteText.value = "";
  pasteView.hidden = false;
  pasteText.focus();
}

function closePasteBox() {
  pasteView.hidden = true;
  term.focus();
}

document.getElementById("paste-cancel").addEventListener("click", closePasteBox);
document.getElementById("paste-send").addEventListener("click", () => {
  const text = pasteText.value;
  closePasteBox();
  if (text) term.paste(text);
});
pasteView.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  closePasteBox();
});

// Text size: a pinch scales the drawn terminal live, and letting go settles on the nearest size,
// which refits the grid. A- and A+ step through the same sizes.
let lift = 0;
let pinchScale = 1;
let pinchOrigin = "0 0";
let pinching = false;

function applyTransform() {
  const el = term.element;
  if (!el) return;
  const moves = [];
  if (lift) moves.push(`translateY(${-lift}px)`);
  if (pinchScale !== 1) moves.push(`scale(${pinchScale})`);
  el.style.transform = moves.join(" ");
  el.style.transformOrigin = pinchScale !== 1 ? pinchOrigin : "";
  root.classList.toggle("pinching", pinching);
}

function nearestFont(px) {
  return FONT_SIZES.reduce((best, size) => (Math.abs(size - px) < Math.abs(best - px) ? size : best));
}

function setFontSize(px) {
  const size = nearestFont(px);
  pinching = false;
  pinchScale = 1;
  applyTransform();
  if (size !== term.options.fontSize) {
    term.options.fontSize = size;
    refit();
  }
  try { localStorage.setItem(FONT_KEY, String(size)); } catch {}
  showFont();
  return size;
}

function stepFont(dir) {
  const at = FONT_SIZES.indexOf(nearestFont(term.options.fontSize));
  return setFontSize(FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, at + dir))]);
}

function showFont() {
  const size = term.options.fontSize;
  document.getElementById("font-size").textContent = `${size} px`;
  document.getElementById("font-down").disabled = size <= FONT_SIZES[0];
  document.getElementById("font-up").disabled = size >= FONT_SIZES[FONT_SIZES.length - 1];
}

document.getElementById("font-down").addEventListener("click", () => stepFont(-1));
document.getElementById("font-up").addEventListener("click", () => stepFont(1));

function pinchStart(x, y) {
  if (!term.element) return;
  const r = term.element.getBoundingClientRect();
  pinchOrigin = `${Math.round(x - r.left)}px ${Math.round(y - r.top)}px`;
  pinching = true;
  pinchScale = 1;
  endSelection();
  applyTransform();
}

function pinchMove(scale) {
  if (!pinching) return;
  const size = term.options.fontSize;
  pinchScale = Math.min(FONT_SIZES[FONT_SIZES.length - 1] / size, Math.max(FONT_SIZES[0] / size, scale));
  applyTransform();
}

function pinchEnd() {
  if (!pinching) return term.options.fontSize;
  return setFontSize(term.options.fontSize * pinchScale);
}

function startTouchPinch(e) {
  const [a, b] = e.touches;
  const gap = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
  pinchStart((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  const targets = new Set([touch.el, e.target].filter(Boolean));
  const move = (ev) => {
    if (ev.touches.length < 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    const [p, q] = ev.touches;
    pinchMove(Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) / gap);
  };
  const end = (ev) => {
    if (ev.touches.length >= 2) return;
    for (const t of targets) {
      t.removeEventListener("touchmove", move);
      t.removeEventListener("touchend", end);
      t.removeEventListener("touchcancel", end);
    }
    pinchEnd();
  };
  for (const t of targets) {
    t.addEventListener("touchmove", move, { passive: false });
    t.addEventListener("touchend", end);
    t.addEventListener("touchcancel", end);
  }
}

// The on-screen keyboard. iOS and the app web views leave the page its full height and only shrink
// the visual viewport, so the page is pinned to the part still visible. Android Chrome shrinks the
// page itself. Either way the grid keeps its size while typing, so tmux is not resized every time
// the keyboard opens, and the terminal is lifted just enough to keep the cursor's row in sight.
const KEYBOARD_MIN = 120;
let fitted = { w: 0, h: 0 };
let kept = false;
let settleTimer = 0;
let viewportFrame = 0;
let liftFrame = 0;

function host() {
  try {
    if (embedded && window.frameElement) return { vv: parent.visualViewport, rect: window.frameElement.getBoundingClientRect() };
  } catch {}
  return { vv: window.visualViewport, rect: { top: 0, bottom: window.innerHeight } };
}

function typing() {
  const el = document.activeElement;
  return Boolean(el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable));
}

function refit() {
  if (!term.element) return;
  const fixed = root.classList.contains("kb-fixed");
  if (fixed) root.classList.remove("kb-fixed");
  const hold = kept && fitted.h > 0;
  if (hold) {
    termEl.style.flex = "none";
    termEl.style.height = `${fitted.h}px`;
  }
  fit.fit();
  // The fit addon measures #term with its padding, which leaves the last row half hidden.
  const pad = getComputedStyle(termEl);
  const cell = term.element.querySelector(".xterm-screen").clientHeight / term.rows;
  const rows = Math.floor((termEl.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)) / cell);
  if (cell > 0 && rows > 0 && rows < term.rows) term.resize(term.cols, rows);
  fitted = { w: termEl.clientWidth, h: termEl.clientHeight };
  if (hold) {
    termEl.style.flex = "";
    termEl.style.height = "";
  }
  if (fixed) root.classList.add("kb-fixed");
  sendSize();
  reportView();
  queueLift();
}

function queueSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 120);
  queueViewport();
}

function settle() {
  settleTimer = 0;
  if (!term.element) return;
  const sameWidth = Math.abs(termEl.clientWidth - fitted.w) < 2;
  const shrunk = termEl.clientHeight < fitted.h - KEYBOARD_MIN;
  const keep = touchUi() && !root.classList.contains("kb-fixed") && sameWidth && shrunk && typing();
  if (keep !== kept) {
    kept = keep;
    queueViewport();
  }
  if (kept) queueLift();
  else refit();
}

function queueViewport() {
  if (!viewportFrame) viewportFrame = requestAnimationFrame(fitViewport);
}

function fitViewport() {
  viewportFrame = 0;
  const { vv, rect } = host();
  const was = root.classList.contains("kb-fixed");
  let fixed = false;
  let covered = 0;
  if (touchUi() && vv && vv.scale <= 1.01) {
    const top = Math.max(rect.top, vv.offsetTop);
    const bottom = Math.min(rect.bottom, vv.offsetTop + vv.height);
    covered = rect.bottom - bottom;
    if (bottom - top > 80 && (covered > 1 || top - rect.top > 1)) {
      fixed = true;
      root.style.setProperty("--vis-top", `${Math.round(top - rect.top)}px`);
      root.style.setProperty("--vis-h", `${Math.round(bottom - top)}px`);
    }
  }
  if (!fixed) {
    root.style.removeProperty("--vis-top");
    root.style.removeProperty("--vis-h");
  }
  root.classList.toggle("kb-fixed", fixed);
  root.classList.toggle("kb-open", kept || covered > KEYBOARD_MIN);
  if (fixed !== was) queueSettle();
  else queueLift();
}

function queueLift() {
  if (!liftFrame && touchUi()) liftFrame = requestAnimationFrame(liftCursor);
}

function liftCursor() {
  liftFrame = 0;
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen || !touchUi() || !term.rows) return;
  const box = termEl.getBoundingClientRect();
  const bottom = box.bottom - parseFloat(getComputedStyle(termEl).paddingBottom || "0");
  const r = screen.getBoundingClientRect();
  const top = r.top + lift;
  const row = r.height / pinchScale / term.rows;
  const most = Math.max(0, top + term.rows * row - bottom);
  const cursor = term.buffer.active.cursorY;
  const want = Math.round(Math.max(0, Math.min(most, top + (cursor + 2) * row - bottom)));
  if (want === lift) return;
  lift = want;
  applyTransform();
  if (sel.on) placeSelection();
}

term.onCursorMove(queueLift);
term.onResize(queueLift);
for (const vv of new Set([window.visualViewport, host().vv].filter(Boolean))) {
  vv.addEventListener("resize", queueViewport);
  vv.addEventListener("scroll", queueViewport);
}
new ResizeObserver(() => {
  if (touchUi()) queueSettle();
}).observe(termEl);
document.addEventListener("focusin", () => touchUi() && queueSettle());
document.addEventListener("focusout", () => touchUi() && queueSettle());

// Selecting on the terminal itself: a long press picks the word under the finger and dragging
// goes on from there; the handles move either end and the menu copies.
const sel = { on: false, a: null, b: null, setting: false };
const selLayer = document.getElementById("sel-layer");
const selMenu = document.getElementById("sel-menu");
const handles = { start: selLayer.querySelector('[data-end="start"]'), end: selLayer.querySelector('[data-end="end"]') };

function screenBox() {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen) return null;
  const r = screen.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width / term.cols, h: r.height / term.rows };
}

function cellAt(x, y) {
  const box = screenBox();
  const col = Math.floor((x - box.left) / box.w);
  const row = Math.floor((y - box.top) / box.h);
  return {
    x: Math.max(0, Math.min(term.cols - 1, col)),
    y: Math.max(0, Math.min(term.rows - 1, row)) + term.buffer.active.viewportY,
  };
}

function cellChars(y) {
  const line = term.buffer.active.getLine(y);
  const chars = [];
  for (let x = 0; x < term.cols; x++) chars.push(line?.getCell(x)?.getChars() || " ");
  return chars;
}

const wordChar = (c) => Boolean(c) && !/[\s"'`()[\]{}<>,;|│]/.test(c);
const before = (p, q) => p.y < q.y || (p.y === q.y && p.x < q.x);

function wordAt(c) {
  const chars = cellChars(c.y);
  if (!wordChar(chars[c.x])) {
    const text = chars.join("");
    const start = text.search(/\S/);
    if (start < 0) return [{ x: 0, y: c.y }, { x: term.cols, y: c.y }];
    return [{ x: start, y: c.y }, { x: text.trimEnd().length, y: c.y }];
  }
  let s = c.x;
  let e = c.x + 1;
  while (s > 0 && wordChar(chars[s - 1])) s--;
  while (e < term.cols && wordChar(chars[e])) e++;
  return [{ x: s, y: c.y }, { x: e, y: c.y }];
}

function setSelection(a, b) {
  if (before(b, a)) [a, b] = [b, a];
  if (a.x === b.x && a.y === b.y) b = { x: a.x + 1, y: a.y };
  sel.a = a;
  sel.b = b;
  sel.setting = true;
  term.select(a.x, a.y, (b.y - a.y) * term.cols + b.x - a.x);
  sel.setting = false;
}

function startSelection(x, y) {
  if (!term.element) return;
  closeMore();
  const [a, b] = wordAt(cellAt(x, y));
  sel.on = true;
  sel.anchor = a;
  sel.anchorEnd = b;
  setSelection(a, b);
  root.classList.add("selecting");
  placeSelection();
}

function selectCursorLine() {
  const buf = term.buffer.active;
  let y = buf.baseY + buf.cursorY;
  while (y > buf.viewportY && !cellChars(y).join("").trim()) y--;
  const box = screenBox();
  if (!box) return;
  const text = cellChars(y).join("");
  const at = Math.max(0, text.search(/\S/));
  startSelection(box.left + (at + 0.5) * box.w, box.top + (y - buf.viewportY + 0.5) * box.h);
  setSelection({ x: at, y }, { x: Math.max(at + 1, text.trimEnd().length), y });
  placeSelection();
}

function dragSelection(x, y) {
  if (!sel.on) return;
  const c = cellAt(x, y);
  const [a, b] = wordAt(c);
  if (before(a, sel.anchor)) setSelection(a, sel.anchorEnd);
  else setSelection(sel.anchor, b);
  placeSelection(true);
}

function endSelection() {
  if (!sel.on) return;
  sel.on = false;
  root.classList.remove("selecting");
  selLayer.hidden = true;
  sel.setting = true;
  term.clearSelection();
  sel.setting = false;
}

function cellPoint(p) {
  const box = screenBox();
  return { x: box.left + p.x * box.w, y: box.top + (p.y - term.buffer.active.viewportY) * box.h, h: box.h };
}

function placeSelection(dragging = false) {
  if (!sel.on) return;
  selLayer.hidden = false;
  const start = cellPoint(sel.a);
  const end = sel.b.x === 0 && sel.b.y > sel.a.y ? cellPoint({ x: term.cols, y: sel.b.y - 1 }) : cellPoint(sel.b);
  const area = termEl.getBoundingClientRect();
  const showAt = (el, p) => {
    const inside = p.y > area.top && p.y <= area.bottom;
    el.hidden = !inside;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y + p.h}px`;
    el.style.setProperty("--sel-row", `${p.h}px`);
  };
  showAt(handles.start, start);
  showAt(handles.end, end);
  selMenu.hidden = dragging;
  if (dragging) return;
  const w = selMenu.offsetWidth;
  const h = selMenu.offsetHeight;
  const above = start.y - h - 10;
  const top = above > area.top ? above : Math.min(end.y + end.h + 34, area.bottom - h - 4);
  const mid = (start.x + end.x) / 2;
  selMenu.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, mid - w / 2)))}px`;
  selMenu.style.top = `${Math.round(Math.max(area.top + 4, top))}px`;
}

term.onSelectionChange(() => {
  if (sel.on && !sel.setting && !term.hasSelection()) endSelection();
});
term.onScroll(() => sel.on && placeSelection());

for (const [end, el] of Object.entries(handles)) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const p = end === "start" ? cellPoint(sel.a) : cellPoint({ x: Math.max(0, sel.b.x - 1), y: sel.b.y });
    const grab = { dx: p.x + screenBox().w / 2 - e.clientX, dy: p.y + p.h / 2 - e.clientY };
    const move = (ev) => {
      const c = cellAt(ev.clientX + grab.dx, ev.clientY + grab.dy);
      const other = end === "start" ? sel.b : sel.a;
      if (end === "start") setSelection(c, other);
      else setSelection(other, { x: c.x + 1, y: c.y });
      placeSelection(true);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      placeSelection();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

selMenu.addEventListener("click", (e) => {
  const act = e.target.closest("[data-sel]")?.dataset.sel;
  if (act === "copy") {
    copy(term.getSelection());
    endSelection();
  } else if (act === "all") {
    sel.setting = true;
    term.selectAll();
    sel.setting = false;
    const buf = term.buffer.active;
    sel.a = { x: 0, y: 0 };
    sel.b = { x: term.cols, y: buf.length - 1 };
    placeSelection();
  } else if (act === "paste") {
    endSelection();
    pasteClipboard();
  } else if (act === "done") {
    endSelection();
  }
});

termEl.addEventListener("pointerdown", (e) => {
  if (sel.on && e.pointerType !== "touch") endSelection();
}, true);

// Web addresses on the screen are links: a tap opens one on a touch screen, and Ctrl or Cmd with a
// click does on a desktop, where a plain click belongs to tmux.
const URL_RE = /\bhttps?:\/\/[^\s"'`<>]+/g;

function linksOn(y) {
  const buf = term.buffer.active;
  let first = y;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buf.getLine(last + 1)?.isWrapped) last++;
  let text = "";
  const at = [];
  for (let row = first; row <= last; row++) {
    const line = buf.getLine(row);
    for (let x = 0; x < term.cols; x++) {
      const cell = line?.getCell(x);
      if (cell && cell.getWidth() === 0) continue;
      const ch = cell?.getChars() || " ";
      for (let i = 0; i < ch.length; i++) at.push({ x, y: row });
      text += ch;
    }
  }
  const links = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?'"]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) url = url.slice(0, -1);
    const s = at[m.index];
    const e = at[m.index + url.length - 1];
    if (!s || !e || (s.y > y && e.y > y) || (s.y < y && e.y < y)) continue;
    links.push({ url, start: s, end: e });
  }
  return links;
}

function openLink(url) {
  window.open(url, "_blank", "noopener");
}

function linkAt(x, y) {
  if (!term.element) return "";
  const c = cellAt(x, y);
  const hit = linksOn(c.y).find((l) => !before(c, l.start) && !before(l.end, c));
  return hit?.url || "";
}

function tapAt(x, y) {
  if (sel.on) {
    endSelection();
    return true;
  }
  const url = linkAt(x, y);
  if (!url) return false;
  openLink(url);
  return true;
}

term.registerLinkProvider({
  provideLinks(y, done) {
    const links = linksOn(y - 1);
    done(links.length ? links.map((l) => ({
      text: l.url,
      range: { start: { x: l.start.x + 1, y: l.start.y + 1 }, end: { x: l.end.x + 1, y: l.end.y + 1 } },
      decorations: { underline: true, pointerCursor: true },
      activate: (e, url) => {
        if (e?.ctrlKey || e?.metaKey) openLink(url);
      },
    })) : undefined);
  },
});

renderBar();
showFont();
root.classList.toggle("touch-ui", touchUi());

Promise.all([
  document.fonts.load('14px "JetBrains Mono"'),
  document.fonts.load('bold 14px "JetBrains Mono"'),
]).catch(() => {}).finally(() => {
  term.open(termEl);
  fit.fit();
  fitted = { w: termEl.clientWidth, h: termEl.clientHeight };
  connect();
  term.textarea?.addEventListener("focus", () => send({ t: "focus" }));
  if (embedded) {
    term.textarea?.addEventListener("focus", () => parent.postMessage({ yardbell: "focused" }, location.origin));
  } else {
    term.focus();
  }
});
