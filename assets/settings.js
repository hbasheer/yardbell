const $ = (id) => document.getElementById(id);
const Nav = window.YardbellNav;
let data = null;

const LABELS = { nordvpn: "NordVPN Meshnet", tailscale: "Tailscale", headscale: "Headscale", netbird: "NetBird", zerotier: "ZeroTier", none: "None" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function toast(message, kind = "error") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("logged out"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

function saved(text, restart = false) {
  $("undo-bar").hidden = false;
  $("undo-title").textContent = "Saved.";
  $("undo-text").textContent = text;
  $("undo-btn").hidden = false;
  $("restart-btn").hidden = !restart || !data?.service_installed;
}

function providerOptions(selected, withDefault) {
  const opts = withDefault ? [`<option value=""${selected ? "" : " selected"}>Same as Yardbell</option>`] : [];
  for (const [v, l] of Object.entries(LABELS)) opts.push(`<option value="${v}"${selected === v ? " selected" : ""}>${l}</option>`);
  return opts.join("");
}

function machineForm(m) {
  const prefixes = [1, 2, 3, 4, 5, 6].map((p) => `<option${m.port_prefix === p ? " selected" : ""}>${p}</option>`).join("");
  return `<form class="panel machine-form" id="machine-${esc(m.name)}" data-name="${esc(m.name)}">
    <div class="machine-form-head">
      <strong>${esc(m.name)}</strong>${m.local ? `<span class="note">this machine</span>` : ""}
      <span class="spacer"></span>
      ${m.local ? "" : `<button class="btn quiet danger" type="button" data-remove="${esc(m.name)}">Remove</button>`}
    </div>
    <div class="grid3">
      <label>SSH host <input type="text" name="ssh" value="${esc(m.ssh || "")}" placeholder="${esc(m.name)}" autocapitalize="off" ${m.local ? "disabled" : ""}></label>
      <label>Mesh address <input type="text" name="mesh_ip" value="${esc(m.mesh_ip || "")}" placeholder="100.x.x.x" autocapitalize="off"></label>
      <label>Port prefix ${m.local ? `<input type="text" value="host ports" disabled>` : `<select name="port_prefix">${prefixes}</select>`}</label>
      <label class="span2">Project folder <input type="text" name="root" value="${esc(m.root)}" autocapitalize="off" required></label>
      <label>VPN <select name="mesh">${providerOptions(m.mesh || "", true)}</select></label>
    </div>
    <div class="form-foot">
      <p class="help">${m.local ? "Yardbell runs here. Its mesh address is where your phone reaches Yardbell." : `Ports open on the host as ${m.port_prefix || "?"}xxxx.`}</p>
      <button class="btn" type="submit">Save ${esc(m.name)}</button>
    </div>
  </form>`;
}

function clock(stamp) {
  return new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderPhone(p) {
  $("phone-intro").hidden = p.on;
  $("phone-on").hidden = !p.on;
  $("phone-turn-off").hidden = !p.on;
  if (!p.on) {
    testResult("");
    return;
  }
  const host = p.server.split("/")[2];
  $("phone-subscribe").href = `ntfy://${host}/${p.topic}?display=Yardbell${p.server.startsWith("http://") ? "&secure=false" : ""}`;
  $("phone-topic").textContent = p.topic;
  $("phone-server").textContent = p.server;
  $("phone-server-line").hidden = p.server.replace(/\/+$/, "") === "https://ntfy.sh";
  const f = $("phone-form");
  for (const name of ["agent_waiting", "session_ended", "machines", "memory"]) f.elements[name].checked = p[name];
  f.elements.wait_minutes.value = p.wait_minutes;
  f.elements.server.value = p.server;
  f.elements.token.value = "";
  f.elements.token.placeholder = p.token_set ? "Saved" : "";
  f.elements.clear_token.checked = false;
  $("phone-clear-token").hidden = !p.token_set;
  renderPhoneStatus(p);
}

function renderPhoneStatus(p) {
  const failed = Boolean(p.last_error_at) && (!p.last_sent || Date.parse(p.last_error_at) > Date.parse(p.last_sent));
  const status = $("phone-status");
  status.textContent = failed
    ? `Last attempt failed at ${clock(p.last_error_at)}: ${p.last_error}`
    : p.last_sent ? `Last sent at ${clock(p.last_sent)}` : "Nothing sent yet.";
  status.classList.toggle("bad", failed);
}

function testResult(text, state) {
  const el = $("phone-test-result");
  el.textContent = text;
  el.classList.toggle("ok", state === "ok");
  el.classList.toggle("bad", state === "bad");
}

function phoneBusy(busy) {
  $("phone").querySelectorAll("button").forEach((b) => { b.disabled = busy; });
}

function copyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  // select() alone selects nothing on iOS.
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
  return ok;
}

async function load() {
  data = await api("GET", "/api/settings");
  $("provider").value = data.mesh;
  $("mesh-current").textContent = `currently ${LABELS[data.mesh] || data.mesh}`;
  $("machine-forms").innerHTML = data.machines.map(machineForm).join("");
  renderPhone(data.phone);
  if (!data.can_undo) $("undo-btn").hidden = true;
}

$("preview-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const res = await api("POST", "/api/settings/mesh/preview", { provider: $("provider").value });
    const found = res.proposals.filter((p) => p.new_ip).length;
    $("mapping-note").textContent = res.message
      ? `${res.message} Type the new addresses below.`
      : `${res.label} lists ${res.peers.length} peers. Matched ${found} of ${res.proposals.length} machines by name. Check each address; leave a field empty to keep it unchanged.`;
    $("mapping-rows").innerHTML = res.proposals.map((p) => `<tr>
      <td class="map-machine">${esc(p.machine)}</td>
      <td><span class="num">${esc(p.old_ip || "none")}</span></td>
      <td><input type="text" class="addr" data-machine="${esc(p.machine)}" value="${esc(p.new_ip || "")}" placeholder="100.x.x.x" autocapitalize="off">
        ${p.peer ? `<span class="help">matched ${esc(p.peer)}</span>` : ""}</td>
    </tr>`).join("");
    $("mapping").hidden = false;
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$("apply-btn").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  const provider = $("provider").value;
  const addresses = {};
  document.querySelectorAll(".addr").forEach((i) => { if (i.value.trim()) addresses[i.dataset.machine] = i.value.trim(); });
  const count = Object.keys(addresses).length;
  if (!(await Nav.confirm(`Switch Yardbell to ${LABELS[provider]}?`, `This updates ${count} ${count === 1 ? "address" : "addresses"}.`, { confirm: "Switch VPN" }))) return;
  b.disabled = true;
  try {
    const res = await api("POST", "/api/settings/mesh/apply", { provider, addresses });
    const ssh = res.ssh_updated.length ? ` Updated ~/.ssh/config for ${res.ssh_updated.join(", ")}.` : "";
    const restart = res.restart_needed
      ? data.service_installed ? " Restart Yardbell so your phone can reach it at the new address." : " Stop Yardbell and run yardbell serve again so your phone can reach it at the new address."
      : "";
    saved(`Yardbell now uses ${LABELS[provider]}.${ssh}${restart}`, res.restart_needed);
    $("mapping").hidden = true;
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$("machine-forms").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const v = (n) => f.elements[n]?.value?.trim() ?? "";
  const body = {
    ssh: v("ssh") || null,
    mesh_ip: v("mesh_ip") || null,
    port_prefix: f.elements.port_prefix ? Number(v("port_prefix")) : null,
    root: v("root"),
    mesh: v("mesh") || null,
  };
  try {
    await api("POST", `/api/settings/machines/${encodeURIComponent(f.dataset.name)}`, body);
    saved(`${f.dataset.name} updated.`);
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$("machine-forms").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  const name = b.dataset.remove;
  if (!(await Nav.confirm(`Remove ${name} from Yardbell?`, "Its tunnels close. ~/.ssh/config is not changed.", { confirm: "Remove", danger: true }))) return;
  try {
    const res = await api("POST", `/machines/${encodeURIComponent(name)}/remove`);
    if (res.ok === false) throw new Error(res.message);
    toast(res.message, "ok");
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$("phone-setup").addEventListener("click", async () => {
  phoneBusy(true);
  try {
    await api("POST", "/api/settings/phone/setup", {});
    saved("Phone notifications are on.");
    await load();
    $("phone-subscribe").focus();
  } catch (err) {
    toast(err.message);
  } finally {
    phoneBusy(false);
  }
});

$("phone-copy").addEventListener("click", () => {
  if (copyText($("phone-topic").textContent)) toast("Topic copied", "ok");
  else toast("Couldn't copy. Select the topic and copy it.");
});

$("phone-test").addEventListener("click", async () => {
  testResult("Sending…");
  phoneBusy(true);
  try {
    await api("POST", "/api/settings/phone/test", {});
    testResult("Sent", "ok");
  } catch (err) {
    testResult(err.message, "bad");
  } finally {
    await api("GET", "/api/settings")
      .then((fresh) => renderPhoneStatus(fresh.phone))
      .catch((err) => toast(err.message));
    phoneBusy(false);
  }
});

$("phone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    server: f.elements.server.value.trim(),
    wait_minutes: Number(f.elements.wait_minutes.value.trim()),
    agent_waiting: f.elements.agent_waiting.checked,
    session_ended: f.elements.session_ended.checked,
    machines: f.elements.machines.checked,
    memory: f.elements.memory.checked,
  };
  const token = f.elements.token.value.trim();
  if (token) body.token = token;
  if (f.elements.clear_token.checked) body.clear_token = true;
  phoneBusy(true);
  try {
    await api("POST", "/api/settings/phone", body);
    saved("Phone notifications updated.");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    phoneBusy(false);
  }
});

$("phone-turn-off").addEventListener("click", async () => {
  if (!(await Nav.confirm("Turn off phone notifications?", "Your phone stops getting notifications. Setting up again makes a new topic.", { confirm: "Turn off", danger: true }))) return;
  phoneBusy(true);
  try {
    await api("POST", "/api/settings/phone/off", {});
    saved("Phone notifications are off.");
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    phoneBusy(false);
  }
  if (!$("phone-intro").hidden) $("phone-setup").focus();
});

$("pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.elements.new.value !== f.elements.repeat.value) { toast("The two new passcodes do not match"); return; }
  try {
    await api("POST", "/api/settings/passcode", { current: f.elements.current.value, new: f.elements.new.value });
    f.reset();
    toast("Passcode changed", "ok");
  } catch (err) {
    toast(err.message);
  }
});

$("logout-all").addEventListener("click", async () => {
  if (!(await Nav.confirm("Sign out every other phone and browser?", "They need the passcode to log in again.", { confirm: "Log out everywhere", danger: true }))) return;
  try {
    await api("POST", "/api/settings/logout-all", {});
    toast("Every other device is signed out", "ok");
  } catch (err) {
    toast(err.message);
  }
});

$("undo-btn").addEventListener("click", async () => {
  try {
    await api("POST", "/api/settings/undo", {});
    $("undo-title").textContent = "Undone.";
    $("undo-text").textContent = "The previous settings are back.";
    $("undo-btn").hidden = true;
    $("restart-btn").hidden = true;
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$("restart-btn").addEventListener("click", async () => {
  try {
    const res = await api("POST", "/api/settings/restart", {});
    toast(res.message, "ok");
    setTimeout(() => location.reload(), 4000);
  } catch (err) {
    toast(err.message);
  }
});

load()
  .then(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  })
  .catch((err) => toast(err.message));
