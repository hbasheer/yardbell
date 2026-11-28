import { describe, expect, it } from 'vitest'
import { connectedNote, parseMinutes, PHONE_MAIN, PHONE_PULLS, shown, waitWord } from './phoneModel'

describe('wait minutes', () => {
  it('accepts whole minutes from 0 to 60', () => {
    expect(parseMinutes(' 5 ')).toEqual({ value: 5 })
    expect(parseMinutes('0')).toEqual({ value: 0 })
    expect(parseMinutes('60')).toEqual({ value: 60 })
  })

  it('refuses anything else with the range in the message', () => {
    for (const text of ['', 'abc', '-1', '1.5', '61', '5 min']) expect(parseMinutes(text)).toEqual({ error: 'Enter a whole number of minutes from 0 to 60' })
  })

  it('words the wait', () => {
    expect(waitWord(0)).toBe('At once')
    expect(waitWord(1)).toBe('After 1 minute')
    expect(waitWord(5)).toBe('After 5 minutes')
  })
})

describe('switches', () => {
  it('lists every phone switch the server has, including Dispatch, once', () => {
    const keys = [...PHONE_MAIN, ...PHONE_PULLS].map(([k]) => k)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(expect.arrayContaining(['dispatch', 'session_ended', 'pull_closed', 'limit_reset']))
    expect(keys).toHaveLength(13)
  })

  it('shows a value being saved over the server value', () => {
    const phone = { wait_minutes: 5, dispatch: true } as never
    expect(shown(phone, { dispatch: false })).toMatchObject({ dispatch: false, wait_minutes: 5 })
  })

  it('says whether the app is connected', () => {
    expect(connectedNote(true)).toMatch('is connected')
    expect(connectedNote(undefined)).toMatch('No phone')
  })
})
