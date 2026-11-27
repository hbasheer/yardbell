import { describe, expect, test } from 'vitest'
import type { StateView } from '../state/types'
import type { ServerSession, ServerState } from '../state/views'
import {
  CLEAR_TERMINAL,
  DEFAULT_TEXT_SIZE,
  dotState,
  detailRows,
  othersNeedYou,
  parseTextSize,
  sessionBody,
  statusLine,
  stepTarget,
  tabSections,
  tabSessions
} from './chrome'

const server = { id: 's', address: 'http://a:1', token: 't', machine: 'hp', deviceId: 'd' }
const make = (id: string, over: Partial<ServerSession> = {}): ServerSession => ({
  id,
  serverId: 's',
  machine: 'hp',
  agent: 'claude',
  folder: id,
  branch: 'main',
  activity: 'idle',
  attachable: true,
  tmux: id,
  stale: false,
  ...over
})
const entry = (sessions: ServerSession[], over: Partial<StateView> = {}, connection: ServerState['connection'] = 'connected'): ServerState => ({
  server,
  state: { machines: [{ name: 'hp', up: true, reason: null, local: true }], sessions, ...over },
  connection
})

describe('tabSessions', () => {
  test('lists attachable running sessions of the machine in screen order and finds the current one', () => {
    const e = entry([
      make('b', { activity: 'active' }),
      make('a', { activity: 'blocked' }),
      make('c', { stopped: 'exited 0' }),
      make('d', { attachable: false, tmux: null }),
      make('e', { machine: 'nas' })
    ])
    const tabs = tabSessions(e, 'hp', 'b')
    expect(tabs.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(tabs.index).toBe(1)
  })

  test('keeps the current session even when it is stopped, and reports -1 when it is gone', () => {
    const e = entry([make('a'), make('c', { stopped: 'exited 0' })])
    expect(tabSessions(e, 'hp', 'c').sessions.map((s) => s.id)).toEqual(['a', 'c'])
    expect(tabSessions(e, 'hp', 'zzz').index).toBe(-1)
  })
})

describe('stepTarget', () => {
  const tabs = { sessions: [make('a'), make('b'), make('c')], index: 1 }
  test('steps to neighbours and stops at the ends', () => {
    expect(stepTarget(tabs, 'next')?.id).toBe('c')
    expect(stepTarget(tabs, 'previous')?.id).toBe('a')
    expect(stepTarget({ ...tabs, index: 2 }, 'next')).toBeNull()
    expect(stepTarget({ ...tabs, index: 0 }, 'previous')).toBeNull()
    expect(stepTarget({ ...tabs, index: -1 }, 'next')).toBeNull()
  })
})

describe('tabSections', () => {
  test('groups into Needs you, Working and Everything else and drops empty sections', () => {
    const sections = tabSections([make('a', { activity: 'blocked' }), make('b'), make('c', { activity: 'active' })])
    expect(sections.map((s) => [s.title, s.sessions.map((x) => x.id)])).toEqual([
      ['Needs you', ['a']],
      ['Working', ['c']],
      ['Everything else', ['b']]
    ])
    expect(tabSections([make('a')]).map((s) => s.title)).toEqual(['Everything else'])
  })

  test('othersNeedYou ignores the current session', () => {
    const list = [make('a', { activity: 'blocked' }), make('b')]
    expect(othersNeedYou(list, 'a')).toBe(false)
    expect(othersNeedYou(list, 'b')).toBe(true)
  })
})

describe('statusLine', () => {
  test('joins agent and branch and skips placeholders', () => {
    expect(statusLine(make('a', { branch: 'wip' }))).toBe('claude · wip')
    expect(statusLine(make('a', { branch: '-' }))).toBe('claude')
    expect(statusLine(undefined)).toBe('')
  })
})

describe('sessionBody', () => {
  test('shows the terminal for a live session and while state is loading', () => {
    expect(sessionBody(entry([make('a')]), 'hp', 'a', 'connecting').kind).toBe('terminal')
    expect(sessionBody({ server, state: undefined, connection: 'reconnecting' }, 'hp', 'a', 'connecting').kind).toBe('terminal')
  })

  test('offline when the server is unreachable before any state, or the machine is down', () => {
    expect(sessionBody({ server, state: undefined, connection: 'unreachable' }, 'hp', 'a', 'connecting')).toMatchObject({
      kind: 'offline',
      message: 'Cannot reach http://a:1'
    })
    const down = entry([make('a')], { machines: [{ name: 'hp', up: false, reason: 'ssh timed out', local: true }] })
    expect(sessionBody(down, 'hp', 'a', 'open')).toMatchObject({ kind: 'offline', message: 'ssh timed out' })
  })

  test('gone when the session is missing, stopped or stale', () => {
    expect(sessionBody(entry([]), 'hp', 'a', 'ended').kind).toBe('gone')
    expect(sessionBody(entry([]), 'hp', 'a', 'open').kind).toBe('terminal')
    expect(sessionBody(entry([make('a', { stopped: 'exited 0' })]), 'hp', 'a', 'open')).toMatchObject({
      kind: 'gone',
      title: 'Session stopped'
    })
    expect(sessionBody(entry([make('a', { stale: true })]), 'hp', 'a', 'open').kind).toBe('gone')
  })
})

describe('dotState', () => {
  test('follows the terminal link, the server and the body', () => {
    const terminal = { kind: 'terminal' } as const
    expect(dotState('connected', 'open', terminal)).toBe('connected')
    expect(dotState('connected', 'reconnecting', terminal)).toBe('reconnecting')
    expect(dotState('connected', 'connecting', terminal)).toBe('connecting')
    expect(dotState('unreachable', 'open', terminal)).toBe('unreachable')
    expect(dotState('connected', 'open', { kind: 'gone', title: '', message: '' })).toBe('disconnected')
  })
})

describe('detailRows', () => {
  test('lists the known fields and links the pull request', () => {
    const rows = detailRows(
      make('a', {
        path: '/home/dev/yardbell',
        ticket: 'YB-1',
        pull: { forge: 'github', number: 4, url: 'https://x/4', title: 'Fix', state: 'open', draft: false, review: '' }
      }),
      'http://a:1'
    )
    expect(rows.map((r) => r.key)).toEqual(['folder', 'path', 'machine', 'server', 'branch', 'pull', 'ticket', 'agent'])
    expect(rows.find((r) => r.key === 'pull')).toMatchObject({ value: '#4 Fix', url: 'https://x/4' })
  })

  test('falls back to cwd and drops missing fields', () => {
    const rows = detailRows(make('a', { cwd: '/w', branch: '-', agent: '' }), 'http://a:1')
    expect(rows.map((r) => r.key)).toEqual(['folder', 'path', 'machine', 'server'])
    expect(rows[1].value).toBe('/w')
  })
})

describe('text size and clear', () => {
  test('parses only the sizes the terminal page offers', () => {
    expect(parseTextSize('16')).toBe(16)
    expect(parseTextSize('15')).toBe(DEFAULT_TEXT_SIZE)
    expect(parseTextSize(null)).toBe(DEFAULT_TEXT_SIZE)
  })
  test('clear sends Ctrl+L', () => {
    expect(CLEAR_TERMINAL.charCodeAt(0)).toBe(0x0c)
  })
})
