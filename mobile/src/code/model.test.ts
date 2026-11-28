import { describe, expect, it } from 'vitest'
import type { DiffLine } from '../changes/api'
import {
  buildRows,
  clampLine,
  clip,
  diffGutter,
  layoutOf,
  MAX_CHARS,
  hasChanges,
  moreLabel,
  parseHunk,
  splitLines,
  FOLD_HEIGHT,
  LINE_HEIGHT
} from './model'

const hunk = (t: string): DiffLine => ({ k: 'hunk', o: null, n: null, t })
const ctx = (o: number, n: number, t = 'x'): DiffLine => ({ k: 'ctx', o, n, t })
const add = (n: number, t = 'x'): DiffLine => ({ k: 'add', o: null, n, t })
const del = (o: number, t = 'x'): DiffLine => ({ k: 'del', o, n: null, t })

describe('parseHunk', () => {
  it('reads both ranges and the section', () => {
    expect(parseHunk('@@ -10,7 +10,8 @@ export function run() {')).toEqual({
      oldStart: 10,
      oldCount: 7,
      newStart: 10,
      newCount: 8,
      section: 'export function run() {'
    })
  })

  it('takes a missing count as one line', () => {
    expect(parseHunk('@@ -3 +4 @@')).toMatchObject({ oldCount: 1, newCount: 1, section: '' })
  })

  it('returns null for text that is not a hunk header', () => {
    expect(parseHunk('not a hunk')).toBeNull()
  })
})

describe('buildRows', () => {
  it('keeps line numbers on both sides and drops a hunk that starts at line 1', () => {
    const rows = buildRows([hunk('@@ -1,3 +1,4 @@'), ctx(1, 1, 'one'), del(2, 'two'), add(2, 'TWO'), ctx(3, 3, 'three'), add(4, 'four')])
    expect(rows.map((r) => (r.kind === 'line' ? [r.k, r.o, r.n] : ['fold']))).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['ctx', 3, 3],
      ['add', null, 4]
    ])
  })

  it('folds the lines before the first hunk and between hunks', () => {
    const rows = buildRows([
      hunk('@@ -10,2 +10,2 @@ fn a'),
      ctx(10, 10),
      ctx(11, 11),
      hunk('@@ -31,1 +31,1 @@'),
      ctx(31, 31)
    ])
    const folds = rows.flatMap((r) => (r.kind === 'fold' ? [r.text] : []))
    expect(folds).toEqual(['9 unchanged lines  fn a', '19 unchanged lines'])
  })

  it('counts a single hidden line in the singular', () => {
    const rows = buildRows([hunk('@@ -2,1 +2,1 @@'), ctx(2, 2)])
    expect(rows[0]).toMatchObject({ kind: 'fold', text: '1 unchanged line' })
  })

  it('does not fold a hunk that follows the last line directly', () => {
    const rows = buildRows([hunk('@@ -1,1 +1,1 @@'), ctx(1, 1), hunk('@@ -2,1 +2,1 @@'), ctx(2, 2)])
    expect(rows.every((r) => r.kind === 'line')).toBe(true)
  })

  it('handles a new file whose hunk starts at line zero', () => {
    const rows = buildRows([hunk('@@ -0,0 +1,2 @@'), add(1), add(2)])
    expect(rows).toHaveLength(2)
  })

  it('continues across pages without a header', () => {
    const rows = buildRows([ctx(5, 5), ctx(6, 6), add(7)])
    expect(rows.map((r) => r.kind)).toEqual(['line', 'line', 'line'])
  })

  it('keeps a no newline marker as a meta row without numbers', () => {
    const rows = buildRows([hunk('@@ -1,1 +1,1 @@'), del(1, 'a'), { k: 'meta', o: null, n: null, t: '\\ No newline at end of file' }, add(1, 'b')])
    expect(rows[1]).toEqual({ kind: 'meta', key: 2, text: '\\ No newline at end of file' })
  })

  it('shows a header it cannot read as a fold row', () => {
    expect(buildRows([hunk('odd')])[0]).toEqual({ kind: 'fold', key: 0, text: 'odd' })
  })
})

describe('hasChanges', () => {
  it('ignores hunk and meta lines', () => {
    expect(hasChanges([hunk('@@ -1 +1 @@'), { k: 'meta', o: null, n: null, t: '\\ No newline at end of file' }])).toBe(false)
    expect(hasChanges([add(1)])).toBe(true)
  })
})

describe('layoutOf and gutter', () => {
  it('gives fold rows their own height and prefix offsets', () => {
    const rows = buildRows([hunk('@@ -5,1 +5,1 @@'), ctx(5, 5), add(6)])
    const layout = layoutOf(rows)
    expect(layout.heights).toEqual([FOLD_HEIGHT, LINE_HEIGHT, LINE_HEIGHT])
    expect(layout.offsets).toEqual([0, FOLD_HEIGHT, FOLD_HEIGHT + LINE_HEIGHT])
    expect(layout.total).toBe(FOLD_HEIGHT + 2 * LINE_HEIGHT)
  })

  it('widens a number column for four digit line numbers', () => {
    const narrow = diffGutter(buildRows([ctx(9, 9)]))
    const wide = diffGutter(buildRows([ctx(4999, 5000)]))
    expect(wide.old).toBeGreaterThan(narrow.old)
    expect(wide.total).toBe(wide.old + wide.new + wide.sign)
  })

  it('gives the old side no width when no line has an old number', () => {
    const added: DiffLine[] = [{ k: 'add', o: null, n: 1, t: 'a' }, { k: 'add', o: null, n: 2, t: 'b' }]
    const gutter = diffGutter(buildRows(added))
    expect(gutter.old).toBe(0)
    expect(gutter.new).toBeGreaterThan(0)
    expect(gutter.total).toBe(gutter.new + gutter.sign)
  })
})

describe('paging', () => {
  it('says how many lines are left', () => {
    expect(moreLabel(5000, 12000)).toBe('Show 7,000 more')
  })

  it('has no label on the last page', () => {
    expect(moreLabel(400, 400)).toBeNull()
    expect(moreLabel(0, 0)).toBeNull()
  })
})

describe('text helpers', () => {
  it('splits on any line ending and ignores one trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
    expect(splitLines('\n')).toEqual([''])
    expect(splitLines('')).toEqual([])
  })

  it('expands tabs and clips very long lines', () => {
    expect(clip('\tx')).toBe('    x')
    const long = clip('a'.repeat(MAX_CHARS + 50))
    expect(long).toHaveLength(MAX_CHARS + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  it('keeps a line to jump to inside the file', () => {
    expect(clampLine(1200, 30000)).toBe(1200)
    expect(clampLine(99, 10)).toBe(10)
    expect(clampLine(0, 10)).toBe(1)
    expect(clampLine(3, 0)).toBeNull()
  })
})
