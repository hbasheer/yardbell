import { describe, expect, it } from 'vitest'
import type { Proposal } from './api'
import type { ServerState } from '../state/views'
import { countsOf, deleteCopy, emptyCopy, inboxHref, inboxRows, inboxRowSubtitle, sectionsFor } from './model'

const proposal = (id: string, status: string): Proposal =>
  ({ role: 'action', id, tool: 'save_task', input: {}, status, by: 'client', at: '2026-01-01T00:00:00Z' }) as Proposal

const list = [proposal('a', 'pending'), proposal('b', 'approved'), proposal('c', 'pending'), proposal('d', 'rejected'), proposal('e', 'edited')]

describe('inbox sections', () => {
  it('counts waiting and decided', () => {
    expect(countsOf(list)).toEqual({ waiting: 2, decided: 3 })
  })

  it('groups All into Waiting then Decided, keeping order', () => {
    const sections = sectionsFor(list, 'all')
    expect(sections.map((s) => [s.key, s.title, s.proposals.map((p) => p.id)])).toEqual([
      ['waiting', 'Waiting for you', ['a', 'c']],
      ['decided', 'Decided', ['b', 'd', 'e']]
    ])
  })

  it('filters by tab and skips empty sections', () => {
    expect(sectionsFor(list, 'waiting').map((s) => s.key)).toEqual(['waiting'])
    expect(sectionsFor(list, 'decided').map((s) => s.key)).toEqual(['decided'])
    expect(sectionsFor([proposal('a', 'approved')], 'all').map((s) => s.key)).toEqual(['decided'])
    expect(sectionsFor([], 'all')).toEqual([])
  })
})

describe('inbox copy', () => {
  it('uses the web empty texts', () => {
    expect(emptyCopy('all')).toEqual({ title: 'Nothing waits for you.', message: 'Changes that MCP clients ask for land here.' })
    expect(emptyCopy('waiting')).toEqual({ title: 'Nothing waits for you.' })
    expect(emptyCopy('decided')).toEqual({ title: 'Nothing decided yet.' })
  })

  it('warns that a waiting proposal will not run when deleted', () => {
    expect(deleteCopy(proposal('a', 'pending')).message).toBe('It has not run, and it will not.')
    expect(deleteCopy(proposal('b', 'approved')).message).toBeUndefined()
  })
})

describe('inbox rows', () => {
  const server = (id: string, machine: string, proposals?: number): ServerState =>
    ({ server: { id, machine }, state: proposals === undefined ? undefined : { proposals }, connection: 'connected' }) as unknown as ServerState

  it('has one row per server with proposals', () => {
    const rows = inboxRows([server('s1', 'hp', 2), server('s2', 'mini', 0), server('s3', 'pro'), server('s4', 'box', 1)])
    expect(rows).toEqual([
      { serverId: 's1', machine: 'hp', waiting: 2 },
      { serverId: 's4', machine: 'box', waiting: 1 }
    ])
  })

  it('names the server only when there are several', () => {
    const row = { serverId: 's1', machine: 'hp', waiting: 2 }
    expect(inboxRowSubtitle(row, 1)).toBe('2 proposals wait for you')
    expect(inboxRowSubtitle({ ...row, waiting: 1 }, 2)).toBe('1 proposal waits for you · hp')
  })

  it('encodes the server id in the route', () => {
    expect(inboxHref('http://hp:4210')).toBe('/inbox/http%3A%2F%2Fhp%3A4210')
  })
})
