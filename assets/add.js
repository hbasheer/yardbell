const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
const form = $("form");
const CHECK = '<svg class="icon" viewBox="0 0 16 16" aria-label="done"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
const CROSS = '<svg class="icon" viewBox="0 0 16 16" aria-label="failed"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"/></svg>';
const SPIN = '<svg class="icon" viewBox="0 0 16 16" aria-label="working"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/></svg>';

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("logged out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !("ok" in data)) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function values() {
  return Object.fromEntries(new FormData(form).entries());
}

function line(label) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="mark wait">${SPIN}</span><div><span class="step-label">${esc(label)}</span> <span class="step-msg"></span><div class="step-extra"></div></div>`;
  $("checklist").appendChild(li);
  return {
    set(ok, message) {
      const mark = li.querySelector(".mark");
      mark.className = `mark ${ok ? "ok" : "bad"}`;
      mark.innerHTML = ok ? CHECK : CROSS;
      li.querySelector(".step-msg").textContent = message || "";
    },
    extra(html) {
      li.querySelector(".step-extra").innerHTML = html;
      return li.querySelector(".step-extra");
    },
  };
}

function waitClick(el, selector) {
  return new Promise((resolve) => el.querySelector(selector).addEventListener("click", (e) => { e.preventDefault(); resolve(); }, { once: true }));
}

async function step(name, label) {
  const row = line(label);
  const result = await call("POST", `/onboarding/${name}`, values());
  row.set(result.ok, result.message);
  return { result, row };
}

async function keyAuth() {
  for (;;) {
    const { result, row } = await step("key_auth", "SSH key login");
    if (result.ok) return true;
    if (!result.data?.terminal_url) return false;
    const extra = row.extra(`<p>Open the terminal and follow it. When it says done, come back and press Check again.</p>
      <div class="row-actions"><a class="btn" href="${esc(result.data.terminal_url)}" target="_blank" rel="noopener">Open terminal</a>
      <button class="btn primary" type="button" data-retry>Check again</button></div>`);
    await waitClick(extra, "[data-retry]");
    extra.innerHTML = "";
  }
}

async function run() {
  $("checklist").innerHTML = "";
  if (!(await step("reachable", "Reachable on the mesh")).result.ok) return;
  if (!(await keyAuth())) return;
  const preview = await step("ssh_config_preview", "SSH config entry");
  if (!preview.result.ok) return;
  if (!preview.result.data.reuse) {
    const extra = preview.row.extra(`<pre>${esc(preview.result.data.block)}</pre><button class="btn primary" type="button" data-write>Add this to ~/.ssh/config</button>`);
    await waitClick(extra, "[data-write]");
    extra.querySelector("[data-write]").remove();
    if (!(await step("write_ssh_config", "Write SSH config")).result.ok) return;
  }
  const detect = await step("detect", "Check the machine");
  if (!detect.result.ok) return;
  const d = detect.result.data;
  if (d.root && !form.root.value) form.root.value = d.root;
  const tips = (d.missing || []).map((m) => `<li><code>${esc(m.tool)}</code> missing: <code>${esc(m.hint)}</code></li>`).join("");
  const saveBox = detect.row.extra(`${tips ? `<ul>${tips}</ul>` : ""}<p>Check the project folder above, then save.</p><button class="btn primary" type="button" data-save>Save machine</button>`);
  await waitClick(saveBox, "[data-save]");
  saveBox.querySelector("[data-save]").remove();
  const saved = await step("save", "Save to Yardbell");
  if (saved.result.ok) {
    saved.row.extra(`<a class="btn" href="/">Back to the dashboard</a>`);
    loadMachines();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  form.querySelector("button[type=submit]").disabled = true;
  run().catch((err) => toast(err.message)).finally(() => (form.querySelector("button[type=submit]").disabled = false));
});

async function loadPeers() {
  try {
    const step = await call("GET", "/onboarding/peers");
    if (!step.ok) { $("peers").innerHTML = `<p class="empty">${esc(step.message)}</p>`; return; }
    const mobile = (p) => ["android", "ios"].includes(String(p.os).toLowerCase());
    const phones = step.data.peers.filter(mobile).length;
    const peers = step.data.peers.filter((p) => !mobile(p)).sort((a, b) => Number(b.online) - Number(a.online));
    const note = phones ? `<p class="help peers-note">${phones} ${phones === 1 ? "phone or tablet" : "phones and tablets"} hidden. They can open Yardbell in a browser but cannot run sessions.</p>` : "";
    if (!peers.length) { $("peers").innerHTML = `<p class="empty">Every computer on the mesh is already in Yardbell. Enter an IP or hostname below to add another.</p>${note}`; return; }
    $("peers").innerHTML = note + peers.map((p, i) => `<button class="peer" type="button" aria-pressed="false" data-i="${i}">
      <span class="peer-name"><span class="dot ${p.online ? "ok" : ""}"></span>${esc(p.nickname || p.hostname)}</span>
      <span class="peer-meta">${esc(p.ip)} · ${esc(p.os)}${p.online ? "" : " · offline"}</span></button>`).join("");
    $("peers").addEventListener("click", (e) => {
      const b = e.target.closest(".peer");
      if (!b) return;
      document.querySelectorAll(".peer").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      const p = peers[b.dataset.i];
      form.ip.value = p.ip;
      if (!form.name.value) form.name.value = p.suggested_name;
      form.user.focus();
    });
  } catch (err) {
    $("peers").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

async function loadMachines() {
  const state = await call("GET", "/state");
  $("known").innerHTML = state.machines.map((m) => `<li class="row">
    <div class="row-main"><div class="row-title"><span class="dot ${m.up ? "ok" : "bad"}"></span><span class="folder">${esc(m.name)}</span>
    <span class="note">${m.local ? "this machine" : esc(m.up ? "connected" : m.reason || "not reachable")}</span></div></div>
    <div class="row-actions">${m.local ? "" : `<button class="btn ghost danger" type="button" data-remove="${esc(m.name)}">Remove</button>`}</div></li>`).join("");
}

$("known").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  const name = b.dataset.remove;
  if (!(await Nav.confirm(`Remove ${name} from Yardbell?`, "Its tunnels close. ~/.ssh/config is not changed.", { confirm: "Remove", danger: true }))) return;
  try {
    const res = await call("POST", `/machines/${encodeURIComponent(name)}/remove`);
    toast(res.message);
    loadMachines();
  } catch (err) {
    toast(err.message);
  }
});

loadPeers();
loadMachines();
