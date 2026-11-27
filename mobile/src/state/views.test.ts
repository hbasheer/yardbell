import { describe, expect, test } from 'vitest'
import type { PairedServer } from '../servers/store'
import type { Connection } from './liveSocket'
import type { MachineView, PullView, SessionView } from './types'
import {
  feedSections,
  machineExtras,
  machineRows,
  machineSections,
  prBadge,
  projectOf,
  sessionsTab,
  siblingTabs,
  type ServerState
} from './views'

const paired = (id: string, machine = id): PairedServer => ({ id, address: `${id}.net:4000`, token: 't', machine, deviceId: '1' })

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

const machine = (name: string, over: Partial<MachineView> = {}): MachineView => ({ name, up: true, reason: null, local: false, ...over })

const srv = (id: string, machines: MachineView[], sessions: SessionView[], connection: Connection = 'connected', label = id): ServerState => ({
  server: paired(id, label),
  state: { machines, sessions },
  connection
})

const ids = (sections: { sessions: { id: string }[] }[]) => sections.map((s) => s.sessions.map((x) => x.id))

describe('projectOf', () => {
  test('a worktree belongs to its parent repo', () => {
    const p = projectOf(session({ path: '/home/u/Projects/yardbell-worktrees/mobile-app', worktree: true }))
    expect(p).toMatchObject({ label: 'yardbell', path: '/home/u/Projects/yardbell' })
    expect(projectOf(session({ path: '/home/u/Projects/yardbell' })).key).toBe(p.key)
  })

  test('falls back to cwd, then to the folder name', () => {
    expect(projectOf(session({ cwd: '/srv/web-worktrees/x/src' })).label).toBe('web')
    expect(projectOf(session({ folder: 'notes' })).label).toBe('notes')
  })

  test('same repo on two machines is two projects', () => {
    const a = projectOf(session({ machine: 'a', path: '/r/app' }))
    const b = projectOf(session({ machine: 'b', path: '/r/app' }))
    expect(a.key).not.toBe(b.key)
  })
})

describe('feedSections', () => {
  const state = [
    srv('a', [machine('mac')], [
      session({ id: '1', activity: 'blocked' }),
      session({ id: '2', activity: 'active' }),
      session({ id: '3' }),
      session({ id: '4', activity: 'blocked', stopped: 'ended' })
    ]),
    srv('b', [machine('box')], [session({ id: '5', machine: 'box', activity: 'blocked' })])
  ]

  test('needs you then working, across servers, stopped excluded', () => {
    const sections = feedSections(state)
    expect(sections.map((s) => s.kind)).toEqual(['needs-you', 'working'])
    expect(sections[0].shown.map((s) => s.id)).toEqual(['1', '5'])
    expect(sections[0].shown[1].serverId).toBe('b')
  })

  test('shows three rows and counts the rest', () => {
    const many = srv('a', [machine('mac')], ['1', '2', '3', '4', '5'].map((id) => session({ id, activity: 'blocked' })))
    const [needs] = feedSections([many])
    expect(needs.shown).toHaveLength(3)
    expect(needs.total).toBe(5)
    expect(needs.more).toBe(2)
  })

  test('nothing waiting gives no sections', () => {
    expect(feedSections([srv('a', [machine('mac')], [session({})])])).toEqual([])
    expect(feedSections([])).toEqual([])
  })
})

describe('machineRows', () => {
  test('server label only when several servers, same machine name stays separate', () => {
    const one = machineRows([srv('a', [machine('mac')], [])])
    expect(one[0].serverLabel).toBeUndefined()
    const two = machineRows([srv('a', [machine('mac')], [], 'connected', 'Alpha'), srv('b', [machine('mac')], [], 'connected', 'Beta')])
    expect(two.map((r) => [r.key, r.serverLabel])).toEqual([
      ['a:mac', 'Alpha'],
      ['b:mac', 'Beta']
    ])
  })

  test('counts live sessions and sessions needing you', () => {
    const [row] = machineRows([
      srv('a', [machine('mac')], [
        session({ id: '1', activity: 'blocked' }),
        session({ id: '2' }),
        session({ id: '3', stopped: 'ended' }),
        session({ id: '4', machine: 'other' })
      ])
    ])
    expect(row).toMatchObject({ status: 'up', sessions: 2, needsYou: 1, reason: null })
  })

  test('empty machine', () => {
    expect(machineRows([srv('a', [machine('mac')], [])])[0]).toMatchObject({ sessions: 0, needsYou: 0, status: 'up' })
  })

  test('down machine carries its reason', () => {
    const [row] = machineRows([srv('a', [machine('box', { up: false, reason: 'ssh timed out' })], [])])
    expect(row).toMatchObject({ status: 'down', reason: 'ssh timed out' })
    expect(machineRows([srv('a', [machine('box', { up: false })], [])])[0].reason).toBe('Machine is down')
  })

  test('an unreachable server overrides machines that were up, the others stay up', () => {
    const rows = machineRows([
      srv('a', [machine('mac')], [], 'unreachable'),
      srv('b', [machine('box')], [], 'connected'),
      srv('c', [machine('pi')], [], 'reconnecting')
    ])
    expect(rows.map((r) => r.status)).toEqual(['unreachable', 'up', 'reconnecting'])
    expect(rows[0].reason).toBe('Cannot reach a.net:4000')
  })

  test('a server with no state yet shows as one row', () => {
    const rows = machineRows([{ server: paired('a', 'Alpha'), state: undefined, connection: 'unreachable' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ machine: 'Alpha', status: 'unreachable', sessions: 0 })
  })
})

describe('machineSections', () => {
  const server = srv('a', [machine('mac')], [
    session({ id: 'idle1', folder: 'z', path: '/r/yardbell' }),
    session({ id: 'block', folder: 'mobile-app', path: '/r/yardbell-worktrees/mobile-app', worktree: true, activity: 'blocked' }),
    session({ id: 'work', folder: 'site', path: '/r/site', activity: 'active' }),
    session({ id: 'dead', folder: 'a', path: '/r/yardbell', stopped: 'ended' }),
    session({ id: 'stale', folder: 'b', path: '/r/yardbell', stale: true }),
    session({ id: 'x', machine: 'other', path: '/r/other' })
  ])

  test('groups by project, urgent project first, status order inside, stopped last', () => {
    const sections = machineSections(server, 'mac', 'project', '')
    expect(sections.map((s) => s.title)).toEqual(['yardbell', 'site'])
    expect(ids(sections)).toEqual([['block', 'idle1', 'dead'], ['work']])
  })

  test('hides stopped when asked', () => {
    expect(ids(machineSections(server, 'mac', 'project', '', false))).toEqual([['block', 'idle1'], ['work']])
  })

  test('groups by status in the fixed order', () => {
    const sections = machineSections(server, 'mac', 'status', '')
    expect(sections.map((s) => s.title)).toEqual(['Needs you', 'Working', 'Idle', 'Stopped'])
  })

  test('groups by agent', () => {
    const mixed = srv('a', [machine('mac')], [session({ id: '1', agent: 'codex' }), session({ id: '2', agent: 'claude', activity: 'blocked' })])
    expect(machineSections(mixed, 'mac', 'agent', '').map((s) => s.title)).toEqual(['claude', 'codex'])
  })

  test('empty machine gives no sections', () => {
    expect(machineSections(srv('a', [machine('mac')], []), 'mac', 'project', '')).toEqual([])
  })

  test('search matches folder, branch, ticket, agent and project', () => {
    const s = srv('a', [machine('mac')], [
      session({ id: 'f', folder: 'billing', path: '/r/billing' }),
      session({ id: 'b', branch: 'fix/login', path: '/r/x' }),
      session({ id: 't', ticket: 'COM-123', path: '/r/y' }),
      session({ id: 'a', agent: 'codex', path: '/r/z' }),
      session({ id: 'n', ticket: '-', path: '/r/w' })
    ])
    const found = (q: string) => machineSections(s, 'mac', 'status', q).flatMap((x) => x.sessions.map((y) => y.id))
    expect(found('billing')).toEqual(['f'])
    expect(found('login')).toEqual(['b'])
    expect(found('com-123')).toEqual(['t'])
    expect(found('codex')).toEqual(['a'])
    expect(found('-')).toEqual(['t'])
    expect(found('nothing')).toEqual([])
    expect(found('  ')).toHaveLength(5)
  })
})

describe('sessionsTab', () => {
  const servers = [
    srv('a', [machine('mac')], [session({ id: '1', path: '/r/app' }), session({ id: '2', activity: 'blocked', path: '/r/app' })], 'connected', 'Alpha'),
    srv('b', [machine('mac')], [session({ id: '3', activity: 'active', path: '/r/app' })], 'connected', 'Beta')
  ]

  test('two servers with the same machine name stay separate groups', () => {
    const sections = sessionsTab(servers, 'machine', '')
    expect(sections.map((s) => [s.title, s.subtitle])).toEqual([
      ['mac', 'Alpha'],
      ['mac', 'Beta']
    ])
    expect(ids(sections)).toEqual([['2', '1'], ['3']])
  })

  test('groups by status across servers', () => {
    expect(ids(sessionsTab(servers, 'status', ''))).toEqual([['2'], ['3'], ['1']])
  })

  test('groups by project and agent, and filters', () => {
    expect(sessionsTab(servers, 'project', '')).toHaveLength(2)
    expect(sessionsTab(servers, 'agent', '')).toHaveLength(1)
    expect(sessionsTab(servers, 'status', 'zzz')).toEqual([])
  })

  test('a single server has no subtitle', () => {
    expect(sessionsTab([servers[0]], 'machine', '')[0].subtitle).toBeUndefined()
  })
})

describe('siblingTabs', () => {
  const server = srv('a', [machine('mac')], [
    session({ id: 'idle', path: '/r/app' }),
    session({ id: 'block', path: '/r/app', activity: 'blocked' }),
    session({ id: 'elsewhere', machine: 'other' })
  ])

  test('same order as the machine screen, with the current index', () => {
    const { sessions, index } = siblingTabs(server, 'mac', 'idle')
    expect(sessions.map((s) => s.id)).toEqual(['block', 'idle'])
    expect(index).toBe(1)
    expect(sessions.map((s) => s.id)).toEqual(machineSections(server, 'mac', 'project', '').flatMap((s) => s.sessions.map((x) => x.id)))
  })

  test('unknown current gives index -1', () => {
    expect(siblingTabs(server, 'mac', 'gone').index).toBe(-1)
  })
})

describe('prBadge', () => {
  const pull = (over: Partial<PullView>): PullView => ({
    forge: 'github', number: 7, url: 'u', title: 't', state: 'open', draft: false, review: '', ...over
  })

  test('no pull gives null', () => {
    expect(prBadge(null)).toBeNull()
    expect(prBadge(undefined)).toBeNull()
  })

  test('state keys and label', () => {
    expect(prBadge(pull({}))).toEqual({ state: 'open', label: '#7' })
    expect(prBadge(pull({ draft: true }))?.state).toBe('draft')
    expect(prBadge(pull({ state: 'merged' }))?.state).toBe('merged')
    expect(prBadge(pull({ state: 'CLOSED' }))?.state).toBe('closed')
    expect(prBadge(pull({ state: 'merged', draft: true }))?.state).toBe('merged')
  })
})

describe('sessions outside tmux and last known', () => {
  const loose = session({ id: 'loose', attachable: false, tmux: null, pid: 7, activity: 'blocked' })
  const stale = session({ id: 'stale', stale: true })
  const live = session({ id: 'live', activity: 'blocked' })
  const server: ServerState = {
    ...srv('a', [machine('mac')], [live, loose, stale, session({ id: 'other', machine: 'box', attachable: false, tmux: null })]),
    state: {
      machines: [machine('mac')],
      sessions: [live, loose, stale, session({ id: 'other', machine: 'box', attachable: false, tmux: null })],
      ended: [
        { id: 'mac:old', machine: 'mac', folder: 'old', agent: 'claude' },
        { id: 'box:old', machine: 'box', folder: 'old', agent: 'claude' }
      ]
    }
  }

  test('feed, sessions tab, machine sections and tabs leave them out', () => {
    expect(feedSections([server]).flatMap((s) => s.shown.map((x) => x.id))).toEqual(['live'])
    expect(ids(sessionsTab([server], 'status', ''))).toEqual([['live']])
    expect(ids(machineSections(server, 'mac', 'project', ''))).toEqual([['live']])
    expect(siblingTabs(server, 'mac', 'live').sessions.map((s) => s.id)).toEqual(['live'])
  })

  test('machine row counts skip them and report the outside tmux count', () => {
    const [row] = machineRows([server])
    expect(row).toMatchObject({ sessions: 1, needsYou: 1, outsideTmux: 1 })
  })

  test('machineExtras splits them per machine', () => {
    const extras = machineExtras(server, 'mac')
    expect(extras.loose.map((s) => s.id)).toEqual(['loose'])
    expect(extras.loose[0].serverId).toBe('a')
    expect(extras.stale.map((s) => s.id)).toEqual(['stale'])
    expect(extras.ended.map((e) => e.id)).toEqual(['mac:old'])
    expect(machineExtras(server, 'box').loose.map((s) => s.id)).toEqual(['other'])
  })

  test('machineExtras honours the search text', () => {
    expect(machineExtras(server, 'mac', 'zzz')).toEqual({ loose: [], stale: [], ended: [] })
    expect(machineExtras(server, 'mac', 'old').ended).toHaveLength(1)
  })

  test('a server with no state has no extras', () => {
    expect(machineExtras({ server: paired('a'), state: undefined, connection: 'unreachable' }, 'mac')).toEqual({
      loose: [],
      stale: [],
      ended: []
    })
  })
})

describe('machineRows health', () => {
  const h = { mem_total_kb: 100, mem_used_kb: 50, agent_kb: 10, user_kb: 0, limit_kb: 0, limit_used_kb: 0, load1: 0.5 }
  test('carried for a connected machine, dropped when down or unreachable', () => {
    expect(machineRows([srv('a', [machine('mac', { health: h })], [])])[0].health).toEqual(h)
    expect(machineRows([srv('a', [machine('mac')], [])])[0].health).toBeNull()
    expect(machineRows([srv('a', [machine('mac', { up: false, health: h })], [])])[0].health).toBeNull()
    expect(machineRows([srv('a', [machine('mac', { health: h })], [], 'unreachable')])[0].health).toBeNull()
  })
})
