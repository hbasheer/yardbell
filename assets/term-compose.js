import { dictation } from "/voice.js";

const where = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
const dock = document.getElementById("term-dock");
const [, machine, name] = where;
const UPLOAD_MAX = 10 * 1024 * 1024;
// Claude Code reads text and Enter in one burst as a paste with a line break, so Enter waits.
const ENTER_AFTER_MS = 150;
const MIC_ON = '<svg class="icon mic-on" viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="1.5" width="4" height="7.5" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5"/></svg><svg class="icon mic-off" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1"/></svg>';
const CLIP = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 7.5l-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5l5.4-5.4a2.1 2.1 0 0 1 3 3L6.3 11.2a1 1 0 0 1-1.5-1.5L9.7 4.8"/></svg>';
const SEND = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
const CLOSE = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shellPath(path) {
  return path.replace(/([\\ ])/g, "\\$1");
}

if (dock && where[0] === "term" && machine !== "_onboarding" && name) {
  const box = document.createElement("form");
  box.className = "term-compose";
  box.hidden = true;
  box.setAttribute("aria-label", "Message to the session");
  box.innerHTML = `
    <div class="dictation-pill" role="group" aria-label="Dictation" hidden></div>
    <div class="term-compose-files" hidden></div>
    <textarea class="term-compose-text" rows="1" placeholder="Message ${name.replace(/[&<>"']/g, "")}" aria-label="Message" spellcheck="true" enterkeyhint="enter"></textarea>
    <p class="term-compose-status" role="status" hidden></p>
    <div class="term-compose-bar">
      <button class="compose-tool icon-only" type="button" data-act="close" aria-label="Close" title="Close">${CLOSE}</button>
      <button class="compose-tool icon-only" type="button" data-act="attach" aria-label="Attach a file" title="Attach an image or a text file. It is put on the session's machine and its path goes in the message.">${CLIP}</button>
      <button class="compose-tool icon-only mic" type="button" aria-pressed="false" aria-label="Dictate">${MIC_ON}</button>
      <span class="term-compose-gap"></span>
      <button class="compose-send" type="submit" aria-label="Send" title="Type it into the session and press Enter" disabled>${SEND}</button>
    </div>
    <input type="file" multiple hidden accept="image/*,text/*,application/pdf,.md,.txt,.log,.json,.yml,.yaml,.csv,.diff,.patch">`;
  dock.prepend(box);

  const text = box.querySelector("textarea");
  const files = box.querySelector(".term-compose-files");
  const status = box.querySelector(".term-compose-status");
  const mic = box.querySelector(".mic");
  const sendBtn = box.querySelector(".compose-send");
  const picker = box.querySelector("input[type=file]");
  let voice = null;
  let statusTimer = 0;
  const uploads = new Set();

  function say(message, { error = false, ms = 6000 } = {}) {
    status.textContent = message;
    status.classList.toggle("error", error);
    status.hidden = !message;
    clearTimeout(statusTimer);
    if (message && ms) statusTimer = setTimeout(() => { status.hidden = true; }, ms);
  }

  function fit() {
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight + text.offsetHeight - text.clientHeight, 160)}px`;
    sendBtn.disabled = !text.value.trim() || uploads.size > 0;
  }

  function insert(words) {
    const at = text.selectionStart ?? text.value.length;
    const end = text.selectionEnd ?? at;
    const before = text.value.slice(0, at);
    const after = text.value.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    text.value = `${before}${lead}${words}${tail}${after}`;
    const caret = before.length + lead.length + words.length + tail.length;
    text.setSelectionRange(caret, caret);
    fit();
  }

  function open() {
    box.hidden = false;
    dock.classList.add("composing");
    mic.hidden = false;
    fit();
    text.focus({ preventScroll: true });
    loadVoice();
  }

  function close() {
    if (mic.classList.contains("recording")) mic.click();
    box.hidden = true;
    mic.hidden = true;
    dock.classList.remove("composing");
    say("");
  }

  function send() {
    const message = text.value.replace(/\s+$/, "");
    if (!message.trim() || uploads.size || !window.YardbellTerm) return;
    window.YardbellTerm.paste(message);
    setTimeout(() => window.YardbellTerm.send("\r"), ENTER_AFTER_MS);
    text.value = "";
    files.replaceChildren();
    files.hidden = true;
    fit();
    close();
  }

  function chip(file) {
    const el = document.createElement("div");
    el.className = "term-file";
    el.innerHTML = `<span class="term-file-name"></span><span class="term-file-state"></span><button type="button" class="dict-btn" aria-label="Remove">${CLOSE}</button>`;
    el.querySelector(".term-file-name").textContent = file.name;
    el.querySelector("button").addEventListener("click", () => {
      el.xhr?.abort();
      el.remove();
      files.hidden = !files.children.length;
    });
    files.append(el);
    files.hidden = false;
    return el;
  }

  function mark(el, state, words) {
    el.dataset.state = state;
    el.querySelector(".term-file-state").textContent = words;
  }

  function upload(file) {
    const el = chip(file);
    if (!file.size) return mark(el, "failed", "empty file");
    if (file.size > UPLOAD_MAX) return mark(el, "failed", `over ${UPLOAD_MAX / 1024 / 1024} MB`);
    mark(el, "sending", `0% of ${sizeText(file.size)}`);
    const xhr = new XMLHttpRequest();
    el.xhr = xhr;
    uploads.add(xhr);
    fit();
    const done = () => {
      uploads.delete(xhr);
      el.xhr = null;
      fit();
    };
    xhr.open("POST", `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) mark(el, "sending", `${Math.round((e.loaded / e.total) * 100)}% of ${sizeText(file.size)}`);
    };
    xhr.onload = () => {
      done();
      if (xhr.status === 401) { location.href = "/login"; return; }
      let out = {};
      try { out = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status < 200 || xhr.status >= 300 || !out.path) {
        mark(el, "failed", out.error || `upload failed (${xhr.status})`);
        say(`${file.name}: ${out.error || "the upload failed"}`, { error: true, ms: 0 });
        return;
      }
      mark(el, "done", "added");
      el.title = out.path;
      insert(shellPath(out.path));
    };
    xhr.onerror = () => {
      done();
      mark(el, "failed", "no connection");
      say(`${file.name} did not upload. Check the connection and attach it again.`, { error: true, ms: 0 });
    };
    xhr.onabort = done;
    xhr.send(file);
  }

  function attach(list) {
    for (const file of list) upload(file);
  }

  async function loadVoice() {
    if (voice) return;
    voice = { voice_input: false, voice_mode: "auto" };
    try {
      const res = await fetch("/dispatch/runs-on", { headers: { Accept: "application/json" } });
      if (res.ok) voice = await res.json();
    } catch {}
    mic.classList.toggle("voice-off", !voice.voice_input);
  }

  // With voice input off, the mic says where to turn it on instead of recording.
  for (const type of ["pointerdown", "pointerup", "click"]) {
    mic.addEventListener(type, (e) => {
      if (voice?.voice_input) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type === "click") say("Voice input is off. Turn it on in Settings, under Voice.", { ms: 8000 });
    }, true);
  }
  document.addEventListener("keydown", (e) => {
    if (mic.hidden || voice?.voice_input || !window.YardbellVoiceKeys?.matches(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    say("Voice input is off. Turn it on in Settings, under Voice.", { ms: 8000 });
  }, true);
  mic.hidden = true;
  dictation({
    button: mic,
    pill: box.querySelector(".dictation-pill"),
    insert,
    toast: (message) => say(message, { error: true }),
    mode: () => voice?.voice_mode || "auto",
  });

  text.addEventListener("input", fit);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !mic.classList.contains("recording")) {
      e.preventDefault();
      close();
    }
  });
  box.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  box.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") close();
    if (act === "attach") picker.click();
  });
  picker.addEventListener("change", () => {
    attach([...picker.files]);
    picker.value = "";
  });
  text.addEventListener("paste", (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (!pasted.length) return;
    e.preventDefault();
    attach(pasted);
  });

  window.addEventListener("yardbell-compose", (e) => (e.detail?.open === false ? close() : open()));
  window.YardbellCompose = { open, close, attach, send };
}
