// The dictation shortcut, kept per device. A Mac's default avoids Control+Space, which macOS
// takes for switching keyboard input sources.
(() => {
  const KEY = "yardbell.voice.shortcut";
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || "");
  const MODIFIER_CODES = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight"];

  function defaults(mac = isMac) {
    return mac
      ? { code: "KeyE", ctrl: false, shift: false, alt: false, meta: true }
      : { code: "Space", ctrl: true, shift: true, alt: false, meta: false };
  }

  function valid(b) {
    return Boolean(b && typeof b.code === "string" && b.code && !MODIFIER_CODES.includes(b.code) && (b.ctrl || b.alt || b.meta));
  }

  function get() {
    try {
      const kept = JSON.parse(localStorage.getItem(KEY) || "null");
      if (valid(kept)) return kept;
    } catch {}
    return defaults();
  }

  function set(b) {
    if (!valid(b)) throw new Error("A shortcut needs Control, Option or Command with another key.");
    const same = JSON.stringify(b) === JSON.stringify(defaults());
    try {
      if (same) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(b));
    } catch {}
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch {}
  }

  function fromEvent(e) {
    return { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
  }

  function matches(e, b = get()) {
    return e.code === b.code && e.ctrlKey === b.ctrl && e.shiftKey === b.shift && e.altKey === b.alt && e.metaKey === b.meta;
  }

  // Letting go of the key or of any modifier it holds ends a hold.
  function releases(e, b = get()) {
    if (e.code === b.code) return true;
    const side = { ctrl: "Control", shift: "Shift", alt: "Alt", meta: "Meta" };
    return Object.entries(side).some(([flag, name]) => b[flag] && (e.code.startsWith(name) || (name === "Meta" && e.code.startsWith("OS"))));
  }

  function keyName(code) {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return { Space: "Space", Enter: "Enter", Backquote: "`", Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\" }[code] || code;
  }

  function parts(b = get(), mac = isMac) {
    const out = [];
    if (mac) {
      if (b.ctrl) out.push("⌃");
      if (b.alt) out.push("⌥");
      if (b.shift) out.push("⇧");
      if (b.meta) out.push("⌘");
    } else {
      if (b.ctrl) out.push("Ctrl");
      if (b.alt) out.push("Alt");
      if (b.shift) out.push("Shift");
      if (b.meta) out.push("Super");
    }
    out.push(keyName(b.code));
    return out;
  }

  function label(b = get(), mac = isMac) {
    return parts(b, mac).join(mac ? "" : "+");
  }

  window.YardbellVoiceKeys = { KEY, isMac, defaults, valid, get, set, reset, fromEvent, matches, releases, parts, label };
})();
