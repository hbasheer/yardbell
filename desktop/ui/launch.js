const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const RETRY_EVERY = 5000;
const GIVE_UP_AFTER = 20000;

let server = "";
let timer = 0;
let watchdog = 0;

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
  watch();
}

function watch() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => unreachable(`It didn't answer in ${GIVE_UP_AFTER / 1000} s.`), GIVE_UP_AFTER);
}

function unreachable(why) {
  clearTimeout(watchdog);
  if ($("unreachable").hidden) {
    $("problem").textContent = server ? `Can't reach ${host(server)}` : "Can't reach the server";
    $("hint").textContent = why || "Check that Yardbell is running there and your VPN is on.";
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
  else watch();
  invoke("retry_connect");
}

$("retry").addEventListener("click", () => retry(true));

async function changeServer(button) {
  clearTimeout(timer);
  clearTimeout(watchdog);
  button.disabled = true;
  try {
    await invoke("change_server");
  } catch (err) {
    unreachable();
    $("err").textContent = sentence(err);
    $("err").hidden = false;
    button.disabled = false;
  }
}

$("change").addEventListener("click", () => changeServer($("change")));
$("other").addEventListener("click", () => changeServer($("other")));

addEventListener("pagehide", () => {
  clearTimeout(timer);
  clearTimeout(watchdog);
});

async function init() {
  await listen("connecting", (event) => {
    server = event.payload;
    if ($("unreachable").hidden) connecting();
  });
  await listen("unreachable", (event) => {
    server = event.payload;
    unreachable();
  });
  watch();
  invoke("retry_connect");
}

init();
