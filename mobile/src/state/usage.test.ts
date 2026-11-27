import { describe, expect, test } from 'vitest'
import { isPast, percentOf, providersOf, resetLabel, resetWord, tightestWindow, toneOf } from './usage'

const NOW = 1_800_000_000_000
const at = (secondsFromNow: number) => NOW / 1000 + secondsFromNow

describe('providersOf', () => {
  test('keeps providers that have a message and drops empty ones', () => {
    const out = providersOf({
      providers: [
        { id: 'claude', name: 'Claude', windows: [{ label: '5 hour', used: 0.5 }] },
        { id: 'codex', name: 'Codex', windows: [], status: 'signed_out', message: 'Not signed in' },
        { id: 'gemini', name: 'Gemini', windows: [] }
      ]
    })
    expect(out.map((p) => p.id)).toEqual(['claude', 'codex'])
    expect(out[1].message).toBe('Not signed in')
  })

  test('falls back to the older claude and codex fields', () => {
    const out = providersOf({ windows: [{ label: '5 hour' }], codex: { windows: [{ label: 'Weekly' }] } })
    expect(out.map((p) => p.name)).toEqual(['Claude', 'Codex'])
  })

  test('is empty for no reply', () => {
    expect(providersOf(null)).toEqual([])
    expect(providersOf({})).toEqual([])
  })
})

describe('windows', () => {
  test('a window past its reset counts as zero percent', () => {
    const w = { label: '5 hour', used: 0.9, resets_at: at(-60) }
    expect(isPast(w, NOW)).toBe(true)
    expect(percentOf(w, NOW)).toBe(0)
    expect(resetLabel(w, NOW)).toBe('reset')
  })

  test('percent rounds and clamps', () => {
    expect(percentOf({ label: 'a', used: 0.624 }, NOW)).toBe(62)
    expect(percentOf({ label: 'a', used: 1.4 }, NOW)).toBe(100)
    expect(percentOf({ label: 'a' }, NOW)).toBe(0)
  })

  test('tightest ignores past windows unless all are past', () => {
    const past = { label: 'old', used: 0.99, resets_at: at(-1) }
    const a = { label: 'a', used: 0.2, resets_at: at(100) }
    const b = { label: 'b', used: 0.7, resets_at: at(100) }
    expect(tightestWindow([past, a, b], NOW).label).toBe('b')
    expect(tightestWindow([past], NOW).label).toBe('old')
  })

  test('tone thresholds', () => {
    expect([79, 80, 89, 90].map(toneOf)).toEqual(['ok', 'warn', 'warn', 'critical'])
  })
})

describe('resetWord', () => {
  test('minutes, hours and days', () => {
    expect(resetWord(at(14 * 60), NOW)).toBe('14m')
    expect(resetWord(at(2 * 3600 + 14 * 60), NOW)).toBe('2h 14m')
    expect(resetWord(at(3 * 86400 + 5 * 3600), NOW)).toBe('3d 5h')
    expect(resetWord(undefined, NOW)).toBe('')
  })

  test('label says resets in', () => {
    expect(resetLabel({ label: 'a', resets_at: at(3600) }, NOW)).toBe('resets in 1h 0m')
    expect(resetLabel({ label: 'a' }, NOW)).toBe('')
  })
})
