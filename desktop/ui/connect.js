const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const LAST_SERVER = "yardbell.server";

function sentence(text) {
  const s = String(text || "Something went wrong");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function remembered() {
  try { return localStorage.getItem(LAST_SERVER) || ""; } catch { return ""; }
}

function remember(server) {
  try { localStorage.setItem(LAST_SERVER, server); } catch {}
}

function focusFirstEmpty() {
  ($("server").value ? $("passcode") : $("server")).focus();
}

async function init() {
  $("server").value = remembered();
  focusFirstEmpty();
  const [server, message] = await Promise.all([
    invoke("connect_server").catch(() => null),
    invoke("connect_message").catch(() => null),
  ]);
  if (server) {
    $("server").value = server;
    focusFirstEmpty();
  }
  if (message) {
    $("info").textContent = message;
    $("info").hidden = false;
  }
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const server = $("server").value.trim();
  const passcode = $("passcode").value;
  const button = $("submit");
  $("err").textContent = "";
  if (!passcode) {
    $("err").textContent = "Enter the passcode";
    $("passcode").focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Connecting…";
  remember(server);
  try {
    await invoke("connect", { server, passcode });
  } catch (err) {
    $("err").textContent = sentence(err);
    $("passcode").select();
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
});

const LEDES = {
  missing: "Yardbell runs inside this app and watches this machine's agent sessions. Choose a passcode for signing in from other devices. Add more machines later from Add machine.",
  no_passcode: "Yardbell is set up on this machine but has no passcode yet. Choose one for signing in from other devices.",
  ready: "Yardbell is already set up on this machine. Enter its passcode to start it here and sign in.",
};
let localState = null;

async function showLocal() {
  $("form").hidden = true;
  $("local-form").hidden = false;
  $("local-err").textContent = "";
  localState = await invoke("local_server_status").catch((err) => ({ state: "broken", error: String(err) }));
  const broken = localState.state === "broken";
  $("local-lede").textContent = broken
    ? "The Yardbell config on this machine can't be read. Fix it, or connect to another server."
    : LEDES[localState.state];
  $("local-err").textContent = broken ? sentence(localState.error) : "";
  $("local-repeat-label").hidden = localState.state === "ready";
  $("local-submit").disabled = broken;
  $("local-passcode").focus();
}

$("to-local").addEventListener("click", showLocal);
$("to-connect").addEventListener("click", () => {
  $("local-form").hidden = true;
  $("form").hidden = false;
  focusFirstEmpty();
});

$("local-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const passcode = $("local-passcode").value;
  const button = $("local-submit");
  $("local-err").textContent = "";
  const creating = localState?.state !== "ready";
  if (creating && passcode.length < 6) {
    $("local-err").textContent = "Use at least 6 characters";
    $("local-passcode").focus();
    return;
  }
  if (creating && passcode !== $("local-repeat").value) {
    $("local-err").textContent = "The two passcodes don't match";
    $("local-repeat").select();
    return;
  }
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await invoke("set_up_local_server", { passcode });
  } catch (err) {
    localState = await invoke("local_server_status").catch(() => localState);
    $("local-repeat-label").hidden = localState?.state === "ready";
    if (localState?.state === "ready") $("local-lede").textContent = LEDES.ready;
    $("local-err").textContent = sentence(err);
    $("local-passcode").select();
  } finally {
    button.disabled = false;
    button.textContent = "Start and sign in";
  }
});

init();
