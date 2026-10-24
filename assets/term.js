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
const term = new Terminal({
  cursorBlink: true,
  fontFamily: FONT,
  fontSize: matchMedia("(pointer: coarse)").matches ? 13 : 14,
  letterSpacing: 0,
  lineHeight: 1.15,
  scrollback: 5000,
  theme: { background: "#0a0a0b", foreground: "#ededef", cursor: "#93c5fd", selectionBackground: "#172554" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

const KEYS = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", ctrlc: "\x03" };
const RETRY = [1000, 2000, 5000, 10000];
let socket = null;
let attempt = 0;
let ended = false;
let ctrl = false;

function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function sendInput(data) {
  if (ctrl && data.length === 1) {
    data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
    ctrl = false;
    document.getElementById("ctrl").classList.remove("on");
  }
  send({ t: "in", d: data });
}

function resize() {
  if (!term.element) return;
  fit.fit();
  send({ t: "resize", rows: term.rows, cols: term.cols });
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}${location.pathname}/ws`);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    attempt = 0;
    document.getElementById("banner").style.display = "none";
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

function notice(text, offer) {
  const el = document.getElementById("notice");
  document.getElementById("notice-text").textContent = text;
  el.classList.toggle("ask", Boolean(offer));
  el.classList.add("show");
  pending = offer || "";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove("show"), offer ? 8000 : 1600);
}

function copyNow(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
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
  if (!ok) ok = copyNow(text);
  if (ok) notice("Copied");
  else notice("Selection ready", text);
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
  if (term.hasSelection()) copy(term.getSelection());
});

document.getElementById("notice-copy").addEventListener("click", () => {
  if (copyNow(pending)) notice("Copied");
  term.focus();
});

function screenText() {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\s+$/, "");
}

const textView = document.getElementById("text-view");
function showText() {
  document.getElementById("text-body").textContent = screenText();
  textView.classList.add("show");
}
document.getElementById("text-btn").addEventListener("click", showText);
document.getElementById("text-close").addEventListener("click", () => {
  textView.classList.remove("show");
  term.focus();
});
document.getElementById("text-copy").addEventListener("click", () => {
  const text = document.getElementById("text-body").textContent;
  if (copyNow(text)) notice("Copied");
});

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
window.addEventListener("resize", resize);

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
const touch = { y: 0, t: 0, v: 0, rest: 0, glide: 0 };

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
  const y = e.touches[0].clientY;
  const dy = y - touch.y;
  touch.v = dy / Math.max(1, e.timeStamp - touch.t);
  touch.y = y;
  touch.t = e.timeStamp;
  drag(dy);
}

function touchEnd(e) {
  e.currentTarget.removeEventListener("touchmove", touchMove);
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
  if (setup || e.touches.length !== 1) return;
  cancelAnimationFrame(touch.glide);
  Object.assign(touch, { y: e.touches[0].clientY, t: e.timeStamp, v: 0, rest: 0 });
  e.target.addEventListener("touchmove", touchMove, { passive: false });
  e.target.addEventListener("touchend", touchEnd, { once: true });
  e.target.addEventListener("touchcancel", touchEnd, { once: true });
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
    if (e.data?.yardbell === "focus") term.focus();
  });
  const WORKSPACE_KEYS = /^(Digit[1-9]|Backslash|Minus|KeyX|KeyT|BracketLeft|BracketRight|ArrowUp|ArrowDown)$/;
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || !WORKSPACE_KEYS.test(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ yardbell: "key", code: e.code }, location.origin);
  }, true);
}
function pressKey(b) {
  if (b.dataset.key === "ctrl") {
    ctrl = !ctrl;
    b.classList.toggle("on", ctrl);
  } else {
    send({ t: "in", d: KEYS[b.dataset.key] });
  }
  b.classList.add("pressed");
  setTimeout(() => b.classList.remove("pressed"), 120);
}

const keys = document.getElementById("keys");
keys.addEventListener("pointerdown", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  e.preventDefault();
  pressKey(b);
});
keys.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && e.detail === 0) pressKey(b);
});

Promise.all([
  document.fonts.load('14px "JetBrains Mono"'),
  document.fonts.load('bold 14px "JetBrains Mono"'),
]).catch(() => {}).finally(() => {
  term.open(termEl);
  fit.fit();
  connect();
  if (embedded) {
    term.textarea?.addEventListener("focus", () => parent.postMessage({ yardbell: "focused" }, location.origin));
  } else {
    term.focus();
  }
});
