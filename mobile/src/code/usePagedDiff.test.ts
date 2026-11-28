import { describe, expect, it } from 'vitest'
import { initialPaged, pagedReducer, type DiffPage } from './usePagedDiff'

const page = (from: number, next: number, total = 10): DiffPage => ({ lines: [{ k: 'ctx', o: from + 1, n: from + 1, t: 'x' }], from, next, total })

describe('pagedReducer', () => {
  it('keeps the loaded diff when showing more fails, and clears the failure on the next try', () => {
    let s = pagedReducer(initialPaged(), { type: 'first', page: page(0, 5) })
    s = pagedReducer(s, { type: 'moreStarted' })
    s = pagedReducer(s, { type: 'moreFailed', message: 'boom' })
    expect(s.error).toBeNull()
    expect(s.moreError).toBe('boom')
    expect(s.loadingMore).toBe(false)
    expect(s.pages).toMatchObject({ next: 5 })
    expect(s.pages?.lines).toHaveLength(1)
    s = pagedReducer(s, { type: 'moreStarted' })
    expect(s.moreError).toBeNull()
    s = pagedReducer(s, { type: 'more', page: page(5, 10) })
    expect(s.pages).toMatchObject({ next: 10 })
    expect(s.pages?.lines).toHaveLength(2)
  })

  it('fails the first load into error and reset clears everything', () => {
    const failed = pagedReducer(initialPaged(), { type: 'firstFailed', message: 'down' })
    expect(failed.error).toBe('down')
    expect(failed.pages).toBeNull()
    expect(pagedReducer(failed, { type: 'reset' })).toEqual(initialPaged())
  })
})
