import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleWithin } from './settleWithin'

afterEach(() => vi.useRealTimers())

describe('settleWithin', () => {
  it('resolves when the work finishes first', async () => {
    await expect(settleWithin(() => Promise.resolve(1), 1000)).resolves.toBeUndefined()
  })

  it('resolves at the deadline when the work never finishes', async () => {
    vi.useFakeTimers()
    const done = vi.fn()
    settleWithin(() => new Promise(() => {}), 1500).then(done)
    await vi.advanceTimersByTimeAsync(1499)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalled()
  })

  it('resolves when the work rejects or throws synchronously', async () => {
    await expect(settleWithin(() => Promise.reject(new Error('x')), 1000)).resolves.toBeUndefined()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(settleWithin(() => { throw new Error('sync') }, 1000)).resolves.toBeUndefined()
    spy.mockRestore()
  })
})
