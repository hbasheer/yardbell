import { describe, expect, it } from 'vitest'
import type { Insights } from '../types'
import { aboutOf, amount, duration, factsOf, fromLine, improveMark, parseSuggestion, partLines, pullWord, shares, spentCards, statusOf, suggestHref, suggestionOf, timelineOf, times } from './model'

const base = {
  machine: 'hp',
  name: 'yardbell-2',
  live: true,
  attachable: true,
  activity: 'idle',
  work: { title: 'Fix the webhook bug', first_prompt: 'Find why' },
  parts: null,
  timeline: {
    machine: 'hp',
    name: 'yardbell-2',
    agent: 'claude',
    folder: 'yardbell',
    branch: 'fix',
    since: '2026-11-28T08:00:00Z',
    started: true,
    ended: null,
    periods: [
      { state: 'working', from: '2026-11-28T08:00:00Z', to: '2026-11-28T09:00:00Z', seconds: 3600 },
      { state: 'waiting', from: '2026-11-28T09:00:00Z', to: '2026-11-28T09:10:00Z', seconds: 600 },
      { state: 'idle', from: '2026-11-28T09:10:00Z', to: null, seconds: 60 }
    ],
    totals: { working: 3600, waiting: 600, idle: 60 },
    runs: [
      { at: '2026-11-28T08:30:00Z', kind: 'tool', text: 'cargo test' },
      { at: '2026-11-28T08:40:00Z', kind: 'test', text: '3 passed', ok: true },
      { at: '2026-11-28T08:50:00Z', kind: 'test', text: '1 failed', ok: false }
    ],
    dropped: 0
  },
  earlier: [],
  scrollback_error: null,
  task: '',
  conversation: null,
  pull: null,
  suggest: 'Look at the session',
  from: { name: 'Fix a bug', version: 1, current: 2 }
} as unknown as Insights

describe('insights model', () => {
  it('words durations as the web does', () => {
    expect(duration(30)).toBe('under a minute')
    expect(duration(600)).toBe('10 min')
    expect(duration(3600)).toBe('1 h')
    expect(duration(5400)).toBe('1 h 30 min')
    expect(amount(0)).toBe('0 min')
    expect(amount(40)).toBe('<1 min')
    expect(times(1, 'step')).toBe('1 step')
    expect(times(2, 'step')).toBe('2 steps')
  })

  it('makes shares that add up to 100', () => {
    expect(shares([1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100)
    expect(shares([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('reads the status', () => {
    expect(statusOf(base)).toEqual({ word: 'Running, idle now', tone: 'muted' })
    expect(statusOf({ ...base, activity: 'blocked' }).tone).toBe('warn')
    expect(statusOf({ ...base, live: false }).word).toBe('No longer running')
    expect(statusOf({ ...base, timeline: { ...base.timeline!, ended: '2026-11-28T10:00:00Z' } }).word).toBe('Ended')
  })

  it('picks the about line and the facts', () => {
    expect(aboutOf(base)).toBe('Fix the webhook bug')
    expect(aboutOf({ ...base, work: { first_prompt: 'Find why' }, task: 'x' })).toBe('')
    expect(factsOf(base, new Date('2026-11-28T12:00:00Z')).map((f) => f.name)).toEqual(['Started', 'Machine', 'Folder', 'Branch', 'Agent'])
  })

  it('counts waits and test results', () => {
    const { cards, tests } = spentCards(base.timeline!)
    expect(cards.map((c) => c.state)).toEqual(['working', 'waiting', 'idle'])
    expect(cards[1].sub).toContain('1 time')
    expect(tests).toMatchObject({ amount: '2 runs', sub: '1 passed, 1 failed' })
  })

  it('merges periods and runs by time and hides tool runs once the transcript tells it', () => {
    const plain = timelineOf(base)
    expect(plain.items.map((i) => i.kind)).toEqual(['period', 'run', 'run', 'run', 'period', 'period'])
    const told = timelineOf({ ...base, parts: { periods: [{ did: [{ tool: 'Bash', what: 'x' }] }, { did: [] }, { did: [] }] } })
    expect(told.told).toBe(true)
    expect(told.items.some((i) => i.kind === 'run' && i.run.kind === 'tool')).toBe(false)
  })

  it('lists what a part said', () => {
    expect(partLines({ asked: ['go'], question: 'ok?', summary: 'did it', did: [] }).map((l) => l.who)).toEqual(['You said', 'It asked', 'Did'])
  })

  it('describes a pull request and the task it came from', () => {
    expect(pullWord({ state: 'open', draft: true } as never)).toBe('Draft')
    expect(pullWord({ state: 'merged', draft: false } as never)).toBe('Merged')
    expect(fromLine(base.from!)).toBe('From the task Fix a bug, version 1. It is at version 2 now.')
    expect(fromLine({ name: 'A', version: 2, current: 2 })).toBe('From the task A, version 2.')
  })

  it('builds the improve mark the way the web does', () => {
    expect(improveMark(base)).toEqual({ machine: 'hp', name: 'yardbell-2', task: { name: 'Fix a bug', version: 1 } })
    expect(improveMark({ ...base, from: undefined })).toEqual({ machine: 'hp', name: 'yardbell-2' })
  })

  it('round trips a suggestion through the route and rejects bad input', () => {
    const suggestion = suggestionOf(base)
    const href = suggestHref('srv 1', suggestion)
    expect(href.startsWith('/dispatch/srv%201/new?suggest=')).toBe(true)
    const value = decodeURIComponent(href.split('suggest=')[1])
    expect(parseSuggestion(value)).toEqual(suggestion)
    expect(parseSuggestion(undefined)).toBeNull()
    expect(parseSuggestion('nope')).toBeNull()
    expect(parseSuggestion(JSON.stringify({ text: ' ', improve: { machine: 'a', name: 'b' } }))).toBeNull()
    expect(parseSuggestion(JSON.stringify({ text: 'x', improve: { machine: 'a' } }))).toBeNull()
  })
})
