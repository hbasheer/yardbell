const { invoke } = window.__TAURI__.core;
const { emit, listen } = window.__TAURI__.event;
const bar = document.getElementById("tabs");
const cross = document.getElementById("cross").content;
const mac = /Mac/.test(navigator.platform);
const MIDDLE = 1;
const FIRST_RETRY_MS = 1000;
const LAST_RETRY_MS = 10000;

function call(command, label) {
  invoke(command, { label }).catch((error) => console.error(`${command} failed:`, error));
}

function tab(view) {
  const item = document.createElement("div");
  item.className = view.closable ? "tab session" : "tab pinned";
  item.classList.toggle("selected", view.selected);
  item.setAttribute("role", "presentation");
  item.dataset.label = view.label;

  const name = document.createElement("button");
  name.className = "name";
  name.type = "button";
  name.setAttribute("role", "tab");
  name.setAttribute("aria-selected", String(view.selected));
  name.textContent = view.title;
  name.title = view.title;
  name.addEventListener("click", () => call("select_tab", view.label));
  item.append(name);

  if (view.closable) {
    const button = document.createElement("button");
    button.className = "close";
    button.type = "button";
    button.setAttribute("aria-label", `Close ${view.title}`);
    button.append(cross.cloneNode(true));
    button.addEventListener("click", () => call("close_tab", view.label));
    item.append(button);
    item.addEventListener("auxclick", (e) => {
      if (e.button === MIDDLE) call("close_tab", view.label);
    });
  }
  return item;
}

let rendered = "";
let selectedLabel = "";

function render(views) {
  const json = JSON.stringify(views);
  if (json === rendered) return;
  rendered = json;
  selectedLabel = views.find((view) => view.selected)?.label ?? "";
  const focused = document.hasFocus() && bar.contains(document.activeElement) ? document.activeElement : null;
  const label = focused?.closest(".tab")?.dataset.label;
  const onClose = focused?.classList.contains("close");
  bar.replaceChildren(...views.map(tab));
  if (!focused) return;
  const held = [...bar.children].find((item) => item.dataset.label === label);
  const kept = onClose ? held?.querySelector(".close") : held?.querySelector(".name");
  (kept ?? bar.querySelector(".selected .name"))?.focus();
}

function tabKey(e) {
  if (e.altKey) return "";
  if (e.key === "Tab") return e.ctrlKey && !e.metaKey ? (e.shiftKey ? "tab-prev" : "tab-next") : "";
  const held = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return held && !e.shiftKey && /^[1-9]$/.test(e.key) ? `tab-${e.key}` : "";
}

function appKey(e) {
  if (e.altKey) return "";
  const held = mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && !e.metaKey;
  const key = held ? e.key.toLowerCase() : "";
  return key === "w" ? "close" : key === "q" ? "quit" : "";
}

document.addEventListener("keydown", (e) => {
  const tab = tabKey(e);
  const key = tab || appKey(e);
  if (!key) return;
  e.preventDefault();
  if (e.repeat && !tab) return;
  emit("shortcut", key).catch((error) => console.error("shortcut failed:", error));
});

bar.addEventListener("click", (e) => {
  if (e.target === bar && selectedLabel) call("select_tab", selectedLabel);
});

let listening = false;
let retry = FIRST_RETRY_MS;

async function init() {
  const errors = [];
  if (!listening) {
    try {
      await listen("tabs", (event) => render(event.payload));
      listening = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (!rendered) {
    try {
      const views = await invoke("tab_list");
      if (!rendered) render(views);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return;
  console.error(`Could not load the tabs, trying again in ${retry / 1000} s:`, ...errors);
  setTimeout(init, retry);
  retry = Math.min(retry * 2, LAST_RETRY_MS);
}

init();
