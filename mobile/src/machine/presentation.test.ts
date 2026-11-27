import { describe, expect, test } from 'vitest'
import type { StateView } from '@/state/types'
import type { ServerState } from '@/state/views'
import { machineBody, machineStatus, stateLine } from './presentation'

const server = { id: 's', address: 'http://a:1', token: 't', machine: 'hp', deviceId: 'd' }
const session = (id: string, machine = 'hp') => ({
  id,
  machine,
  agent: 'claude',
  folder: id,
  branch: 'main',
  activity: 'idle' as const,
  attachable: true,
  tmux: id,
  stale: false
})
const state = (over: Partial<StateView> = {}): StateView => ({
  machines: [
    { name: 'hp', up: true, reason: null, local: true },
    { name: 'nas', up: false, reason: 'ssh timed out', local: false }
  ],
  sessions: [session('a')],
  ...over
})
const entry = (over: Partial<ServerState> = {}): ServerState => ({
  server,
  state: state(),
  connection: 'connected',
  ...over
})

describe('machineStatus', () => {
  test('loading before the first state, unreachable after failures', () => {
    expect(machineStatus(entry({ state: undefined, connection: 'reconnecting' }), 'hp').status).toBe('loading')
    const down = machineStatus(entry({ state: undefined, connection: 'unreachable' }), 'hp')
    expect(down).toMatchObject({ status: 'unreachable', reason: 'Cannot reach http://a:1' })
  })

  test('a machine the server reports down carries its reason', () => {
    expect(machineStatus(entry(), 'nas')).toMatchObject({ status: 'down', reason: 'ssh timed out' })
  })

  test('a machine the server does not list is down with an explanation', () => {
    expect(machineStatus(entry(), 'ghost')).toMatchObject({ status: 'down', reason: 'hp does not list ghost' })
  })

  test('up counts sessions', () => {
    expect(machineStatus(entry(), 'hp')).toMatchObject({ status: 'up', sessions: 1, needsYou: 0 })
  })
})

describe('machineBody', () => {
  test('picks the screen state', () => {
    expect(machineBody(entry({ state: undefined, connection: 'reconnecting' }), 'hp', '', 0)).toBe('loading')
    expect(machineBody(entry({ state: undefined, connection: 'unreachable' }), 'hp', '', 0)).toBe('unreachable')
    expect(machineBody(entry(), 'nas', '', 0)).toBe('down')
    expect(machineBody(entry(), 'hp', '', 1)).toBe('list')
    expect(machineBody(entry(), 'hp', 'zzz', 0)).toBe('no-match')
  })

  test('no sessions at all is empty, with or without a query', () => {
    const none = entry({ state: state({ sessions: [] }) })
    expect(machineBody(none, 'hp', '', 0)).toBe('empty')
    expect(machineBody(none, 'hp', 'x', 0)).toBe('empty')
  })

  test('cached sessions stay listed while the server is unreachable', () => {
    expect(machineBody(entry({ connection: 'unreachable' }), 'hp', '', 1)).toBe('list')
  })

  test('no visible sessions while the server is not connected is unreachable, not empty', () => {
    const none = state({ sessions: [] })
    expect(machineBody(entry({ state: none, connection: 'unreachable' }), 'hp', '', 0)).toBe('unreachable')
    expect(machineBody(entry({ state: none, connection: 'reconnecting' }), 'hp', '', 0)).toBe('unreachable')
  })

  test('hidden stopped sessions leave an empty list, not a no-match', () => {
    const stopped = entry({ state: state({ sessions: [{ ...session('a'), stopped: 'exited 0' }] }) })
    expect(machineBody(stopped, 'hp', '', 0)).toBe('empty')
  })
})

describe('stateLine', () => {
  test('connected with counts and optional server', () => {
    expect(stateLine({ status: 'up', reason: null, sessions: 2, needsYou: 1 }, null)).toBe('Connected · 2 sessions, 1 needs you')
    expect(stateLine({ status: 'up', reason: null, sessions: 1, needsYou: 0 }, 'mac')).toBe('Connected on mac · 1 session')
  })

  test('problems show the reason', () => {
    expect(stateLine({ status: 'down', reason: 'ssh timed out', sessions: 0, needsYou: 0 }, null)).toBe('ssh timed out')
    expect(stateLine({ status: 'loading', reason: null, sessions: 0, needsYou: 0 }, null)).toBe('Connecting')
  })
})
