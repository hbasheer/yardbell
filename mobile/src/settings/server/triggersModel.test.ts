import { describe, expect, it } from 'vitest'
import type { TriggerState } from '../serverApi'
import { canRun, lastWord, planWord, runConfirm, runLabel, runResult, sentence, when } from './triggersModel'

const NOW = '2026-11-28T10:00:00'
const state = (over: Partial<TriggerState> = {}, trigger = {}): TriggerState => ({
  trigger: { name: 'Morning', task: 'Fix a bug', enabled: true, schedule: 'daily 09:00', ...trigger },
  kind: 'schedule',
  ...over
})

describe('when', () => {
  it('uses the server wall clock, with today, tomorrow and yesterday', () => {
    expect(when('2026-11-28T14:30:00+00:00', NOW)).toBe('14:30 today')
    expect(when('2026-11-29T09:00:00', NOW)).toBe('09:00 tomorrow')
    expect(when('2026-11-27T23:59:00', NOW)).toBe('23:59 yesterday')
    expect(when('2026-12-02T08:00:00', NOW)).toBe('Wed 2 Dec 08:00')
    expect(when(undefined, NOW)).toBe('')
    expect(when('2026-11-28T14:30:00', undefined)).toBe('')
  })
})

describe('trigger rows', () => {
  it('words the plan', () => {
    expect(planWord(state({ next: '2026-11-29T09:00:00' }), NOW)).toBe('Next 09:00 tomorrow')
    expect(planWord(state({ busy: true }), NOW)).toBe('Running now')
    expect(planWord(state({}, { enabled: false }), NOW)).toBe('Off')
    expect(planWord(state({ kind: 'linear', checked: '2026-11-28T09:55:00' }), NOW)).toBe('Checked 09:55 today')
    expect(planWord(state({ kind: 'linear' }), NOW)).toBe('')
  })

  it('words the last run and flags a failure', () => {
    const ran = state({ last: { at: '2026-11-28T09:00:00', outcome: 'ok', text: 'Started a chat', conversation: 'c1' } })
    expect(lastWord(ran, NOW)).toEqual({ text: 'Last run 09:00 today: Started a chat.', failed: false })
    expect(lastWord(state({ last: { at: '2026-11-28T09:00:00', outcome: 'watching', text: 'Watching', conversation: '' } }), NOW)?.text).toBe('09:00 today: Watching.')
    expect(lastWord(state({ last: { at: '2026-11-28T09:00:00', outcome: 'failed', text: 'The prompt is hidden', conversation: '' } }), NOW)?.failed).toBe(true)
    expect(lastWord(state(), NOW)).toBeNull()
  })

  it('only runs a ticket trigger that is on, and nothing while busy', () => {
    expect(canRun(state(), false)).toBe(true)
    expect(canRun(state(), true)).toBe(false)
    expect(canRun(state({}, { enabled: false }), false)).toBe(true)
    expect(canRun(state({ kind: 'github' }, { enabled: false }), false)).toBe(false)
    expect(runLabel(state({ kind: 'github' }))).toBe('Check now')
  })

  it('explains what Run now does before anything runs', () => {
    expect(runConfirm(state())).toMatchObject({ title: 'Run Morning now?', confirm: 'Run now' })
    expect(runConfirm(state()).message).toMatch('Fix a bug')
    expect(runConfirm(state({ kind: 'linear' })).confirm).toBe('Check now')
  })

  it('opens the conversation when the server returns one, else shows its words', () => {
    expect(runResult('Morning', { conversation: 'c9' })).toEqual({ conversation: 'c9', text: 'Morning started a conversation in Dispatch.' })
    expect(runResult('Morning', { conversation: null, text: 'checked, nothing new' })).toEqual({ conversation: null, text: 'Checked, nothing new.' })
    expect(sentence('turn it on first')).toBe('Turn it on first')
  })
})
