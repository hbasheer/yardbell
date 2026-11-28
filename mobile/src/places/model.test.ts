import { describe, expect, it } from 'vitest'
import { filterGroups, pickerHref, placeGroups, placeHref } from './model'

const session = (over: Record<string, unknown>) => ({
  id: 's',
  machine: 'hp',
  agent: 'claude',
  folder: 'f',
  branch: 'main',
  activity: 'idle',
  attachable: true,
  tmux: 't',
  stale: false,
  ...over
})

const state = {
  folders: [
    { machine: 'hp', label: 'yardbell', path: '/home/d/yardbell', branch: 'main' },
    { machine: 'hp', label: 'orca-style-ui', path: '/home/d/yardbell-worktrees/orca-style-ui', branch: 'mobile-app', worktree: true },
    { machine: 'mac', label: 'other', path: '/Users/d/other', branch: 'main' }
  ],
  sessions: [
    session({ id: '1', path: '/home/d/yardbell-worktrees/orca-style-ui', branch: 'mobile-app' }),
    session({ id: '2', cwd: '/home/d/scratch', branch: '-' }),
    session({ id: '3', path: '/home/d/yardbell/', branch: 'main' }),
    session({ id: '4', path: '/home/d/gone', stale: true }),
    session({ id: '5', machine: 'mac', path: '/Users/d/other' }),
    session({ id: '6', path: 'relative/dir' })
  ]
} as never

describe('placeGroups', () => {
  const groups = placeGroups(state, 'hp')

  it('groups worktrees under their repo, repo first, and leaves out other machines, stale and relative places', () => {
    expect(groups.map((g) => [g.title, g.places.map((p) => p.path)])).toEqual([
      ['scratch', ['/home/d/scratch']],
      ['yardbell', ['/home/d/yardbell', '/home/d/yardbell-worktrees/orca-style-ui']]
    ])
  })

  it('merges a folder with the sessions in it and counts them', () => {
    const repo = groups[1].places
    expect(repo[0]).toMatchObject({ label: 'yardbell', branch: 'main', sessions: 1 })
    expect(repo[1]).toMatchObject({ label: 'orca-style-ui', branch: 'mobile-app', worktree: true, sessions: 1 })
  })

  it('names a session-only place by its folder and drops the placeholder branch', () => {
    expect(groups[0].places[0]).toMatchObject({ label: 'scratch', branch: null, sessions: 1 })
  })

  it('titles a group by its folder label, not a generic last segment', () => {
    const groups = placeGroups({ folders: [{ machine: 'hp', label: 'feedgest', path: '/p/feedgest/app', branch: 'main' }], sessions: [] } as never, 'hp')
    expect(groups.map((g) => g.title)).toEqual(['feedgest'])
  })

  it('is empty without state', () => {
    expect(placeGroups(undefined, 'hp')).toEqual([])
  })
})

describe('filterGroups', () => {
  it('matches path, label and branch and drops empty groups', () => {
    const groups = placeGroups(state, 'hp')
    expect(filterGroups(groups, 'mobile').map((g) => g.title)).toEqual(['yardbell'])
    expect(filterGroups(groups, 'mobile')[0].places).toHaveLength(1)
    expect(filterGroups(groups, 'nothing')).toEqual([])
    expect(filterGroups(groups, ' ')).toBe(groups)
  })
})

describe('hrefs', () => {
  it('encodes the server, machine and root', () => {
    expect(placeHref('changes', 'http://h:1', 'hp', '/a b')).toBe('/changes/http%3A%2F%2Fh%3A1/hp?root=%2Fa%20b')
    expect(pickerHref('changes', 'http://h:1', 'hp')).toBe('/places/http%3A%2F%2Fh%3A1/hp?then=changes')
    expect(placeHref('files', 's', 'hp', '/a')).toBe('/files/s/hp?root=%2Fa')
    expect(pickerHref('files', 's', 'hp')).toBe('/places/s/hp?then=files')
  })
})
