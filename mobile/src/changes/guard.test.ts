import { describe, expect, it } from 'vitest'
import { createGuard } from './guard'

describe('createGuard', () => {
  it('lets one action start and refuses the second until the first ends', () => {
    const guard = createGuard()
    expect(guard.begin('commit')).toBe(true)
    expect(guard.begin('commit')).toBe(false)
    expect(guard.begin('push')).toBe(false)
    expect(guard.current()).toBe('commit')
    guard.end()
    expect(guard.current()).toBeNull()
    expect(guard.begin('push')).toBe(true)
  })
})
