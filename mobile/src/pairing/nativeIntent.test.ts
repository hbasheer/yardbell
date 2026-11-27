import { describe, expect, it } from 'vitest'
import { redirectPairingPath } from './nativeIntent'

const link = 'yardbell://pair?server=100.64.0.10%3A4000&code=abc123'

describe('redirectPairingPath', () => {
  it('turns a full pairing URL into the pair route with a link param', () => {
    expect(redirectPairingPath(link)).toBe(`/pair?link=${encodeURIComponent(link)}`)
  })

  it('turns the router-style path into the same link param', () => {
    expect(redirectPairingPath('/pair?server=100.64.0.10%3A4000&code=abc123')).toBe(
      `/pair?link=${encodeURIComponent(link)}`
    )
  })

  it('leaves other paths and existing link params alone', () => {
    expect(redirectPairingPath('/')).toBe('/')
    expect(redirectPairingPath('/pair')).toBe('/pair')
    expect(redirectPairingPath('/pair?link=x')).toBe('/pair?link=x')
  })
})
