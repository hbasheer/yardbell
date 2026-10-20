const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const RETRY_EVERY = 5000;

let server = "";
let timer = 0;

function host(address) {
  try { return new URL(address).host; } catch { return address; }
}

function sentence(text) {
  const s = String(text || "Something went wrong");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function connecting() {
  $("status").textContent = server ? `Connecting to ${host(server)}…` : "Connecting…";
  $("unreachable").hidden = true;
  $("connecting").hidden = false;
}

function unreachable() {
  if ($("unreachable").hidden) {
    $("problem").textContent = `Can't reach ${host(server)}`;
    $("err").hidden = true;
    $("connecting").hidden = true;
    $("unreachable").hidden = false;
    $("retry").focus();
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => retry(false), RETRY_EVERY);
}

function retry(showConnecting) {
  clearTimeout(timer);
  if (showConnecting) connecting();
  invoke("retry_connect");
}

$("retry").addEventListener("click", () => retry(true));

$("change").addEventListener("click", async () => {
  clearTimeout(timer);
  $("change").disabled = true;
  try {
    await invoke("change_server");
  } catch (err) {
    $("err").textContent = sentence(err);
    $("err").hidden = false;
    $("change").disabled = false;
    schedule();
  }
});

addEventListener("pagehide", () => clearTimeout(timer));

async function init() {
  await listen("connecting", (event) => {
    server = event.payload;
    if ($("unreachable").hidden) connecting();
  });
  await listen("unreachable", (event) => {
    server = event.payload;
    unreachable();
  });
  invoke("retry_connect");
}

init();
