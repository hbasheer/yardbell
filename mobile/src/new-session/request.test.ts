import { describe, expect, it } from 'vitest'
import type { ServerSession } from '../state/views'
import {
  buildNewSessionBody,
  folderLabel,
  isValidBranchName,
  joinPath,
  parentPath,
  projectFolders,
  startBlocker
} from './request'

const base = { machine: 'hp', path: '/home/dev/Projects/yardbell', agent: 'claude' }

describe('buildNewSessionBody', () => {
  it('stays on the current branch with no branch fields', () => {
    expect(buildNewSessionBody({ ...base, branch: { kind: 'stay' } })).toEqual({
      machine: 'hp',
      path: '/home/dev/Projects/yardbell',
      agent: 'claude',
      resume: false,
      wait: false
    })
  })

  it('picks an existing branch', () => {
    const body = buildNewSessionBody({ ...base, branch: { kind: 'existing', name: 'feature/x' } })
    expect(body.branch).toBe('feature/x')
    expect(body.new_branch).toBeUndefined()
    expect(body.base).toBeUndefined()
  })

  it('makes a new branch from a base', () => {
    const body = buildNewSessionBody({ ...base, branch: { kind: 'new', name: 'fix-it', base: 'main' } })
    expect(body).toMatchObject({ branch: 'fix-it', new_branch: true, base: 'main', resume: false })
  })

  it('uses the folder from a preset as the path', () => {
    const body = buildNewSessionBody({ ...base, path: '/srv/app', branch: { kind: 'stay' } })
    expect(body.path).toBe('/srv/app')
  })
})

describe('startBlocker', () => {
  it('asks for what is missing, in order', () => {
    expect(startBlocker({})).toBe('Pick a machine')
    expect(startBlocker({ machine: 'hp' })).toBe('Pick a folder')
    expect(startBlocker({ machine: 'hp', path: '/a' })).toBe('Pick an agent')
  })

  it('checks a new branch', () => {
    const choice = { ...base, branch: { kind: 'new' as const, name: '', base: 'main' } }
    expect(startBlocker(choice)).toBe('Name the new branch')
    expect(startBlocker({ ...choice, branch: { kind: 'new', name: 'a..b', base: 'main' } })).toMatch(/Branch names/)
    expect(startBlocker({ ...choice, branch: { kind: 'new', name: 'ok', base: '' } })).toBe('Pick a base branch')
    expect(startBlocker({ ...choice, branch: { kind: 'new', name: 'ok', base: 'main' } })).toBeNull()
  })

  it('lets a complete choice start', () => {
    expect(startBlocker({ ...base, branch: { kind: 'stay' } })).toBeNull()
  })
})

describe('paths', () => {
  it('validates branch names', () => {
    expect(isValidBranchName('feature/x_1.2')).toBe(true)
    expect(isValidBranchName('-bad')).toBe(false)
    expect(isValidBranchName('a b')).toBe(false)
  })

  it('labels, joins and climbs', () => {
    expect(folderLabel('/a/b/')).toBe('b')
    expect(folderLabel('/')).toBe('/')
    expect(joinPath('/a/', 'b')).toBe('/a/b')
    expect(parentPath('/a/b')).toBe('/a')
    expect(parentPath('/a')).toBe('/')
    expect(parentPath('/')).toBeNull()
  })
})

describe('projectFolders', () => {
  const session = (machine: string, path: string): ServerSession =>
    ({ id: `${machine}${path}`, serverId: 's', machine, path, folder: folderLabel(path), agent: 'claude', branch: 'main', activity: 'idle', attachable: true, tmux: null, stale: false }) as ServerSession

  it('lists each project of the machine once, sorted', () => {
    const sessions = [
      session('hp', '/p/zeta'),
      session('hp', '/p/alpha'),
      session('hp', '/p/alpha'),
      session('hp', '/p/alpha-worktrees/x'),
      session('nas', '/p/other')
    ]
    expect(projectFolders(sessions, 'hp')).toEqual(['/p/alpha', '/p/zeta'])
  })
})
