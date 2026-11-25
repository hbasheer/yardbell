// Adapted from Orca's Monaco setup (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
(function () {
  const BASE = "/vendor/monaco-0.55.1";
  const mounted = new Set();
  let loading = null;

  function load() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${BASE}/vs/loader.js`;
      s.onload = () => {
        window.require.config({ paths: { vs: `${BASE}/vs` } });
        window.require(["vs/editor/editor.main"], () => {
          defineThemes(window.monaco);
          watchTheme(window.monaco);
          resolve(window.monaco);
        }, (err) => reject(new Error(`The editor could not load: ${err?.message || err}`)));
      };
      s.onerror = () => reject(new Error("The editor could not load."));
      document.head.append(s);
    });
    loading.catch(() => { loading = null; });
    return loading;
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Workspace panes follow the terminal's own light or dark choice, not the page theme.
  function isDark() {
    return document.documentElement.dataset.term !== "light";
  }

  // Monaco wants #rrggbb; the tokens can be any CSS colour, so let the browser resolve them.
  function hex(css, fallback) {
    const probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = fallback;
    probe.fillStyle = css || fallback;
    const v = probe.fillStyle;
    if (v.startsWith("#")) return v;
    const m = v.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return fallback;
    const byte = (n) => Math.round(Number(n)).toString(16).padStart(2, "0");
    return `#${byte(m[1])}${byte(m[2])}${byte(m[3])}${m[4] === undefined ? "" : byte(Number(m[4]) * 255)}`;
  }

  function defineThemes(monaco) {
    const dark = isDark();
    const surface = hex(token("--term-bg"), dark ? "#2a2c33" : "#ffffff");
    const colors = {
      "editor.background": surface,
      "editorGutter.background": surface,
      "editor.foreground": hex(token("--term-ink"), dark ? "#f2f2f2" : "#1f2328"),
      "editor.lineHighlightBackground": dark ? "#ffffff0a" : "#0000000a",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": hex(token("--term-select"), dark ? "#5a7898" : "#bfdbfe"),
      "editorLineNumber.foreground": hex(token("--term-muted"), dark ? "#8e939c" : "#5f6670"),
      "editorLineNumber.activeForeground": hex(token("--term-ink"), dark ? "#f2f2f2" : "#1f2328"),
      "editorWidget.background": hex(token("--term-raise"), surface),
      "editorWidget.border": hex(token("--term-edge"), dark ? "#42454e" : "#d0d4d9"),
      "focusBorder": "#00000000",
      "scrollbarSlider.background": dark ? "#ffffff1a" : "#0000001a",
      "scrollbarSlider.hoverBackground": dark ? "#ffffff2e" : "#0000002e",
    };
    monaco.editor.defineTheme("yardbell", { base: dark ? "vs-dark" : "vs", inherit: true, rules: [], colors });
    monaco.editor.setTheme("yardbell");
  }

  function watchTheme(monaco) {
    const again = () => defineThemes(monaco);
    new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ["data-term", "data-theme"] });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", again);
  }

  function language(monaco, path) {
    const name = String(path).split("/").pop().toLowerCase();
    const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
    for (const l of monaco.languages.getLanguages()) {
      if (l.filenames?.some((f) => f.toLowerCase() === name)) return l.id;
    }
    for (const l of monaco.languages.getLanguages()) {
      if (ext && l.extensions?.includes(ext)) return l.id;
    }
    return "plaintext";
  }

  function options(extra) {
    return {
      automaticLayout: true,
      fontFamily: token("--mono") || "ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 20,
      lineNumbers: "on",
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "off",
      padding: { top: 6 },
      tabSize: 2,
      fixedOverflowWidgets: true,
      ...extra,
    };
  }

  // Panes are dropped from the page without telling anyone, so editors whose node is gone are
  // disposed whenever another one mounts.
  function sweep() {
    for (const m of mounted) {
      if (m.node.isConnected) continue;
      m.dispose();
      mounted.delete(m);
    }
  }

  async function code(node, { path, text, readOnly = true, onChange, onSave }) {
    const monaco = await load();
    sweep();
    const model = monaco.editor.createModel(text, language(monaco, path));
    const editor = monaco.editor.create(node, options({ model, readOnly, domReadOnly: readOnly }));
    if (onSave) editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave(editor.getValue()));
    if (onChange) model.onDidChangeContent(() => onChange(model.getAlternativeVersionId()));
    const m = {
      node,
      editor,
      model,
      monaco,
      clean: model.getAlternativeVersionId(),
      dirty() { return model.getAlternativeVersionId() !== m.clean; },
      markClean() { m.clean = model.getAlternativeVersionId(); },
      dispose() { editor.dispose(); model.dispose(); },
    };
    mounted.add(m);
    return m;
  }

  async function diff(node, { path, before, after, inline = true }) {
    const monaco = await load();
    sweep();
    const lang = language(monaco, path);
    const original = monaco.editor.createModel(before, lang);
    const modified = monaco.editor.createModel(after, lang);
    const editor = monaco.editor.createDiffEditor(node, options({
      readOnly: true,
      domReadOnly: true,
      renderSideBySide: !inline,
      useInlineViewWhenSpaceIsLimited: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
    }));
    editor.setModel({ original, modified });
    const m = {
      node,
      editor,
      monaco,
      dirty: () => false,
      dispose() { editor.dispose(); original.dispose(); modified.dispose(); },
    };
    mounted.add(m);
    return m;
  }

  function anyDirty() {
    sweep();
    return [...mounted].some((m) => m.dirty());
  }

  window.addEventListener("beforeunload", (e) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  window.YardbellEditor = { load, code, diff, anyDirty };
})();
