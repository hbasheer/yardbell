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

init();
