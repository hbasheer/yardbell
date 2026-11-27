import { describe, expect, test } from 'vitest'
import type { StateView } from '../state/types'
import { createExitBudget, isListedLive, shouldReconnectOnForeground, shouldRetryAfterExit } from './reconnect'

const state = (over: Record<string, unknown> = {}) =>
  ({
    sessions: [{ machine: 'hp', tmux: 'main', attachable: true, stale: false, stopped: null, ...over }]
  }) as unknown as StateView

describe('exit budget', () => {
  test('allows two exits and refuses the third within a minute', () => {
    const budget = createExitBudget()
    expect(budget.recordExit(0)).toBe(true)
    expect(budget.recordExit(10_000)).toBe(true)
    expect(budget.recordExit(20_000)).toBe(false)
  })

  test('exits older than a minute no longer count', () => {
    const budget = createExitBudget()
    budget.recordExit(0)
    budget.recordExit(10_000)
    expect(budget.recordExit(70_000)).toBe(true)
  })

  test('reset restores the budget', () => {
    const budget = createExitBudget()
    budget.recordExit(0)
    budget.recordExit(1)
    budget.reset()
    expect(budget.recordExit(2)).toBe(true)
  })
})

describe('isListedLive', () => {
  test('live session', () => expect(isListedLive(state(), 'hp', 'main')).toBe(true))
  test('unknown state', () => expect(isListedLive(undefined, 'hp', 'main')).toBe(false))
  test('missing, other machine', () => {
    expect(isListedLive(state(), 'hp', 'other')).toBe(false)
    expect(isListedLive(state(), 'mac', 'main')).toBe(false)
  })
  test('stopped, stale, not attachable', () => {
    expect(isListedLive(state({ stopped: 'stopped' }), 'hp', 'main')).toBe(false)
    expect(isListedLive(state({ stale: true }), 'hp', 'main')).toBe(false)
    expect(isListedLive(state({ attachable: false }), 'hp', 'main')).toBe(false)
  })
})

describe('decisions', () => {
  test('retry needs budget and a live listing', () => {
    expect(shouldRetryAfterExit(true, state(), 'hp', 'main')).toBe(true)
    expect(shouldRetryAfterExit(false, state(), 'hp', 'main')).toBe(false)
    expect(shouldRetryAfterExit(true, state({ stopped: 'x' }), 'hp', 'main')).toBe(false)
  })

  test('foreground reconnects only a down terminal of a listed session', () => {
    expect(shouldReconnectOnForeground('ended', state(), 'hp', 'main')).toBe(true)
    expect(shouldReconnectOnForeground('reconnecting', state(), 'hp', 'main')).toBe(true)
    expect(shouldReconnectOnForeground('open', state(), 'hp', 'main')).toBe(false)
    expect(shouldReconnectOnForeground('ended', state({ stale: true }), 'hp', 'main')).toBe(false)
  })
})
