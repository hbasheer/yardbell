import { describe, expect, it } from 'vitest'
import type { Change } from './api'
import {
  absolutePath,
  appendPage,
  statsWord,
  commitAllConfirm,
  diffHref,
  rootName,
  commitInput,
  committedNotice,
  discardConfirm,
  fileKey,
  filterChanges,
  neighbour,
  ordered,
  primaryAction,
  splitChanges,
  splitPath,
  statusLetter,
  uniquePaths
} from './model'

const file = (path: string, over: Partial<Change> = {}): Change => ({
  path,
  status: 'modified',
  staged: false,
  binary: false,
  ...over
})

describe('statusLetter', () => {
  it('gives the web letters', () => {
    expect(['modified', 'added', 'deleted', 'renamed', 'untracked'].map((s) => statusLetter(s as Change['status']))).toEqual([
      'M',
      'A',
      'D',
      'R',
      'U'
    ])
  })
})

describe('splitChanges', () => {
  it('puts a file staged and changed again in both sections', () => {
    const files = [file('a', { staged: true }), file('a'), file('b')]
    const { staged, unstaged } = splitChanges(files)
    expect(staged.map((f) => f.path)).toEqual(['a'])
    expect(unstaged.map((f) => f.path)).toEqual(['a', 'b'])
    expect(uniquePaths(files)).toEqual(['a', 'b'])
  })
})

describe('commitInput', () => {
  it('commits what is staged', () => {
    expect(commitInput({ files: [file('a', { staged: true }), file('b')], truncated: false })).toEqual({ staged: true })
  })

  it('commits every listed path when nothing is staged', () => {
    expect(commitInput({ files: [file('a'), file('a', { staged: false }), file('b')], truncated: false })).toEqual({
      paths: ['a', 'b']
    })
  })

  it('sends neither when the list was cut, so the server commits everything', () => {
    expect(commitInput({ files: [file('a')], truncated: true })).toEqual({})
  })
})

describe('primaryAction', () => {
  it('commits when dirty, naming whether it is everything', () => {
    expect(primaryAction({ files: [file('a')] })).toEqual({ kind: 'commit', label: 'Commit All' })
    expect(primaryAction({ files: [file('a', { staged: true })], behind: 3 })).toEqual({ kind: 'commit', label: 'Commit' })
  })

  it('pulls, then pushes, then fetches when clean', () => {
    expect(primaryAction({ files: [], behind: 2, ahead: 1 })).toEqual({ kind: 'pull', label: 'Pull 2' })
    expect(primaryAction({ files: [], ahead: 4 })).toEqual({ kind: 'push', label: 'Push 4' })
    expect(primaryAction({ files: [], ahead: 0, behind: null })).toEqual({ kind: 'fetch', label: 'Fetch' })
  })
})

describe('discardConfirm', () => {
  it('names one file by its last segment', () => {
    expect(discardConfirm([file('src/a.ts')])).toEqual({
      title: 'Discard changes in a.ts?',
      body: 'The files go back to their last committed state. This cannot be undone.',
      confirm: 'Discard'
    })
  })

  it('counts distinct paths and says untracked files are deleted', () => {
    const out = discardConfirm([file('a'), file('b', { status: 'untracked' }), file('b')])
    expect(out.title).toBe('Discard changes in 2 files?')
    expect(out.body).toBe('Untracked files are deleted. This cannot be undone.')
    expect(out.confirm).toBe('Discard')
  })

  it('says Delete only when every file is untracked', () => {
    expect(discardConfirm([file('a', { status: 'untracked' })]).confirm).toBe('Delete')
  })
})

describe('commitAllConfirm', () => {
  it('says in words that every change goes in, with the count', () => {
    const c = commitAllConfirm({ files: [file('a'), file('a', { staged: false }), file('b', { status: 'untracked' })], truncated: false })
    expect(c.title).toBe('Commit all changes?')
    expect(c.body).toBe('Nothing is staged, so every change will be committed: 2 files, new and deleted files included.')
  })

  it('says it for one file and for a truncated list', () => {
    expect(commitAllConfirm({ files: [file('a')], truncated: false }).body).toContain('1 file,')
    expect(commitAllConfirm({ files: [file('a')], truncated: true }).body).toContain('Every change in the working tree will be committed')
  })
})

describe('splitPath and filterChanges', () => {
  it('splits name and folder', () => {
    expect(splitPath('src/web/a.rs')).toEqual({ name: 'a.rs', dir: 'src/web' })
    expect(splitPath('a.rs')).toEqual({ name: 'a.rs', dir: '' })
  })

  it('filters by substring, ignoring case, and keeps all for an empty filter', () => {
    const files = [file('src/Web.rs'), file('docs/a.md')]
    expect(filterChanges(files, 'web').map((f) => f.path)).toEqual(['src/Web.rs'])
    expect(filterChanges(files, '  ')).toBe(files)
  })
})

describe('stepping between files', () => {
  const files = ordered([file('a'), file('b', { staged: true }), file('a', { staged: true })])

  it('lists staged first and keeps the staged and unstaged copy of a path apart', () => {
    expect(files.map(fileKey)).toEqual(['staged:b', 'staged:a', 'changes:a'])
  })

  it('finds the next and previous file, and stops at the ends', () => {
    expect(neighbour(files, { path: 'b', staged: true }, 1)?.path).toBe('a')
    expect(neighbour(files, { path: 'a', staged: false }, -1)?.staged).toBe(true)
    expect(neighbour(files, { path: 'b', staged: true }, -1)).toBeNull()
    expect(neighbour(files, { path: 'a', staged: false }, 1)).toBeNull()
    expect(neighbour(files, { path: 'gone', staged: false }, 1)).toBeNull()
  })
})

describe('committedNotice', () => {
  it('keeps the push error whole after a commit', () => {
    expect(committedNotice('abc1234', null)).toBe('Committed abc1234')
    expect(committedNotice('abc1234', 'git said: no\nline two')).toBe('Committed abc1234, then the push failed.\ngit said: no\nline two')
  })
})

describe('routes and paths', () => {
  it('builds the diff href with the staged side', () => {
    expect(diffHref('http://h:1', 'hp', '/r x', { path: 'a b/c.rs', staged: true })).toBe(
      '/changes/http%3A%2F%2Fh%3A1/hp/diff?root=%2Fr%20x&path=a%20b%2Fc.rs&staged=1'
    )
    expect(diffHref('s', 'hp', '/r', { path: 'a', staged: false })).toContain('staged=0')
  })

  it('joins the root and path and names the folder', () => {
    expect(absolutePath('/home/d/yb/', 'src/a.rs')).toBe('/home/d/yb/src/a.rs')
    expect(rootName('/home/d/yb/')).toBe('yb')
  })
})

describe('appendPage', () => {
  const line = (t: string) => ({ k: 'add' as const, o: null, n: 1, t })

  it('starts from the first page and appends the page that follows', () => {
    const first = appendPage(null, { lines: [line('a'), line('b')], from: 0, next: 2, total: 3 })
    expect(first).toEqual({ lines: [line('a'), line('b')], next: 2, total: 3 })
    const both = appendPage(first, { lines: [line('c')], from: 2, next: 3, total: 3 })
    expect(both.lines.map((l) => l.t)).toEqual(['a', 'b', 'c'])
    expect(both.next).toBe(3)
  })

  it('ignores a page that arrives twice or out of order', () => {
    const first = { lines: [line('a'), line('b')], next: 2, total: 5 }
    expect(appendPage(first, { lines: [line('x')], from: 1, next: 2, total: 5 })).toBe(first)
    expect(appendPage(first, { lines: [line('x')], from: 4, next: 5, total: 5 })).toBe(first)
  })

  it('replaces everything when the first page is asked for again', () => {
    expect(appendPage({ lines: [line('old')], next: 1, total: 9 }, { lines: [line('new')], from: 0, next: 1, total: 2 }).lines[0].t).toBe('new')
  })
})

describe('statsWord', () => {
  it('words the counts', () => {
    expect(statsWord(file('a', { added: 4, removed: 1 }))).toBe('+4 -1')
    expect(statsWord(file('a', { added: 4, removed: 0 }))).toBe('+4')
    expect(statsWord(file('a', { binary: true }))).toBe('binary')
    expect(statsWord(file('a'))).toBe('')
  })
})
