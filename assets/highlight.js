(() => {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  const words = (list) => new Set(list.split(" "));
  const C_LIKE = "break case catch class const continue default delete do else enum export extends finally for function if implements import in instanceof interface let new of package private protected public return static super switch this throw try typeof var void while with yield async await from as";
  const LANGS = {
    js: { words: words(`${C_LIKE} true false null undefined NaN`), line: "//", block: ["/*", "*/"], strings: "'\"`" },
    ts: { words: words(`${C_LIKE} type keyof readonly declare namespace abstract true false null undefined any string number boolean never unknown`), line: "//", block: ["/*", "*/"], strings: "'\"`" },
    rust: { words: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err"), line: "//", block: ["/*", "*/"], strings: "\"" },
    go: { words: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil"), line: "//", block: ["/*", "*/"], strings: "\"`'" },
    py: { words: words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self"), line: "#", strings: "'\"" },
    rb: { words: words("alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_reader attr_accessor private"), line: "#", strings: "'\"" },
    sh: { words: words("if then else elif fi for while until do done case esac in function return local export set unset echo exit true false"), line: "#", strings: "'\"" },
    css: { words: words("important"), block: ["/*", "*/"], strings: "'\"" },
    c: { words: words("auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr class public private protected namespace using template typename virtual include define"), line: "//", block: ["/*", "*/"], strings: "'\"" },
    java: { words: words(`${C_LIKE} boolean byte char double float int long short final native synchronized transient volatile abstract throws true false null fun val when object data`), line: "//", block: ["/*", "*/"], strings: "'\"" },
    yaml: { words: words("true false null yes no on off"), line: "#", strings: "'\"" },
    toml: { words: words("true false"), line: "#", strings: "'\"" },
    json: { words: words("true false null"), strings: "\"" },
    sql: { words: words("select from where insert into values update set delete create table index alter drop join left right inner outer on group by order having limit and or not null as distinct primary key references"), line: "--", block: ["/*", "*/"], strings: "'\"", fold: true },
    md: { md: true },
    html: { markup: true },
  };
  const EXT = {
    js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", vue: "html", svelte: "html",
    rs: "rust", go: "go", py: "py", rb: "rb", rake: "rb", gemspec: "rb", erb: "html",
    sh: "sh", bash: "sh", zsh: "sh", fish: "sh", env: "sh",
    css: "css", scss: "css", less: "css", c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", m: "c", swift: "java",
    java: "java", kt: "java", kts: "java", scala: "java", cs: "java", php: "js", dart: "java",
    yml: "yaml", yaml: "yaml", toml: "toml", json: "json", jsonl: "json", lock: "toml",
    sql: "sql", md: "md", markdown: "md", html: "html", htm: "html", xml: "html", svg: "html",
  };
  const NAMES = { Dockerfile: "sh", Makefile: "sh", Gemfile: "rb", Rakefile: "rb", Procfile: "sh", ".bashrc": "sh", ".zshrc": "sh", ".gitignore": "sh" };

  function langOf(path) {
    const name = String(path).split("/").pop();
    if (NAMES[name]) return NAMES[name];
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    return EXT[ext] || (name.startsWith(".env") ? "sh" : "");
  }

  const span = (cls, text) => `<span class="hl-${cls}">${esc(text)}</span>`;

  // A small scanner per line that carries an open block comment or string over to the next line.
  function code(lines, lang) {
    let open = null;
    return lines.map((line) => {
      let out = "";
      let i = 0;
      const n = line.length;
      if (open) {
        const end = line.indexOf(open.end);
        if (end < 0) return span(open.cls, line);
        out += span(open.cls, line.slice(0, end + open.end.length));
        i = end + open.end.length;
        open = null;
      }
      while (i < n) {
        const rest = line.slice(i);
        if (lang.line && rest.startsWith(lang.line) && !(lang.line === "#" && /[\w$]/.test(line[i - 1] || ""))) {
          out += span("comment", rest);
          break;
        }
        if (lang.block && rest.startsWith(lang.block[0])) {
          const end = line.indexOf(lang.block[1], i + lang.block[0].length);
          if (end < 0) {
            out += span("comment", rest);
            open = { end: lang.block[1], cls: "comment" };
            break;
          }
          out += span("comment", line.slice(i, end + lang.block[1].length));
          i = end + lang.block[1].length;
          continue;
        }
        const ch = line[i];
        if (lang.strings?.includes(ch)) {
          let j = i + 1;
          while (j < n && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
          if (j >= n && ch === "`") {
            out += span("string", rest);
            open = { end: "`", cls: "string" };
            break;
          }
          out += span("string", line.slice(i, j + 1));
          i = j + 1;
          continue;
        }
        const num = /^(0x[\da-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(rest);
        if (num && !/[\w$]/.test(line[i - 1] || "")) {
          out += span("number", num[0]);
          i += num[0].length;
          continue;
        }
        const word = /^[A-Za-z_$][\w$?!]*/.exec(rest);
        if (word) {
          const w = word[0];
          const key = lang.fold ? w.toLowerCase() : w;
          if (lang.words.has(key)) out += span("keyword", w);
          else if (line[i + w.length] === "(") out += span("fn", w);
          else if (/^[A-Z][a-z0-9]/.test(w)) out += span("type", w);
          else out += esc(w);
          i += w.length;
          continue;
        }
        out += esc(ch);
        i += 1;
      }
      return out;
    });
  }

  function markup(lines) {
    let comment = false;
    return lines.map((line) => {
      if (comment) {
        const end = line.indexOf("-->");
        if (end < 0) return span("comment", line);
        comment = false;
        return span("comment", line.slice(0, end + 3)) + markup([line.slice(end + 3)])[0];
      }
      let out = "";
      let last = 0;
      const re = /<!--|<\/?[A-Za-z][\w:-]*|"[^"]*"|'[^']*'|\/?>/g;
      let m;
      let inTag = false;
      while ((m = re.exec(line))) {
        out += inTag ? esc(line.slice(last, m.index)).replace(/([\w:-]+)(?==)/g, '<span class="hl-attr">$1</span>') : esc(line.slice(last, m.index));
        const t = m[0];
        if (t === "<!--") {
          const end = line.indexOf("-->", m.index);
          if (end < 0) {
            out += span("comment", line.slice(m.index));
            comment = true;
            return out;
          }
          out += span("comment", line.slice(m.index, end + 3));
          re.lastIndex = end + 3;
        } else if (t[0] === "<") {
          out += span("keyword", t);
          inTag = true;
        } else if (t.endsWith(">")) {
          out += span("keyword", t);
          inTag = false;
        } else {
          out += inTag ? span("string", t) : esc(t);
        }
        last = re.lastIndex;
      }
      return out + esc(line.slice(last));
    });
  }

  function markdown(lines) {
    let fence = false;
    return lines.map((line) => {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        return span("comment", line);
      }
      if (fence) return span("string", line);
      if (/^#{1,6}\s/.test(line)) return span("keyword", line);
      return esc(line).replace(/`[^`]+`/g, (c) => `<span class="hl-string">${c}</span>`)
        .replace(/(\*\*[^*]+\*\*)/g, '<span class="hl-type">$1</span>');
    });
  }

  function highlight(text, path) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const name = langOf(path);
    const lang = LANGS[name];
    if (!lang || text.length > 400000) return { lang: name, lines: lines.map(esc) };
    if (lang.markup) return { lang: name, lines: markup(lines) };
    if (lang.md) return { lang: name, lines: markdown(lines) };
    return { lang: name, lines: code(lines, lang) };
  }

  window.YardbellHighlight = { highlight, langOf };
})();
