import { describe, expect, it, vi } from 'vitest'
import { ServerError } from '../api/client'
import { createTaskRunner, errorText } from './taskRunner'

const setup = () => {
  const events: string[] = []
  const errors: unknown[] = []
  const run = createTaskRunner(() => ({
    start: (name) => events.push(`start:${name}`),
    before: async () => events.push('before'),
    fail: (error) => errors.push(error),
    end: () => events.push('end')
  }))
  return { run, events, errors }
}

describe('createTaskRunner', () => {
  it('sends one request when an action is tapped twice', async () => {
    const { run, events } = setup()
    let release: () => void = () => {}
    const task = vi.fn(() => new Promise<string>((resolve) => (release = () => resolve('ok'))))
    const first = run('pass', task)
    const second = run('pass', task)
    const other = run('drop', task)
    expect(await second).toBeUndefined()
    expect(await other).toBeUndefined()
    await Promise.resolve()
    release()
    expect(await first).toBe('ok')
    expect(task).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['start:pass', 'before', 'end'])
  })

  it('runs again once the first request has ended, even after an error', async () => {
    const { run, errors } = setup()
    expect(await run('answer', () => Promise.reject(new ServerError('the run is not waiting for you\nany more', 409)))).toBeUndefined()
    expect(errorText(errors[0])).toBe('the run is not waiting for you\nany more')
    expect(await run('answer', async () => 1)).toBe(1)
  })

  it('still runs the task when cancelling polls fails', async () => {
    const run = createTaskRunner(() => ({ start: () => {}, before: () => Promise.reject(new Error('x')), fail: () => {}, end: () => {} }))
    expect(await run('start', async () => 'started')).toBe('started')
  })
})
