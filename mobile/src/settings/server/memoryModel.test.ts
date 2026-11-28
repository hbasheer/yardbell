import { describe, expect, it } from 'vitest'
import { capBar, entryChange, entryLimit, entryProblem, historyHead, kb, overCap } from './memoryModel'

describe('cap bar', () => {
  it('goes from ok to warning at 80 percent and full at the cap', () => {
    expect(capBar({ bytes: 2048, max_bytes: 8192 })).toEqual({ percent: 25, width: 25, tone: 'ok', label: '2.0 KB of 8.0 KB used' })
    expect(capBar({ bytes: 6554, max_bytes: 8192 }).tone).toBe('warn')
    expect(capBar({ bytes: 9000, max_bytes: 8192 })).toMatchObject({ percent: 100, tone: 'full' })
  })

  it('keeps an empty memory visible and survives a zero cap', () => {
    expect(capBar({ bytes: 0, max_bytes: 8192 }).width).toBe(1)
    expect(capBar({ bytes: 5, max_bytes: 0 }).percent).toBe(0)
    expect(kb(1536)).toBe('1.5 KB')
  })

  it('names how many entries the cap leaves out', () => {
    expect(overCap(0)).toBeNull()
    expect(overCap(1)).toMatch('leaves out the last one')
    expect(overCap(3)).toMatch('leaves out the last 3')
  })
})

describe('entries and history', () => {
  it('checks an entry before it is sent', () => {
    expect(entryProblem('  ', 500)).toBe('Write the entry first')
    expect(entryProblem('x'.repeat(501), 500)).toMatch('at most 500')
    expect(entryProblem('Use docker.', 500)).toBeNull()
  })

  it('builds add and replace requests from the trimmed text', () => {
    expect(entryChange(null, ' Use docker. ')).toEqual({ change: 'add', entry: 'Use docker.' })
    expect(entryChange('Old', ' New ')).toEqual({ change: 'replace', old: 'Old', entry: 'New' })
  })

  it('takes the entry limit from the server when it sends one', () => {
    expect(entryLimit({ max_entry_chars: 300 })).toBe(300)
    expect(entryLimit(undefined)).toBe(500)
  })

  it('says who made a change', () => {
    expect(historyHead({ change: 'forget', at: '', by: 'you' }, '10:00')).toBe('Forgot 10:00 · by you, here')
    expect(historyHead({ change: 'add', at: '', by: 'dispatch' }, '10:00')).toBe('Added 10:00 · proposed by Dispatch, approved by you')
  })
})
