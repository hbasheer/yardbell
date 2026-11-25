import { Fragment, type ReactNode } from 'react'

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index))
    if (m[1] !== undefined)
      out.push(
        <code key={n++} className="rounded bg-muted px-1 font-mono text-[0.9em]">
          {m[1]}
        </code>
      )
    else if (m[2] !== undefined) out.push(<strong key={n++}>{inline(m[2])}</strong>)
    else
      out.push(
        <a key={n++} href={m[4]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {inline(m[3])}
        </a>
      )
    last = (m.index ?? 0) + m[0].length
  }
  out.push(text.slice(last))
  return out
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

// Dispatch's and agents' replies are Markdown; this covers what they write: paragraphs, headings,
// lists, tables and code blocks. It builds elements, never raw HTML.
export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (line.trim().startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++])
      i++
      out.push(
        <pre key={k++} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
          {code.join('\n')}
        </pre>
      )
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      out.push(
        <h4 key={k++} className="font-semibold">
          {inline(heading[2])}
        </h4>
      )
      i++
      continue
    }
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      out.push(
        <div key={k++} className="overflow-x-auto">
          <table className="text-xs [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, m) => (
                    <td key={m}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    const bullet = /^\s*[-*]\s+/
    const number = /^\s*\d+[.)]\s+/
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line)
      const marker = ordered ? number : bullet
      const items: string[] = []
      while (i < lines.length && lines[i].trim()) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ''))
        else if (items.length && /^\s+/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`
        else break
        i++
      }
      const list = items.map((it, j) => <li key={j}>{inline(it)}</li>)
      out.push(
        ordered ? (
          <ol key={k++} className="list-decimal pl-5">
            {list}
          </ol>
        ) : (
          <ul key={k++} className="list-disc pl-5">
            {list}
          </ul>
        )
      )
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|') &&
      !lines[i].trim().startsWith('```') &&
      !/^#{1,4}\s/.test(lines[i])
    ) {
      para.push(lines[i++].trim())
    }
    if (!para.length) {
      out.push(<p key={k++}>{inline(lines[i++])}</p>)
      continue
    }
    out.push(
      <p key={k++}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l)}
          </Fragment>
        ))}
      </p>
    )
  }
  return <div className={className ?? 'grid gap-2 text-[13px] leading-relaxed'}>{out}</div>
}
