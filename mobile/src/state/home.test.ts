import { describe, expect, test } from 'vitest'
import type { PairedServer } from '../servers/store'
import { homeSections } from './home'
import type { SessionView, StateView } from './types'

const server = (id: string): PairedServer => ({ id, address: id, token: 't', machine: id, deviceId: '1' })

const session = (over: Partial<SessionView>): SessionView => ({
  id: 's',
  machine: 'mac',
  agent: 'claude',
  folder: 'app',
  branch: 'main',
  activity: 'idle',
  attachable: true,
  tmux: 'app',
  stale: false,
  stopped: null,
  ...over
})

const state = (machines: string[], sessions: SessionView[]): StateView => ({
  machines: machines.map((name) => ({ name, up: true, reason: null, local: false })),
  sessions
})

describe('homeSections', () => {
  test('waiting sessions lead in needs you, across servers', () => {
    const sections = homeSections([
      { server: server('a'), state: state(['mac'], [session({ id: '1', activity: 'blocked' }), session({ id: '2' })]) },
      { server: server('b'), state: state(['box'], [session({ id: '3', machine: 'box', activity: 'blocked' })]) }
    ])
    expect(sections[0].kind).toBe('needs-you')
    expect(sections[0].sessions.map((s) => s.id)).toEqual(['1', '3'])
    expect(sections.slice(1).flatMap((s) => s.sessions.map((x) => x.id))).toEqual(['2'])
  })

  test('stopped blocked sessions stay in their machine', () => {
    const sections = homeSections([
      { server: server('a'), state: state(['mac'], [session({ id: '1', activity: 'blocked', stopped: 'ended' })]) }
    ])
    expect(sections.map((s) => s.kind)).toEqual(['machine'])
    expect(sections[0].sessions).toHaveLength(1)
  })

  test('machines keep server order and show when empty', () => {
    const sections = homeSections([
      {
        server: server('a'),
        state: state(['zeta', 'alpha'], [
          session({ id: '1', machine: 'alpha', folder: 'b', attachable: false }),
          session({ id: '2', machine: 'alpha', folder: 'z' }),
          session({ id: '3', machine: 'alpha', folder: 'a' })
        ])
      }
    ])
    expect(sections.map((s) => s.title)).toEqual(['zeta', 'alpha'])
    expect(sections[0].sessions).toEqual([])
    expect(sections[1].sessions.map((s) => s.id)).toEqual(['3', '2', '1'])
  })

  test('server title only when more than one server', () => {
    const one = homeSections([{ server: server('a'), state: state(['mac'], []) }])
    expect(one[0].server).toBeUndefined()
    const two = homeSections([
      { server: server('a'), state: state(['mac'], []) },
      { server: server('b'), state: state(['box'], []) }
    ])
    expect(two.map((s) => s.server)).toEqual(['a', 'b'])
  })
})
