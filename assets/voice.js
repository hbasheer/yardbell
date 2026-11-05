const SPEAK_KEY = "yardbell.dispatch.speak";
const HOLD_MS = 600;
const MAX_SECONDS = 300;
const UTTERANCE_CHARS = 200;
const SPOKEN_CHARS = 500;
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function insertAt(input, text) {
  const at = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? at;
  const before = input.value.slice(0, at);
  const after = input.value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  input.setRangeText(lead + text + trail, at, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function micProblem(err) {
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
    return "The microphone is blocked. Allow it for this site in the browser, then try again.";
  }
  if (err?.name === "NotFoundError") return "No microphone was found on this device.";
  return `The microphone did not start: ${err?.message || err}`;
}

// A tap toggles recording; holding the button records only while it is held, like push-to-talk.
// Captures mono PCM through Web Audio and packs it into a 16 kHz WAV blob.
// WebKitGTK's MediaRecorder reports a supported type and then fails on start,
// so engines where MediaRecorder never records fall back to this.
function wavCapture(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const grab = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const parts = [];
  grab.onaudioprocess = (e) => parts.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(grab);
  grab.connect(mute);
  mute.connect(ctx.destination);
  return {
    finish() {
      grab.onaudioprocess = null;
      source.disconnect();
      grab.disconnect();
      mute.disconnect();
      const rate = ctx.sampleRate;
      ctx.close();
      for (const track of stream.getTracks()) track.stop();
      return wavBlob(parts, rate);
    },
  };
}

const WAV_RATE = 16000;

function wavBlob(parts, rate) {
  let pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    pcm.set(p, at);
    at += p.length;
  }
  if (rate > WAV_RATE) {
    const step = rate / WAV_RATE;
    const out = new Float32Array(Math.floor(pcm.length / step));
    for (let i = 0; i < out.length; i++) {
      const from = Math.floor(i * step);
      const to = Math.min(pcm.length, Math.floor((i + 1) * step));
      let sum = 0;
      for (let j = from; j < to; j++) sum += pcm[j];
      out[i] = to > from ? sum / (to - from) : 0;
    }
    pcm = out;
    rate = WAV_RATE;
  }
  const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const label = (o, s) => {
    for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i));
  };
  label(0, "RIFF");
  data.setUint32(4, 36 + pcm.length * 2, true);
  label(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  label(36, "data");
  data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  }
  return new Blob([data], { type: "audio/wav" });
}

export function dictation({ button, input, toast }) {
  let recorder = null;
  let wav = null;
  let chunks = [];
  let busy = false;
  let downAt = 0;
  let stopOnUp = false;
  let timer = 0;

  function paint() {
    const recording = Boolean(recorder || wav);
    button.classList.toggle("recording", recording);
    button.classList.toggle("busy", busy);
    button.disabled = busy;
    button.setAttribute("aria-pressed", String(recording));
    button.setAttribute("aria-label", recording ? "Stop recording" : "Dictate");
    button.title = busy
      ? "Transcribing…"
      : recording
        ? "Stop recording and type what was said (Esc discards it)"
        : "Dictate: tap to record, tap again to stop. Holding the button records while held.";
  }

  async function start() {
    if (recorder || wav || busy) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("The browser only allows the microphone on a secure page. Open Yardbell over https, or on the machine it runs on.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast(micProblem(err));
      return;
    }
    const mime = MIMES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    } catch {
      wav = wavCapture(stream);
    }
    if (recorder) {
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data?.size) chunks.push(e.data);
      };
      try {
        recorder.start();
        const r = recorder;
        setTimeout(() => {
          if (recorder === r && r.state !== "recording") {
            recorder = null;
            wav = wavCapture(r.stream);
          }
        }, 250);
      } catch {
        recorder = null;
        wav = wavCapture(stream);
      }
    }
    timer = setTimeout(() => {
      toast(`Recording stops after ${MAX_SECONDS / 60} minutes.`);
      stop(true);
    }, MAX_SECONDS * 1000);
    paint();
  }

  function stop(send) {
    if (wav) {
      const blob = wav.finish();
      wav = null;
      clearTimeout(timer);
      paint();
      if (send && blob.size > 44) transcribe(blob);
      return;
    }
    const r = recorder;
    if (!r) return;
    recorder = null;
    clearTimeout(timer);
    r.onstop = () => {
      for (const track of r.stream.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
      chunks = [];
      if (send && blob.size) transcribe(blob);
    };
    try {
      r.stop();
    } catch {
      for (const track of r.stream.getTracks()) track.stop();
    }
    paint();
  }

  async function transcribe(blob) {
    busy = true;
    paint();
    try {
      const res = await fetch("/dispatch/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      if (res.status === 401) { location.href = "/login"; return; }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
      if (!out.text) {
        toast("No words were heard. Try again a little closer to the microphone.");
        return;
      }
      insertAt(input, out.text);
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      paint();
      input.focus();
    }
  }

  const live = () => Boolean(recorder || wav);
  button.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    downAt = Date.now();
    if (live()) stopOnUp = true;
    else start();
  });
  const up = () => {
    const held = Date.now() - downAt >= HOLD_MS;
    if (live() && (stopOnUp || held)) stop(true);
    stopOnUp = false;
  };
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  // A keyboard press reaches the button as a click with no pointer events before it.
  button.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    if (live()) stop(true);
    else start();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && live()) {
      e.preventDefault();
      stop(false);
    }
  });
  window.addEventListener("pagehide", () => stop(false));
  paint();
}

// Chunks fit one utterance each, since some engines go quiet partway through a long one.
function pieces(text) {
  const out = [];
  let piece = "";
  for (const word of text.split(/\s+/)) {
    const next = piece ? `${piece} ${word}` : word;
    if (next.length > UTTERANCE_CHARS && piece) {
      out.push(piece);
      piece = word;
    } else {
      piece = next;
    }
  }
  if (piece) out.push(piece);
  return out;
}

// One voice for everything said, one thing at a time, silent the moment it is turned off.
export function speaker() {
  const able = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const read = () => {
    try { return localStorage.getItem(SPEAK_KEY) === "1"; } catch { return false; }
  };
  let on = able && read();
  const queue = [];
  let current = null;

  function pump() {
    if (!on || current || !queue.length) return;
    const u = new SpeechSynthesisUtterance(queue.shift());
    current = u;
    u.onend = u.onerror = () => {
      current = null;
      pump();
    };
    speechSynthesis.speak(u);
  }

  return {
    able,
    on: () => on,
    set(value) {
      on = able && Boolean(value);
      try {
        if (on) localStorage.setItem(SPEAK_KEY, "1");
        else localStorage.removeItem(SPEAK_KEY);
      } catch {}
      if (!on && able) {
        queue.length = 0;
        current = null;
        speechSynthesis.cancel();
      }
    },
    sync() {
      const wanted = able && read();
      if (wanted !== on) this.set(wanted);
      return on;
    },
    speak(text) {
      const said = String(text ?? "").trim();
      if (!on || !said) return;
      queue.push(...pieces(said));
      pump();
    },
  };
}

// What a Markdown reply sounds like: prose only. Code and tables read terribly, so they are
// named instead, and a long reply is cut at a word.
export function spoken(markdown) {
  let text = String(markdown ?? "");
  let blocks = 0;
  text = text.replace(/```[\s\S]*?(```|$)/g, () => {
    blocks++;
    return " ";
  });
  const lines = [];
  let tables = 0;
  let inTable = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("|")) {
      if (!inTable) tables++;
      inTable = true;
      continue;
    }
    inTable = false;
    lines.push(line.replace(/^#{1,4}\s+/, "").replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
  }
  text = lines.join("\n")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const named = [
    blocks ? `${blocks === 1 ? "a code block" : `${blocks} code blocks`}` : "",
    tables ? `${tables === 1 ? "a table" : `${tables} tables`}` : "",
  ].filter(Boolean);
  if (named.length) text = `${text} The reply also holds ${named.join(" and ")}.`.trim();
  if (text.length > SPOKEN_CHARS) {
    text = `${text.slice(0, SPOKEN_CHARS).replace(/\s+\S*$/, "")}, and more.`;
  }
  return text;
}
