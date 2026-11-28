import { describe, expect, it } from 'vitest'
import type { ReviewEvent } from '../types'
import { changeLetter, changeTotals, changeWord, diffNote, placeLink, placeOf, safePath, scanFileCount, shotsOf, standingLines, standingOf } from './model'

const review = (extra: Partial<ReviewEvent> = {}): ReviewEvent => ({
  role: 'review',
  machine: 'hp',
  name: 'yardbell-2',
  of: { path: '/home/dev/Projects/yardbell', pin: { head: 'a1b2c3d4e5f6', changes: '' } },
  ...extra
})

describe('placeOf', () => {
  it('reads a path with a line, a range, or none', () => {
    expect(placeOf('src/a.rs:88')).toEqual({ path: 'src/a.rs', line: 88 })
    expect(placeOf('src/a.rs:88-92')).toEqual({ path: 'src/a.rs', line: 88 })
    expect(placeOf('./src/a.rs')).toEqual({ path: 'src/a.rs', line: null })
    expect(placeOf('config/app.yml:4:2')).toEqual({ path: 'config/app.yml', line: 4 })
  })
})

describe('safePath', () => {
  it('refuses absolute and parent paths', () => {
    expect(safePath('src/a.rs')).toBe(true)
    expect(safePath('/etc/passwd')).toBe(false)
    expect(safePath('../x')).toBe(false)
    expect(safePath('a//b')).toBe(false)
  })
})

describe('placeLink', () => {
  it('links to the file route with the line and the review folder as root', () => {
    const link = placeLink(review(), 's1', { severity: 'high', place: 'src/a.rs:88', text: 'x' })
    expect(link).toContain('/files/s1/hp/file?')
    expect(link).toContain('line=88')
    expect(link).toContain(encodeURIComponent('/home/dev/Projects/yardbell'))
    expect(link).toContain('path=src%2Fa.rs')
  })
  it('gives nothing for unsafe places, no place or no folder', () => {
    expect(placeLink(review(), 's1', { severity: 'low', place: '../etc/passwd:1', text: 'x' })).toBeNull()
    expect(placeLink(review(), 's1', { severity: 'low', text: 'x' })).toBeNull()
    expect(placeLink(review({ of: {} }), 's1', { severity: 'low', place: 'a.rs:1', text: 'x' })).toBeNull()
  })
})

describe('scanFileCount', () => {
  it('counts each safe file once', () => {
    expect(scanFileCount([{ severity: 'low', place: 'a.rs:1', text: '' }, { severity: 'low', place: 'a.rs:9', text: '' }, { severity: 'low', place: '/x', text: '' }, { severity: 'low', text: '' }])).toBe(1)
  })
})

describe('changes words', () => {
  it('names status and totals', () => {
    expect(changeWord({ status: 'M', untracked: false })).toBe('Modified')
    expect(changeWord({ status: 'A', untracked: true })).toBe('New, not committed')
    expect(changeLetter({ status: 'A', untracked: true })).toBe('?')
    expect(changeTotals([{ path: 'a', status: 'M', added: 3, removed: 1, binary: false, untracked: false }, { path: 'b', status: 'M', added: null, removed: null, binary: true, untracked: false }])).toEqual({ files: 2, added: 3, removed: 1 })
  })
  it('words the base note like the web', () => {
    expect(diffNote({ base: 'main', merge_base: 'abcdef123', head: 'ffff' })).toBe('Against main from abcdef1, with changes not yet committed. Read from the folder as it is now.')
    expect(diffNote({ base: 'main', merge_base: 'x', head: 'x' })).toContain('No commits beyond main')
    expect(diffNote({ base: '', merge_base: 'x', head: 'y' })).toContain('no base branch')
  })
})

describe('standingLines', () => {
  it('has nothing without a pin', () => {
    expect(standingLines(review({ of: {} }), null)).toEqual([])
  })
  it('words each standing', () => {
    expect(standingLines(review(), null)).toEqual([{ text: 'Read a1b2c3d.', warn: false }])
    expect(standingLines(review(), { standing: 'same' })[0].text).toBe('Read a1b2c3d. Nothing has changed since.')
    const moved = standingLines(review(), { standing: 'moved', head: '9999999aaaa' })[0]
    expect(moved.warn).toBe(true)
    expect(moved.text).toContain('it is now at 9999999')
    expect(standingLines(review(), { standing: 'uncommitted' })[0].warn).toBe(true)
    expect(standingLines(review(), { failed: 'timed out' })[0].text).toContain('could not check the branch now: timed out')
  })
  it('mentions uncommitted changes, a change during the review and a pull request at another commit', () => {
    const e = review({ of: { pin: { head: 'a1b2c3d4', changes: 'x' }, pull: { number: 4, head: 'ffffffff' } }, read_changed: 'moved' })
    const lines = standingLines(e, { standing: 'same' })
    expect(lines[0].text).toContain('with uncommitted changes')
    expect(lines[0].text).toContain('moved while this review ran')
    expect(lines[1].text).toBe('#4 was at fffffff, a different commit, so this is not a review of exactly what is pushed.')
  })
  it('says why the pin could not be read', () => {
    expect(standingLines(review({ of: { pin: { error: 'not a git folder' } } }), null)[0].text).toContain('not a git folder')
  })
})

describe('standingOf and shotsOf', () => {
  it('maps the reply', () => {
    expect(standingOf(undefined)).toBeNull()
    expect(standingOf({ standing: 'moved', now: { head: 'abc' } })).toEqual({ standing: 'moved', head: 'abc', error: undefined })
    expect(standingOf(undefined, 'down')).toEqual({ failed: 'down' })
  })
  it('splits kept and lost shots by finding', () => {
    const e = review({ evidence: [{ finding: 0, name: 'a', file: 'a.png' }, { finding: 0, name: 'b', error: 'not a PNG image' }, { finding: 1, name: 'c', file: 'c.png' }] })
    expect(shotsOf(e, 0).kept.map((s) => s.name)).toEqual(['a'])
    expect(shotsOf(e, 0).lost.map((s) => s.name)).toEqual(['b'])
    expect(shotsOf(e, 2)).toEqual({ kept: [], lost: [] })
  })
})
