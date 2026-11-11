import { html, nothing, render, svg } from "/vendor/lit-html/lit-html.js";
import { admit, sizeText } from "/attachments.js";

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
// Each pill stands in the editor's text as one object replacement character, so offsets into the
// text and caret positions in the editor count a pill as one place.
const OBJ = "￼";
const STRAY = /[￼​]/g;
const PASTE_CHARS = 800;
const PASTE_LINES = 15;
const UNDO_SIZE = 200;
const TYPING_MS = 1000;
const BLOCKS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

const ICONS = {
  Machines: '<path d="M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM5 5.5h.01M5 10.5h.01"/>',
  Sessions: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3"/>',
  Folders: '<path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  Tasks: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M9.5 5.5l-3 5"/>',
  paste: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 10.5h4"/>',
};

function iconMarkup(name) {
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ICONS.paste}</svg>`;
}

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

const objects = (text) => text.split(OBJ).length - 1;
const clean = (text) => text.replace(STRAY, "");

function serialize(value, pills) {
  let k = 0;
  return value.replace(/￼/g, () => {
    const pill = pills[k++];
    if (!pill) return "";
    return pill.kind === "paste" ? pill.text : pill.insert;
  });
}

function pastedLabel(text) {
  const lines = text.split("\n").length;
  return `Pasted text · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

// A trailing break the browser keeps only so the last empty line has height.
function tailBreak(root) {
  let node = root.lastChild;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && !node.data) node = node.previousSibling;
    else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== "BR" && !node.dataset.pill && node.lastChild) node = node.lastChild;
    else break;
  }
  return node?.nodeName === "BR" ? node : null;
}

export function composer(form, hooks) {
  const input = document.getElementById("dispatch-input");
  const box = input.closest(".compose-box");
  const menuBox = document.getElementById("compose-menu");
  const sendButton = document.getElementById("dispatch-send");
  const hint = document.getElementById("send-key");
  const hintLabel = hint.querySelector(".compose-plus-label") || hint;
  const filesBox = document.getElementById("compose-files");
  const picker = document.getElementById("attach-input");
  const dropZone = document.getElementById("dispatch-chat");
  const plus = document.getElementById("compose-plus");
  const plusMenu = document.getElementById("compose-plus-menu");
  const touch = window.matchMedia("(hover: none) and (pointer: coarse)");
  const known = new WeakMap();
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
  let attached = [];
  let adding = Promise.resolve();
  let value = "";
  let pills = [];
  let composing = false;
  let lastCaret = null;
  let undo = [];
  let undoAt = -1;
  let lastKind = "";
  let lastAt = 0;
  let lastSent = null;
  let dragging = null;

  function pillNode(pill) {
    const el = document.createElement("span");
    el.className = `compose-pill ${pill.kind}`;
    el.contentEditable = "false";
    el.dataset.pill = pill.kind;
    el.title = pill.kind === "paste" ? "Pasted text. Click to put it back as text." : pill.title || pill.insert || "";
    el.innerHTML = iconMarkup(pill.kind === "paste" ? "paste" : pill.group);
    const label = document.createElement("span");
    label.className = "compose-pill-label";
    label.textContent = pill.label;
    el.append(label);
    known.set(el, pill);
    return el;
  }

  function pieces(parent, text, next) {
    const parts = text.split(OBJ);
    parts.forEach((part, i) => {
      if (i) {
        const pill = next();
        if (pill) parent.append(pillNode(pill));
      }
      if (part) parent.append(document.createTextNode(part));
    });
  }

  function marked(className, text, tick, next) {
    const span = document.createElement("span");
    span.className = className;
    const mark = (t) => {
      const m = document.createElement("span");
      m.className = "compose-tick";
      m.textContent = t;
      span.append(m);
    };
    mark(tick);
    pieces(span, text.slice(tick.length, text.length - tick.length), next);
    mark(tick);
    return span;
  }

  // Backticks stay in the text and in what is sent; only their look changes as they are typed.
  function paint(text, list) {
    const out = document.createDocumentFragment();
    let k = 0;
    const next = () => list[k++];
    let at = 0;
    for (const m of text.matchAll(CODE)) {
      if (m.index > at) pieces(out, text.slice(at, m.index), next);
      const fence = m[0].startsWith("```");
      out.append(marked(fence ? "compose-fence" : "compose-code", m[0], fence ? "```" : "`", next));
      at = m.index + m[0].length;
    }
    if (at < text.length) pieces(out, text.slice(at), next);
    if (text.endsWith("\n")) {
      const br = document.createElement("br");
      br.dataset.tail = "";
      out.append(br);
    }
    return out;
  }

  function scan(point) {
    let text = "";
    const list = [];
    let caret = null;
    const tail = tailBreak(input);
    const mark = (extra = 0) => {
      if (caret === null) caret = text.length + extra;
    };
    const walk = (node) => {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        if (point && point.node === node && point.offset === i) mark();
        const child = kids[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (point && point.node === child) mark(clean(child.data.slice(0, point.offset)).length);
          text += clean(child.data);
        } else if (child.nodeType !== Node.ELEMENT_NODE) {
          continue;
        } else if (child.dataset.pill) {
          text += OBJ;
          const label = child.textContent.trim();
          list.push(known.get(child) || { kind: "name", label, insert: label });
          if (point && child.contains(point.node)) mark();
        } else if (child.tagName === "BR") {
          if (child !== tail && child.dataset.tail === undefined) text += "\n";
        } else {
          if (BLOCKS.has(child.tagName) && text && !text.endsWith("\n")) text += "\n";
          walk(child);
        }
      }
      if (point && point.node === node && point.offset === kids.length) mark();
    };
    walk(input);
    return { text, list, caret };
  }

  function place(offset) {
    if (document.activeElement !== input) return;
    const range = document.createRange();
    let acc = 0;
    let done = false;
    const walk = (node) => {
      for (let i = 0; i < node.childNodes.length && !done; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (offset <= acc + child.data.length) {
            range.setStart(child, offset - acc);
            done = true;
          } else {
            acc += child.data.length;
          }
        } else if (child.nodeType !== Node.ELEMENT_NODE) {
          continue;
        } else if (child.dataset.pill || child.tagName === "BR") {
          if (offset <= acc || child.dataset.tail !== undefined) {
            range.setStart(node, i);
            done = true;
          } else {
            acc += 1;
          }
        } else {
          walk(child);
        }
      }
    };
    walk(input);
    if (!done) range.setStart(input, input.childNodes.length);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function inside() {
    const sel = getSelection();
    return sel.rangeCount > 0 && input.contains(sel.anchorNode) && input.contains(sel.focusNode);
  }

  function selection() {
    if (!inside()) {
      const at = Math.min(lastCaret ?? value.length, value.length);
      return { start: at, end: at };
    }
    const range = getSelection().getRangeAt(0);
    const start = scan({ node: range.startContainer, offset: range.startOffset }).caret ?? value.length;
    const end = range.collapsed ? start : scan({ node: range.endContainer, offset: range.endOffset }).caret ?? start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  function repaint(caret) {
    const fresh = paint(value, pills);
    const probe = document.createElement("div");
    probe.append(fresh.cloneNode(true));
    if (probe.innerHTML !== input.innerHTML) {
      input.replaceChildren(fresh);
      if (caret !== null && caret !== undefined) place(caret);
    }
  }

  function atBottom() {
    const s = hooks.scroller();
    return s.scrollHeight - s.scrollTop - s.clientHeight < 24;
  }

  function fit() {
    const pinned = atBottom();
    input.classList.toggle("is-empty", !value);
    sendButton.disabled = !serialize(value, pills).trim() && !attached.length;
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
    if (serialize(value, pills).trim()) all[key] = pills.length ? { value, pills } : value;
    else delete all[key];
    saveDrafts(all);
  }

  function snapshot() {
    return { value, pills: pills.slice(), caret: selection().end };
  }

  function remember(kind) {
    const top = undo[undoAt];
    if (top && top.value === value && top.pills.length === pills.length && top.pills.every((p, i) => p === pills[i])) return;
    const now = Date.now();
    if ((kind === "type" || kind === "delete") && kind === lastKind && now - lastAt < TYPING_MS && undoAt > 0) {
      undo[undoAt] = snapshot();
    } else {
      undo = undo.slice(0, undoAt + 1);
      undo.push(snapshot());
      if (undo.length > UNDO_SIZE) undo.shift();
      undoAt = undo.length - 1;
    }
    lastKind = kind;
    lastAt = now;
  }

  function resetUndo() {
    undo = [snapshot()];
    undoAt = 0;
    lastKind = "";
  }

  function changed() {
    fit();
    saveDraft();
    onCaret();
  }

  function setDoc(text, list, caret = text.length) {
    value = text;
    pills = list;
    repaint(caret);
    lastCaret = caret;
  }

  function setPlain(text) {
    setDoc(clean(String(text ?? "")).replace(/\r\n?/g, "\n"), []);
  }

  function setDraft(draft) {
    if (draft && typeof draft === "object" && typeof draft.value === "string" && Array.isArray(draft.pills)
      && objects(draft.value) === draft.pills.length) setDoc(draft.value.replace(/​/g, ""), draft.pills.slice());
    else setPlain(typeof draft === "string" ? draft : "");
  }

  function edit(start, end, text, add = [], caret = start + text.length) {
    const before = objects(value.slice(0, start));
    const gone = objects(value.slice(start, end));
    pills.splice(before, gone, ...add);
    value = value.slice(0, start) + text + value.slice(end);
    repaint(caret);
    lastCaret = caret;
    recall = null;
    remember("edit");
    changed();
  }

  function typed(type, data) {
    const range = inside() ? getSelection().getRangeAt(0) : null;
    const read = scan(range && { node: range.endContainer, offset: range.endOffset });
    value = read.text;
    pills = read.list;
    repaint(read.caret);
    if (read.caret !== null) lastCaret = read.caret;
    recall = null;
    const kind = type === "insertText" && data && !/\s/.test(data) ? "type" : type?.startsWith("delete") ? "delete" : "edit";
    remember(kind);
    changed();
  }

  function restoreFrom(state) {
    setDoc(state.value, state.pills.slice(), state.caret);
    recall = null;
    lastKind = "";
    changed();
  }

  function stepUndo(by) {
    const at = undoAt + by;
    if (at < 0 || at >= undo.length) return;
    undoAt = at;
    restoreFrom(undo[at]);
  }

  function showMode() {
    const enter = mode === "enter";
    hintLabel.textContent = enter ? "Enter to send, Shift+Enter for a new line" : `${MOD}+Enter to send, Enter for a new line`;
    hint.title = enter ? `Send with ${MOD}+Enter instead, so Enter starts a new line` : "Send with Enter instead";
    input.enterKeyHint = enter ? "send" : "enter";
    sendButton.title = `Send (${enter ? "Enter" : `${MOD}+Enter`})`;
  }

  function kept() {
    const list = read(HISTORY_KEY, []);
    return Array.isArray(list) ? list.filter((t) => typeof t === "string" && t.trim()) : [];
  }

  const removeIcon = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

  function drawFiles() {
    filesBox.hidden = !attached.length;
    render(attached.map((a, i) => html`<span class="compose-file ${a.url ? "image" : "doc"}" title=${`${a.file.name} · ${sizeText(a.file.size)}`}>${a.url
      ? html`<img src=${a.url} alt="">`
      : html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/></svg><span class="compose-file-name">${a.file.name}</span><span class="compose-file-size">${sizeText(a.file.size)}</span>`}<button class="compose-file-remove" type="button" aria-label=${`Remove ${a.file.name}`} @mousedown=${(e) => e.preventDefault()} @click=${() => removeFile(i)}>${removeIcon}</button></span>`), filesBox);
    fit();
  }

  function removeFile(index) {
    const [gone] = attached.splice(index, 1);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    drawFiles();
    input.focus();
  }

  function clearFiles() {
    for (const a of attached) if (a.url) URL.revokeObjectURL(a.url);
    attached = [];
    drawFiles();
  }

  async function addFiles(list) {
    for (const file of list) {
      if (attached.some((a) => a.file.name === file.name && a.file.size === file.size && a.file.lastModified === file.lastModified)) continue;
      const { kind, error } = await admit(file, attached, hooks.runsOn());
      if (error) {
        hooks.toast(error);
        continue;
      }
      attached.push({ file, kind, url: kind === "image" ? URL.createObjectURL(file) : null });
    }
    drawFiles();
  }

  // Files checked one batch at a time, so two quick drops cannot both pass the count or the total.
  function attach(list) {
    const files = [...list];
    if (files.length) adding = adding.then(() => addFiles(files));
    return adding;
  }

  function submit() {
    const text = serialize(value, pills).trim();
    const files = attached.map(({ file, kind }) => ({ file, kind }));
    if ((!text && !files.length) || !hooks.send(text, files)) return;
    if (text) write(HISTORY_KEY, [text, ...kept().filter((t) => t !== text)].slice(0, HISTORY_SIZE));
    lastSent = { text, value, pills: pills.slice() };
    setDoc("", []);
    clearFiles();
    recall = null;
    hide();
    saveDraft();
    resetUndo();
    fit();
  }

  function browsing() {
    return Boolean(recall) && !pills.length && value === (recall.index < 0 ? "" : recall.list[recall.index]);
  }

  // -1 is the empty box the browsing started from; 0 is the newest message.
  function recallAt(index) {
    if (!recall) recall = { list: [...new Set([...hooks.sent().slice().reverse(), ...kept()])], index: -1 };
    if (index < -1 || index >= recall.list.length) return;
    recall.index = index;
    setPlain(index < 0 ? "" : recall.list[index]);
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
      ? hooks.tasks().map((t) => ({ group: "Tasks", label: t.name, detail: t.text, insert: t.text, rank: rank(query, t.name, t.text) }))
      : (names || []).map((n) => ({ ...n, rank: rank(query, n.label, n.insert, ...n.also) }));
    menu.items = found
      .filter((item) => item.rank !== null)
      .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.rank - b.rank || Boolean(a.outside) - Boolean(b.outside));
    menu.active = Math.min(menu.active, Math.max(0, menu.items.length - 1));
    draw();
  }

  function trigger() {
    if (document.activeElement !== input || !inside() || composing) return null;
    const { start, end } = selection();
    if (start !== end) return null;
    const next = value.charAt(start);
    if (next && !/\s/.test(next)) return null;
    const m = value.slice(0, start).match(TRIGGER);
    if (!m) return null;
    const query = m[1] ?? m[2];
    return { kind: m[1] !== undefined ? "task" : "name", query, start: start - query.length - 1, end: start };
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
    const was = menu;
    menu = null;
    draw();
    if (was.button && value.slice(was.start, was.end) === char) {
      edit(was.start, was.end, "");
    } else if (dismiss) {
      dismissed = was.start;
    }
  }

  function pick(i) {
    const item = menu?.items[i];
    if (!item) return;
    const { start, end, kind } = menu;
    const space = /^\s/.test(value.slice(end)) ? "" : " ";
    dismissed = -1;
    menu = null;
    draw();
    if (kind === "task") {
      edit(start, end, item.insert + space);
      return;
    }
    const pill = { kind: "name", group: item.group, label: item.label, insert: item.insert, title: item.detail };
    edit(start, end, OBJ + space, [pill]);
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
    const { start: at, end } = selection();
    const lead = /(^|\s)$/.test(value.slice(0, at)) ? "" : " ";
    const trail = /^(\s|$)/.test(value.slice(end)) ? "" : " ";
    dismissed = -1;
    edit(at, end, lead + char + trail, [], at + lead.length + 1);
    if (menu) menu.button = true;
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

  const OPTION_ICONS = {
    Machines: svg`<path d="M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM5 5.5h.01M5 10.5h.01"/>`,
    Sessions: svg`<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3"/>`,
    Folders: svg`<path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>`,
    Tasks: svg`<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M9.5 5.5l-3 5"/>`,
  };
  const optionIcon = (group) => html`<svg class="icon compose-option-icon" viewBox="0 0 16 16" aria-hidden="true">${OPTION_ICONS[group]}</svg>`;

  function option(item, i) {
    const active = i === menu.active;
    return html`<div class="compose-option ${active ? "active" : ""}" role="option" id="compose-option-${i}" aria-selected=${active ? "true" : "false"}
      @mousedown=${(e) => e.preventDefault()} @mousemove=${() => point(i)} @click=${() => pick(i)}>
      ${optionIcon(item.group)}
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
    input.setAttribute("aria-expanded", String(open));
    if (open && menu.items.length) input.setAttribute("aria-activedescendant", `compose-option-${menu.active}`);
    else input.removeAttribute("aria-activedescendant");
    if (!open) {
      render(nothing, menuBox);
      return;
    }
    closePlus();
    menuBox.setAttribute("aria-label", menu.kind === "task" ? "Tasks" : "Machines, sessions and folders");
    menuBox.style.maxHeight = `${room()}px`;
    render(menuView(), menuBox);
    reveal();
  }

  function openPlus() {
    hide();
    plusMenu.hidden = false;
    plus.setAttribute("aria-expanded", "true");
    plusMenu.querySelector("[role=menuitem]:not([hidden])")?.focus();
  }

  function closePlus(back) {
    if (plusMenu.hidden) return;
    plusMenu.hidden = true;
    plus.setAttribute("aria-expanded", "false");
    if (back) input.focus();
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

  function insertText(text) {
    const { start, end } = selection();
    if (text.length > PASTE_CHARS || text.split("\n").length > PASTE_LINES) {
      const space = /^\s/.test(value.slice(end)) ? "" : " ";
      edit(start, end, OBJ + space, [{ kind: "paste", label: pastedLabel(text), text }]);
      return;
    }
    edit(start, end, text);
  }

  function expand(el) {
    const parent = el.parentNode;
    const at = scan({ node: parent, offset: [...parent.childNodes].indexOf(el) }).caret;
    const pill = known.get(el);
    if (at === null || !pill || pill.kind !== "paste") return;
    input.focus();
    edit(at, at + 1, pill.text, [], at + pill.text.length);
  }

  function clip(e, cut) {
    const { start, end } = selection();
    if (start === end || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", serialize(value.slice(start, end), pills.slice(objects(value.slice(0, start)))));
    if (cut) edit(start, end, "");
  }

  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (menu && menuKey(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && (k === "z" || k === "y")) {
      e.preventDefault();
      stepUndo(k === "y" || e.shiftKey ? 1 : -1);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && ["b", "i", "u"].includes(k)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mod || (mode === "enter" && !e.shiftKey && !e.altKey)) submit();
      else insertText("\n");
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !mod && !e.altKey) {
      const { start, end } = selection();
      const at = e.key === "Backspace" ? start - 1 : start;
      if (start === end && value.charAt(at) === OBJ) {
        e.preventDefault();
        edit(at, at + 1, "");
        return;
      }
    }
    if (mod || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowUp" && (browsing() || !value)) {
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

  input.addEventListener("beforeinput", (e) => {
    const type = e.inputType || "";
    if (type.startsWith("format")) {
      e.preventDefault();
    } else if (type === "historyUndo" || type === "historyRedo") {
      e.preventDefault();
      stepUndo(type === "historyUndo" ? -1 : 1);
    } else if ((type === "insertParagraph" || type === "insertLineBreak") && !e.isComposing) {
      e.preventDefault();
      if (type === "insertParagraph" && mode === "enter") submit();
      else insertText("\n");
    }
  });

  input.addEventListener("input", (e) => {
    if (e.isComposing || composing) return;
    typed(e.inputType, e.data);
  });
  input.addEventListener("compositionstart", () => {
    composing = true;
    hide();
  });
  input.addEventListener("compositionend", (e) => {
    composing = false;
    typed("insertText", e.data);
  });
  input.addEventListener("click", (e) => {
    const pill = e.target.closest?.(".compose-pill.paste");
    if (pill) expand(pill);
    else onCaret();
  });
  input.addEventListener("focus", () => {
    if (!inside()) place(Math.min(lastCaret ?? value.length, value.length));
  });
  input.addEventListener("copy", (e) => clip(e, false));
  input.addEventListener("cut", (e) => clip(e, true));
  input.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const files = data.files;
    if (files?.length) attach(files);
    if (!data.types.includes("text/plain")) return;
    const text = clean(data.getData("text/plain").replace(/\r\n?/g, "\n"));
    if (text) insertText(text);
  });
  function dropPoint(e) {
    let range = null;
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    } else {
      range = document.caretRangeFromPoint?.(e.clientX, e.clientY) || null;
    }
    if (!range || !input.contains(range.startContainer)) return null;
    return scan({ node: range.startContainer, offset: range.startOffset }).caret;
  }

  // Text dragged in, or moved within the box, goes in as plain text so pills keep what they stand for.
  input.addEventListener("dragstart", () => {
    dragging = selection();
  });
  input.addEventListener("dragend", () => {
    dragging = null;
  });
  input.addEventListener("drop", (e) => {
    if (e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    const at = dropPoint(e);
    const moved = dragging;
    dragging = null;
    input.focus();
    if (moved && moved.start !== moved.end) {
      if (at === null || (at >= moved.start && at <= moved.end)) return;
      const text = value.slice(moved.start, moved.end);
      const list = pills.slice(objects(value.slice(0, moved.start)), objects(value.slice(0, moved.end)));
      edit(moved.start, moved.end, "");
      const to = at > moved.end ? at - text.length : at;
      edit(to, to, text, list);
      return;
    }
    const text = clean((e.dataTransfer?.getData("text/plain") || "").replace(/\r\n?/g, "\n"));
    if (!text) return;
    if (at !== null) place(at);
    insertText(text);
  });
  document.addEventListener("selectionchange", () => {
    if (!inside()) return;
    lastCaret = selection().end;
  });
  const carriesFiles = (e) => e.dataTransfer?.types.includes("Files");
  for (const type of ["dragenter", "dragover"]) {
    dropZone.addEventListener(type, (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      box.classList.add("dropping");
    });
  }
  dropZone.addEventListener("dragleave", (e) => {
    if (!dropZone.contains(e.relatedTarget)) box.classList.remove("dropping");
  });
  dropZone.addEventListener("drop", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    box.classList.remove("dropping");
    attach(e.dataTransfer.files);
  });
  document.getElementById("attach-file").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    attach(picker.files).then(() => input.focus());
    picker.value = "";
  });
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

  plus.addEventListener("mousedown", (e) => e.preventDefault());
  plus.addEventListener("click", () => (plusMenu.hidden ? openPlus() : closePlus(true)));
  plusMenu.addEventListener("click", (e) => {
    if (e.target.closest("[role=menuitem]")) closePlus(false);
  });
  plusMenu.addEventListener("keydown", (e) => {
    const items = [...plusMenu.querySelectorAll("[role=menuitem]:not([hidden])")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePlus(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!plusMenu.hidden && !plusMenu.contains(e.target) && !plus.contains(e.target)) closePlus(false);
  });

  hint.addEventListener("click", () => {
    mode = mode === "enter" ? "mod" : "enter";
    write(SEND_KEY, mode);
    showMode();
    input.focus();
  });

  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => serialize(value, pills),
    set: (text) => {
      setPlain(text);
      fit();
      saveDraft();
    },
  });

  window.visualViewport?.addEventListener("resize", queueViewport);
  window.visualViewport?.addEventListener("scroll", queueViewport);
  showMode();
  fitViewport();
  fit();
  resetUndo();

  return {
    show(id) {
      if ((id || "new") !== key) clearFiles();
      key = id || "new";
      recall = null;
      dismissed = -1;
      hide();
      setDraft(drafts()[key]);
      lastCaret = null;
      resetUndo();
      fit();
    },
    adopt(id) {
      const all = drafts();
      delete all[key];
      saveDrafts(all);
      key = id;
      saveDraft();
    },
    restore(text, files) {
      if (lastSent && lastSent.text === text) setDoc(lastSent.value, lastSent.pills.slice());
      else setPlain(text);
      resetUndo();
      saveDraft();
      fit();
      attach(files.map((f) => f.file));
    },
    keep(ids) {
      const all = drafts();
      for (const k of Object.keys(all)) if (k !== "new" && !ids.includes(k)) delete all[k];
      saveDrafts(all);
    },
    fill(text) {
      setPlain(text);
      input.focus();
      place(value.length);
      remember("edit");
      changed();
    },
    insert(text) {
      const said = clean(String(text ?? "")).trim();
      if (!said) return;
      input.focus();
      const { start, end } = selection();
      const before = value.slice(0, start);
      const after = value.slice(end);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const trail = after && !/^\s/.test(after) ? " " : "";
      edit(start, end, lead + said + trail);
    },
  };
}
