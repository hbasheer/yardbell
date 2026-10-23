const { invoke } = window.__TAURI__.core;
const scanner = window.__TAURI__.barcodeScanner;
const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function sentence(text) {
  const s = String(text || "Something went wrong");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function working(text) {
  $("busy").textContent = text || "";
  $("busy").hidden = !text;
  document.querySelectorAll("button").forEach((b) => { b.disabled = Boolean(text); });
}

function fail(err) {
  working("");
  $("err").textContent = sentence(err);
}

async function go(command, args, label) {
  $("err").textContent = "";
  working(label);
  try {
    location.href = await invoke(command, args);
  } catch (err) {
    fail(err);
    render();
  }
}

async function render() {
  const list = await invoke("servers").catch(() => []);
  $("saved").hidden = !list.length;
  $("servers").innerHTML = list.map((s) => `<li>
    <button class="open" type="button" data-open="${esc(s.server)}">
      <span class="addr">${esc(s.server.replace(/^https?:\/\//, ""))}</span>
      <span class="note${s.signed_in ? "" : " out"}">${s.signed_in ? "Tap to open" : "Signed out. Scan a new pairing code"}</span>
    </button>
    <button class="forget" type="button" data-forget="${esc(s.server)}" aria-label="Forget ${esc(s.server)}">×</button>
  </li>`).join("");
}

$("servers").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) { go("open", { server: open.dataset.open }, "Opening…"); return; }
  const forget = e.target.closest("[data-forget]");
  if (forget) {
    await invoke("forget", { server: forget.dataset.forget }).catch(fail);
    render();
  }
});

$("scan").addEventListener("click", async () => {
  $("err").textContent = "";
  if (!scanner) { fail("scanning needs the Android app"); return; }
  try {
    let allowed = await scanner.checkPermissions();
    if (allowed !== "granted") allowed = await scanner.requestPermissions();
    if (allowed !== "granted") { fail("allow camera access to scan the code, or enter the address and passcode instead"); return; }
    const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] });
    go("pair", { link: result.content }, "Pairing…");
  } catch (err) {
    if (!/cancel/i.test(String(err))) fail(err);
  }
});

$("show-manual").addEventListener("click", () => {
  $("manual").hidden = false;
  $("show-manual").hidden = true;
  $("manual").elements.server.focus();
});

$("manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  go("connect", { server: f.elements.server.value, passcode: f.elements.passcode.value }, "Signing in…");
});

render();
