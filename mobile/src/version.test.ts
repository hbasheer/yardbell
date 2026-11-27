import { describe, expect, it } from 'vitest'
import { versionCode } from './version'

describe('versionCode', () => {
  it('packs major, minor and patch into one integer', () => {
    expect(versionCode('0.11.107')).toBe(11107)
    expect(versionCode('1.2.3')).toBe(1002003)
  })

  it('rejects anything but x.y.z', () => {
    expect(() => versionCode('0.11')).toThrow()
    expect(() => versionCode('0.11.7-beta')).toThrow()
  })
})
