import { html, nothing, render } from "/vendor/lit-html/lit-html.js";

const SPEAK_KEY = "yardbell.dispatch.speak";
const HOLD_MS = 600;
const MAX_SECONDS = 300;
const UTTERANCE_CHARS = 200;
const SPOKEN_CHARS = 500;
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function micProblem(err) {
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
    return "The microphone is blocked. Allow it for this site in the browser, then try again.";
  }
  if (err?.name === "NotFoundError") return "No microphone was found on this device.";
  return `The microphone did not start: ${err?.message || err}`;
}

// Captures mono PCM through Web Audio and packs it into a 16 kHz WAV blob.
// WebKitGTK's MediaRecorder reports a supported type and then fails on start,
// so engines where MediaRecorder never records fall back to this.
// Shares the level meter's AudioContext when there is one: a second context on the same
// microphone can leave this one without samples on some audio servers.
function wavCapture(stream, shared) {
  const ctx = shared || new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const grab = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  let parts = [];
  grab.onaudioprocess = (e) => parts.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  source.connect(grab);
  grab.connect(mute);
  mute.connect(ctx.destination);
  const take = () => {
    const blob = wavBlob(parts, ctx.sampleRate);
    parts = [];
    return blob;
  };
  return {
    cut: take,
    finish() {
      grab.onaudioprocess = null;
      source.disconnect();
      grab.disconnect();
      mute.disconnect();
      const blob = take();
      if (!shared) ctx.close();
      for (const track of stream.getTracks()) track.stop();
      return blob;
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

const SILENCE_MS = 3000;
const PAUSE_MS = 600;
const CHUNK_MS = 20000;
const MIC_KEY = "yardbell.voice.mic";
const SHORTCUT = "Ctrl+Shift+Space";
// Dot sizes and how far each moves with the voice.
const GRAPES = [
  [0.64, 0.45, 1], [0.76, 0.75, -1], [0.9, 1, 1], [1, 1.25, -1], [0.86, 0.9, 1],
  [0.72, 1.1, -1], [0.82, 0.7, 1], [0.68, 0.55, -1], [0.58, 0.35, 1],
];

const X_ICON = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;
const CHECK_ICON = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;
const SPIN_ICON = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2a6 6 0 1 1-6 6"/></svg>`;
const ALERT_ICON = html`<svg class="icon dict-alert" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v3.8M8 11h.01"/></svg>`;

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The loudness of the microphone, read on every frame, with whether it sounds like speech. The
// floor follows the room, so a fan or a steady hum stops counting as speech after a while.
function levelMeter(stream, onFrame) {
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return null;
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  const samples = new Float32Array(analyser.fftSize);
  let floor = 0.008;
  let smooth = 0;
  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const x of samples) sum += x * x;
    const rms = Math.sqrt(sum / samples.length);
    const speaking = rms > Math.max(0.02, floor * 3);
    floor = speaking ? floor + (rms - floor) * 0.002 : floor * 0.9 + rms * 0.1;
    smooth = smooth * 0.6 + Math.min(1, Math.max(0, (rms - floor) / 0.12)) * 0.4;
    onFrame(smooth, speaking, performance.now());
  };
  frame = requestAnimationFrame(tick);
  return {
    ctx,
    stop() {
      cancelAnimationFrame(frame);
      source.disconnect();
      ctx.close().catch(() => {});
    },
  };
}

function chosenMic() {
  try { return localStorage.getItem(MIC_KEY) || ""; } catch { return ""; }
}

async function openMic(toast) {
  const id = chosenMic();
  if (!id) return navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
  } catch (err) {
    if (!["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(err?.name)) throw err;
    toast("The microphone chosen in Settings is not connected, so the system default is used.");
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

// The recording is cut at each pause in speech (and every 20 seconds at most), and each piece is
// transcribed while the next is still being spoken, so words appear as you talk. Pieces go to the
// server one at a time and land in the order they were said. Cancel drops what has not landed yet
// and keeps the words already typed in.
export function dictation({ button, pill, insert, toast, mode = () => "auto" }) {
  let stream = null;
  let segment = null;
  let wav = null;
  let meter = null;
  let phase = "idle";
  let startedAt = 0;
  let seconds = 0;
  let ticker = 0;
  let timer = 0;
  let segmentAt = 0;
  let heardAt = 0;
  let segmentHeard = false;
  let queue = [];
  let closing = 0;
  let sending = false;
  let wrote = false;
  let queued = false;
  let aborter = null;
  let downAt = 0;
  let stopOnUp = false;
  let keyAt = 0;
  let keyStop = false;
  let starting = false;
  let releasedEarly = false;

  const live = () => Boolean(segment || wav);

  function level(value) {
    pill.querySelectorAll(".dict-grape").forEach((dot, i) => {
      const [base, response, lift] = GRAPES[i];
      dot.style.transform = `translateY(${value * lift * 2}px) scale(${base + value * response})`;
    });
  }

  function view() {
    if (phase === "failed") {
      return html`<span class="visually-hidden" role="status" aria-live="polite">Could not transcribe. The recording is kept.</span>
        <button type="button" class="dict-btn" aria-label="Discard recording" title="Discard recording" @click=${discard}>${X_ICON}</button>
        ${ALERT_ICON}
        <span class="dict-status">Couldn't transcribe. Recording kept.</span>
        <button type="button" class="dict-retry" @click=${retry}>Retry</button>`;
    }
    const waiting = phase === "transcribing";
    const status = waiting ? "Transcribing…" : "Listening…";
    return html`<span class="visually-hidden" role="status" aria-live="polite">${status}</span>
      <button type="button" class="dict-btn" aria-label="Cancel" title="Cancel (Esc)" @click=${cancel}>${X_ICON}</button>
      <span class="dict-grapes ${waiting ? "resting" : ""}" aria-hidden="true">${GRAPES.map(() => html`<span class="dict-grape"></span>`)}</span>
      <span class="dict-status" aria-hidden="true">${status}</span>
      <span class="dict-time" aria-hidden="true">${clock(seconds)}</span>
      ${waiting
        ? html`<span class="dict-wait" aria-hidden="true">${SPIN_ICON}</span>`
        : html`<button type="button" class="dict-btn finish" aria-label="Finish" title=${`Finish and type it in (${SHORTCUT})`} @click=${() => stop(true)}>${CHECK_ICON}</button>`}`;
  }

  function hint() {
    const how = {
      auto: "Tap to start and stop, or hold to talk. Words appear at each pause, and it stops by itself after a few seconds of quiet.",
      hold: "Hold to talk, and let go to stop. Words appear at each pause.",
      toggle: "Press to start, and again to stop. Words appear at each pause.",
    }[mode()] || "";
    return `Dictate (${SHORTCUT}). ${how}`;
  }

  function paint() {
    const recording = live();
    const busy = phase === "transcribing";
    button.classList.toggle("recording", recording);
    button.classList.toggle("busy", busy);
    button.disabled = busy;
    button.setAttribute("aria-pressed", String(recording));
    button.setAttribute("aria-label", recording ? "Stop recording" : "Dictate");
    button.title = busy
      ? "Transcribing…"
      : recording
        ? `Stop recording and type what was said (${SHORTCUT}). Esc cancels what has not been typed yet.`
        : hint();
    pill.hidden = phase === "idle";
    pill.classList.toggle("failed", phase === "failed");
    render(phase === "idle" ? nothing : view(), pill);
  }

  function setPhase(next) {
    const fresh = next !== phase;
    phase = next;
    paint();
    if (fresh && phase === "recording") level(0);
  }

  function record(from) {
    const mime = MIMES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(from, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    const parts = [];
    rec.ondataavailable = (e) => {
      if (e.data?.size) parts.push(e.data);
    };
    rec.start();
    return { rec, parts };
  }

  function onFrame(value, speaking, now) {
    level(value);
    if (!live()) return;
    if (speaking) {
      heardAt = now;
      segmentHeard = true;
    }
    if ((segmentHeard && now - heardAt > PAUSE_MS) || now - segmentAt > CHUNK_MS) cut(false);
    if (heardAt && now - heardAt > SILENCE_MS && mode() === "auto") {
      heardAt = 0;
      stop(true);
    }
  }

  async function start() {
    if (live() || starting || phase === "transcribing") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("The browser only allows the microphone on a secure page. Open Yardbell over https, or on the machine it runs on.");
      return;
    }
    starting = true;
    releasedEarly = false;
    try {
      stream = await openMic(toast);
    } catch (err) {
      toast(micProblem(err));
      return;
    } finally {
      starting = false;
    }
    queue = [];
    wrote = false;
    queued = false;
    meter = levelMeter(stream, onFrame);
    try {
      segment = record(stream);
      const first = segment;
      setTimeout(() => {
        if (segment === first && first.rec.state !== "recording") {
          segment = null;
          wav = wavCapture(stream, meter?.ctx);
        }
      }, 250);
    } catch {
      segment = null;
      wav = wavCapture(stream, meter?.ctx);
    }
    timer = setTimeout(() => {
      toast(`Recording stops after ${MAX_SECONDS / 60} minutes.`);
      stop(true);
    }, MAX_SECONDS * 1000);
    startedAt = performance.now();
    segmentAt = startedAt;
    heardAt = 0;
    segmentHeard = false;
    seconds = 0;
    ticker = setInterval(() => {
      const now = Math.floor((performance.now() - startedAt) / 1000);
      if (now === seconds) return;
      seconds = now;
      paint();
    }, 250);
    setPhase("recording");
    if (releasedEarly) stop(true);
  }

  // Closes the piece being recorded. A piece the meter heard no speech in is dropped rather than
  // sent to be guessed at, unless it is the whole recording: a quiet microphone can fool the meter.
  function cut(last, send = true) {
    const keep = send && (segmentHeard || !meter || (last && !queued));
    segmentHeard = false;
    segmentAt = performance.now();
    if (wav) {
      const blob = last ? wav.finish() : wav.cut();
      if (last) wav = null;
      if (keep && blob.size > 44) enqueue(blob);
      return;
    }
    const done = segment;
    if (!done) return;
    segment = null;
    if (!last) {
      try {
        segment = record(stream);
      } catch {
        wav = wavCapture(stream, meter?.ctx);
      }
    }
    closing++;
    done.rec.onstop = () => {
      closing--;
      if (last) for (const track of done.rec.stream.getTracks()) track.stop();
      const blob = new Blob(done.parts, { type: done.rec.mimeType || "audio/webm" });
      if (keep && blob.size) enqueue(blob);
      settle();
    };
    try {
      done.rec.stop();
    } catch {
      closing--;
      if (last) for (const track of done.rec.stream.getTracks()) track.stop();
    }
  }

  // Only a piece that really goes out counts: on a slow machine the Web Audio fallback can close
  // an empty first piece, and the last piece must still be sent then.
  function enqueue(blob) {
    queued = true;
    queue.push(blob);
    pump();
  }

  async function pump() {
    if (sending || !queue.length || phase === "failed") return;
    sending = true;
    aborter = new AbortController();
    const mine = aborter;
    try {
      const res = await fetch("/dispatch/transcribe", {
        method: "POST",
        headers: { "Content-Type": queue[0].type || "audio/webm" },
        body: queue[0],
        signal: mine.signal,
      });
      if (res.status === 401) { location.href = "/login"; return; }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
      if (mine !== aborter) return;
      queue.shift();
      if (out.text) {
        wrote = true;
        insert(out.text);
      }
    } catch (err) {
      if (mine !== aborter) return;
      if (err.name !== "AbortError") {
        toast(err.message);
        if (live()) finishRecording(true);
        setPhase("failed");
      }
    } finally {
      if (mine === aborter) {
        aborter = null;
        sending = false;
      }
    }
    pump();
    settle();
  }

  function settle() {
    if (live() || closing || sending || queue.length || phase === "idle" || phase === "failed") return;
    setPhase("idle");
    if (!wrote) toast("No words were heard. Try again a little closer to the microphone.");
  }

  function finishRecording(send) {
    clearInterval(ticker);
    ticker = 0;
    clearTimeout(timer);
    cut(true, send);
    meter?.stop();
    meter = null;
  }

  function stop(send) {
    if (!live()) return;
    finishRecording(send);
    if (send) {
      setPhase("transcribing");
      settle();
    } else {
      setPhase("idle");
    }
  }

  function cancel() {
    if (live()) finishRecording(false);
    queue = [];
    if (aborter) {
      const a = aborter;
      aborter = null;
      sending = false;
      a.abort();
    }
    setPhase("idle");
  }

  function discard() {
    queue = [];
    setPhase("idle");
  }

  function retry() {
    if (!queue.length) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    pump();
  }

  // Up from a press: a second tap always stops; Hold stops on any release, Auto only after a
  // hold, and Toggle never.
  function released(stopping, since) {
    const how = mode();
    if (starting && how !== "toggle" && (how === "hold" || Date.now() - since >= HOLD_MS)) {
      releasedEarly = true;
      return;
    }
    if (!live()) return;
    if (stopping || how === "hold" || (how === "auto" && Date.now() - since >= HOLD_MS)) stop(true);
  }

  pill.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    downAt = Date.now();
    if (live()) stopOnUp = true;
    else start();
  });
  const up = () => {
    released(stopOnUp, downAt);
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
  const shortcut = (e) => e.code === "Space" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (live() || phase !== "idle")) {
      e.preventDefault();
      cancel();
      return;
    }
    if (!shortcut(e) || button.hidden) return;
    e.preventDefault();
    if (e.repeat) return;
    keyAt = Date.now();
    keyStop = live();
    if (!keyStop) start();
  });
  document.addEventListener("keyup", (e) => {
    if (!keyAt || !["Space", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"].includes(e.code)) return;
    const since = keyAt;
    keyAt = 0;
    released(keyStop, since);
  });
  window.addEventListener("pagehide", () => {
    if (live()) cancel();
  });
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
