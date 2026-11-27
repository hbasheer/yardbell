import type { DiffLine } from '../changes/api'

export const LINE_HEIGHT = 20
export const FOLD_HEIGHT = 32
export const CHAR_WIDTH = 7.2
export const MAX_CHARS = 1000
const SIGN_WIDTH = 16
const NUMBER_PAD = 18

export type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; section: string }

export type DiffRow =
  | { kind: 'fold'; key: number; text: string }
  | { kind: 'meta'; key: number; text: string }
  | { kind: 'line'; key: number; k: 'ctx' | 'add' | 'del'; o: number | null; n: number | null; t: string }

export type Layout = { heights: number[]; offsets: number[]; total: number }

export function parseHunk(text: string): Hunk | null {
  const found = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(text)
  if (!found) return null
  return {
    oldStart: Number(found[1]),
    oldCount: found[2] === undefined ? 1 : Number(found[2]),
    newStart: Number(found[3]),
    newCount: found[4] === undefined ? 1 : Number(found[4]),
    section: found[5]
  }
}

export function expandTabs(text: string): string {
  return text.includes('\t') ? text.replace(/\t/g, '    ') : text
}

export function clip(text: string): string {
  const flat = expandTabs(text)
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS)}…` : flat
}

export function hiddenWord(count: number): string {
  return count === 1 ? '1 unchanged line' : `${count.toLocaleString('en-US')} unchanged lines`
}

export function buildRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  let shownOld = 0
  lines.forEach((line, at) => {
    if (line.k === 'meta') {
      rows.push({ kind: 'meta', key: at, text: line.t })
      return
    }
    if (line.k !== 'hunk') {
      rows.push({ kind: 'line', key: at, k: line.k, o: line.o, n: line.n, t: line.t })
      if (line.o !== null) shownOld = line.o
      return
    }
    const hunk = parseHunk(line.t)
    if (!hunk) {
      rows.push({ kind: 'fold', key: at, text: line.t })
      return
    }
    const first = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart
    const hidden = Math.max(0, first - shownOld - 1)
    if (hidden > 0 || hunk.section) {
      const parts = [hidden > 0 ? hiddenWord(hidden) : '', hunk.section].filter(Boolean)
      rows.push({ kind: 'fold', key: at, text: parts.join('  ') })
    }
    shownOld = Math.max(shownOld, first - 1)
  })
  return rows
}

export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((line) => line.k !== 'hunk' && line.k !== 'meta')
}

export function layoutOf(rows: DiffRow[]): Layout {
  const heights: number[] = []
  const offsets: number[] = []
  let total = 0
  for (const row of rows) {
    const height = row.kind === 'fold' ? FOLD_HEIGHT : LINE_HEIGHT
    offsets.push(total)
    heights.push(height)
    total += height
  }
  return { heights, offsets, total }
}

export function digitsOf(value: number): number {
  return Math.max(2, String(Math.max(0, Math.floor(value))).length)
}

export function numberWidth(digits: number): number {
  return digits * CHAR_WIDTH + NUMBER_PAD
}

export type DiffGutter = { old: number; new: number; sign: number; total: number }

export function diffGutter(rows: DiffRow[]): DiffGutter {
  let highestOld = 0
  let highestNew = 0
  for (const row of rows) {
    if (row.kind !== 'line') continue
    if (row.o !== null && row.o > highestOld) highestOld = row.o
    if (row.n !== null && row.n > highestNew) highestNew = row.n
  }
  const old = numberWidth(digitsOf(highestOld))
  const added = numberWidth(digitsOf(highestNew))
  return { old, new: added, sign: SIGN_WIDTH, total: old + added + SIGN_WIDTH }
}

export function codeWidth(texts: Iterable<string>): number {
  let longest = 0
  for (const text of texts) {
    const length = Math.min(MAX_CHARS + 1, expandTabs(text).length)
    if (length > longest) longest = length
  }
  return Math.ceil(longest * CHAR_WIDTH) + NUMBER_PAD
}

export function diffContentWidth(rows: DiffRow[], gutter: DiffGutter, viewport: number): number {
  const texts = rows.flatMap((row) => (row.kind === 'line' ? [row.t] : []))
  return Math.max(viewport, gutter.total + codeWidth(texts))
}

export function remaining(next: number, total: number): number {
  return Math.max(0, total - next)
}

export function moreLabel(next: number, total: number): string | null {
  const left = remaining(next, total)
  if (left === 0) return null
  return `Show ${left.toLocaleString('en-US')} more`
}

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function lineCountWord(count: number): string {
  return count === 1 ? '1 line' : `${count.toLocaleString('en-US')} lines`
}

export function clampLine(line: number, count: number): number | null {
  if (count === 0 || !Number.isFinite(line)) return null
  return Math.min(count, Math.max(1, Math.floor(line)))
}

export function textGutter(count: number): number {
  return numberWidth(digitsOf(count))
}
