import { describe, expect, it, vi } from 'vitest'
vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }))
import { router } from 'expo-router'
import { ServerError, SignedOutError } from './client'
import { routeIfSignedOut, signedOutHref } from './signedOut'

describe('signed out routing', () => {
  it('builds the signed-out href for a SignedOutError', () => {
    expect(signedOutHref(new SignedOutError(), 'http://a:4000')).toBe('/signed-out?server=http%3A%2F%2Fa%3A4000')
  })

  it('ignores other errors', () => {
    expect(signedOutHref(new ServerError('x', 500), 'id')).toBeNull()
    expect(routeIfSignedOut(new Error('x'), 'id')).toBe(false)
  })

  it('replaces the route for a SignedOutError', () => {
    expect(routeIfSignedOut(new SignedOutError(), 'id')).toBe(true)
    expect(router.replace).toHaveBeenCalledWith('/signed-out?server=id')
  })
})
