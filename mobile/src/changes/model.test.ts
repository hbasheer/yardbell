import { describe, expect, it } from 'vitest'
import type { Change } from './api'
import { commitInput, discardConfirm, primaryAction, splitChanges, statusLetter, uniquePaths } from './model'

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
