import { html } from "/vendor/lit-html/lit-html.js";

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(html`<code>${m[1]}</code>`);
    else if (m[2] !== undefined) out.push(html`<strong>${inline(m[2])}</strong>`);
    else out.push(html`<a href=${m[4]} target="_blank" rel="noopener">${inline(m[3])}</a>`);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// Dispatch's and agents' replies are Markdown; this covers what they write: paragraphs, headings,
// lists, tables and code blocks.
export function markdown(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(html`<pre class="md-code">${code.join("\n")}</pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(html`<h4 class="md-h">${inline(heading[2])}</h4>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(html`<div class="md-table"><table><thead><tr>${head.map((c) => html`<th>${inline(c)}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${inline(c)}</td>`)}</tr>`)}</tbody></table></div>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const number = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line);
      const marker = ordered ? number : bullet;
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ""));
        else if (items.length && /^\s+/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      const list = items.map((it) => html`<li>${inline(it)}</li>`);
      out.push(ordered ? html`<ol class="md-list">${list}</ol>` : html`<ul class="md-list">${list}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) && !lines[i].trim().startsWith("|") && !lines[i].trim().startsWith("```") && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    if (!para.length) { out.push(html`<p>${inline(lines[i++])}</p>`); continue; }
    out.push(html`<p>${para.map((l, n) => (n ? [html`<br>`, inline(l)] : inline(l)))}</p>`);
  }
  return out;
}
