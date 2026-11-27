import { describe, expect, it } from 'vitest'
import type { ChangeStatus } from '../changes/api'
import { changeStatuses, dirStatus, fileHref, findLine, flattenTree, isMarkdown, parseLine, sizeWord, splitResult, type Listing } from './model'

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0 })
const file = (name: string) => ({ name, kind: 'file' as const, size: 1 })

const listings = new Map<string, Listing>([
  ['', { entries: [dir('.git'), dir('.github'), dir('src'), file('.env'), file('a.md')] }],
  ['src', { entries: [file('lib.rs'), dir('deep')] }]
])

describe('flattenTree', () => {
  it('hides .git always and dotfiles on request', () => {
    const rows = flattenTree(listings, new Set(), false, new Map())
    expect(rows.map((r) => r.key)).toEqual(['src', 'a.md'])
    const withDots = flattenTree(listings, new Set(), true, new Map())
    expect(withDots.map((r) => r.key)).toEqual(['.github', 'src', '.env', 'a.md'])
  })

  it('walks open folders, showing a loading row until the listing arrives', () => {
    const rows = flattenTree(listings, new Set(['src', 'src/deep']), false, new Map())
    expect(rows.map((r) => `${r.depth}:${r.key}`)).toEqual(['0:src', '1:src/lib.rs', '1:src/deep', '2:loading:src/deep', '0:a.md'])
  })

  it('shows an error row and a more row', () => {
    const broken = new Map<string, Listing>([['', { entries: [dir('x')], more: true }], ['x', { error: 'gone' }]])
    const rows = flattenTree(broken, new Set(['x']), true, new Map())
    expect(rows.map((r) => r.kind)).toEqual(['dir', 'error', 'more'])
  })

  it('colours files and the folders above a change', () => {
    const statuses = changeStatuses([{ path: 'src/lib.rs', status: 'modified' }, { path: 'a.md', status: 'untracked' }])
    const rows = flattenTree(listings, new Set(['src']), false, statuses)
    expect(rows.find((r) => r.key === 'src')).toMatchObject({ status: 'modified' })
    expect(rows.find((r) => r.key === 'src/lib.rs')).toMatchObject({ status: 'modified' })
    expect(rows.find((r) => r.key === 'a.md')).toMatchObject({ status: 'untracked' })
  })
})

describe('dirStatus', () => {
  it('shows a deleted file under a folder as modified', () => {
    const statuses = new Map<string, ChangeStatus>([['src/x.rs', 'deleted']])
    expect(dirStatus(statuses, 'src')).toBe('modified')
    expect(dirStatus(statuses, 'srcx')).toBeUndefined()
  })
})

describe('hrefs', () => {
  it('builds a file route with an optional line and search text', () => {
    expect(fileHref({ serverId: 's 1', machine: 'hp', root: '/a b', path: 'src/x.rs' })).toBe('/files/s%201/hp/file?root=%2Fa%20b&path=src%2Fx.rs')
    expect(fileHref({ serverId: 's', machine: 'hp', root: '/a', path: 'x', line: 12 })).toContain('&line=12')
    expect(fileHref({ serverId: 's', machine: 'hp', root: '/a', path: 'x', find: 'a&b' })).toContain('&find=a%26b')
    expect(fileHref({ serverId: 's', machine: 'hp', root: '/a', path: 'x', line: 0 })).not.toContain('line')
  })

  it('reads a line parameter', () => {
    expect(parseLine('12')).toBe(12)
    expect(parseLine('0')).toBeNull()
    expect(parseLine('x')).toBeNull()
    expect(parseLine(undefined)).toBeNull()
  })
})

describe('findLine', () => {
  it('finds the first line holding the text, ignoring case', () => {
    expect(findLine('a\nHello world\nhello', 'hello')).toBe(2)
    expect(findLine('hello', 'HELLO')).toBe(1)
    expect(findLine('a\nb', 'zzz')).toBeNull()
    expect(findLine('a', '  ')).toBeNull()
  })
})

describe('small helpers', () => {
  it('splits a result path', () => {
    expect(splitResult('src/a/b.rs')).toEqual({ name: 'b.rs', dir: 'src/a' })
    expect(splitResult('b.rs')).toEqual({ name: 'b.rs', dir: '' })
  })
  it('knows markdown', () => {
    expect(isMarkdown('docs/Guide.MD')).toBe(true)
    expect(isMarkdown('a.rs')).toBe(false)
  })
  it('words a size', () => {
    expect(sizeWord(512)).toBe('512 B')
    expect(sizeWord(1480)).toBe('1.4 KB')
    expect(sizeWord(640_000)).toBe('625 KB')
    expect(sizeWord(3_400_000)).toBe('3.2 MB')
  })
})
