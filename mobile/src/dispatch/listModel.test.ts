import { describe, expect, it } from 'vitest'
import {
  activeCount,
  chatState,
  clearedMessage,
  dispatchHref,
  dispatchWaiting,
  feedPick,
  filterRows,
  footerOf,
  groupByServer,
  pipelinedIds,
  sortRows,
  stateWord,
  timeAgo,
  type ConversationRow
} from './listModel'

const row = (over: Partial<ConversationRow>): ConversationRow => ({
  id: 'a',
  title: 'Chat',
  updated: '2026-11-27T10:00:00Z',
  busy: false,
  waiting: 0,
  trigger: null,
  serverId: 's1',
  machine: 'hp',
  ...over
})

const NOW = Date.parse('2026-11-27T12:00:00Z')

describe('state word', () => {
  it('prefers waiting over busy', () => {
    expect(chatState(row({ waiting: 2, busy: true }))).toBe('waiting')
    expect(stateWord(row({ waiting: 2 }), NOW)).toEqual({ word: 'Needs you', rest: '2 waiting', state: 'waiting' })
  })
  it('says Working while busy', () => {
    expect(stateWord(row({ busy: true }), NOW).word).toBe('Working')
  })
  it('falls back to time ago', () => {
    expect(stateWord(row({}), NOW).word).toBe('2 h ago')
  })
})

describe('timeAgo', () => {
  it('buckets', () => {
    expect(timeAgo('2026-11-27T11:59:30Z', NOW)).toBe('Just now')
    expect(timeAgo('2026-11-27T11:15:00Z', NOW)).toBe('45 min ago')
    expect(timeAgo('2026-11-25T12:00:00Z', NOW)).toBe('2 d ago')
  })
  it('is empty for a bad stamp', () => {
    expect(timeAgo('nope', NOW)).toBe('')
  })
})

describe('footer', () => {
  it('joins trigger and backend', () => {
    expect(footerOf(row({ trigger: 'Nightly', backend: 'codex' }))).toBe('Trigger Nightly · Codex')
    expect(footerOf(row({}))).toBe('')
  })
})

describe('sort, filter, group', () => {
  const a = row({ id: 'a', updated: '2026-11-27T09:00:00Z', title: 'Fix the Webhook' })
  const b = row({ id: 'b', updated: '2026-11-27T11:00:00Z', title: 'Review pipeline', serverId: 's2', machine: 'mac' })
  it('sorts newest first across servers', () => {
    expect(sortRows([a, b]).map((r) => r.id)).toEqual(['b', 'a'])
  })
  it('filters by title, case-insensitive, blank keeps all', () => {
    expect(filterRows([a, b], 'webhook').map((r) => r.id)).toEqual(['a'])
    expect(filterRows([a, b], '  ')).toHaveLength(2)
  })
  it('groups by server in first-seen order', () => {
    expect(groupByServer([b, a]).map((g) => [g.machine, g.rows.length])).toEqual([['mac', 1], ['hp', 1]])
  })
})

describe('feed pick', () => {
  const rows = [
    row({ id: 'idle', updated: '2026-11-27T11:59:00Z' }),
    row({ id: 'w1', busy: true, updated: '2026-11-27T11:00:00Z' }),
    row({ id: 'n1', waiting: 1, updated: '2026-11-27T08:00:00Z' }),
    row({ id: 'w2', busy: true, updated: '2026-11-27T11:30:00Z' }),
    row({ id: 'n2', waiting: 3, updated: '2026-11-27T09:00:00Z' })
  ]
  it('takes three, waiting first then working, newest first', () => {
    expect(feedPick(rows).map((r) => r.id)).toEqual(['n2', 'n1', 'w2'])
  })
  it('skips idle chats', () => {
    expect(feedPick([rows[0]])).toEqual([])
    expect(activeCount(rows)).toBe(4)
  })
})

describe('misc', () => {
  it('sums waiting over servers', () => {
    expect(dispatchWaiting([{ state: { waiting: 2 } }, {}, { state: { waiting: 1 } }])).toBe(3)
  })
  it('says how many were kept', () => {
    expect(clearedMessage(0)).toBe('Cleared every chat.')
    expect(clearedMessage(2)).toContain('2 are still working')
  })
  it('encodes the route', () => {
    expect(dispatchHref('a b', 'x/1')).toBe('/dispatch/a%20b/x%2F1')
  })
})

describe('pipelinedIds', () => {
  it('collects the conversations that pipeline runs started', () => {
    expect([...pipelinedIds([{ conversation: 'c1' }, { conversation: '' }, {}, { conversation: 'c1' }, { conversation: 'c2' }])]).toEqual(['c1', 'c2'])
  })
})
