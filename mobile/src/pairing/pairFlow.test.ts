import { describe, expect, it, vi } from 'vitest'
import { ServerTooOldError } from '../api/client'
import { pairWithLink, signInWithPasscode, type PairDeps } from './pairFlow'

const server = { id: 'http://a:4000', address: 'http://a:4000', token: 't', machine: 'hp', deviceId: '1' }

function deps(overrides: Partial<PairDeps> = {}): PairDeps {
  return {
    pair: vi.fn().mockResolvedValue(server),
    signIn: vi.fn().mockResolvedValue(server),
    saveServer: vi.fn().mockResolvedValue(undefined),
    deviceName: () => 'Pixel',
    ...overrides
  }
}

describe('pairWithLink', () => {
  it('pairs with the link and device name, then saves the server', async () => {
    const d = deps()
    const result = await pairWithLink('yardbell://pair?server=a&code=x', d)
    expect(d.pair).toHaveBeenCalledWith('yardbell://pair?server=a&code=x', 'Pixel')
    expect(d.saveServer).toHaveBeenCalledWith(server)
    expect(result).toEqual({ ok: true })
  })

  it('returns the message of a ServerTooOldError and saves nothing', async () => {
    const d = deps({ pair: vi.fn().mockRejectedValue(new ServerTooOldError('hp')) })
    const result = await pairWithLink('yardbell://pair?server=a&code=x', d)
    expect(result).toEqual({ ok: false, message: 'Update Yardbell on hp to 0.11.110 or later' })
    expect(d.saveServer).not.toHaveBeenCalled()
  })
})

describe('signInWithPasscode', () => {
  it('signs in with address, passcode and device name, then saves', async () => {
    const d = deps()
    expect(await signInWithPasscode('a:4000', '123456', d)).toEqual({ ok: true })
    expect(d.signIn).toHaveBeenCalledWith('a:4000', '123456', 'Pixel')
    expect(d.saveServer).toHaveBeenCalledWith(server)
  })

  it('returns the error message when sign-in fails', async () => {
    const d = deps({ signIn: vi.fn().mockRejectedValue(new Error('Wrong passcode')) })
    expect(await signInWithPasscode('a:4000', '1', d)).toEqual({ ok: false, message: 'Wrong passcode' })
  })
})
