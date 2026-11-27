import { describe, expect, it } from 'vitest'
import { ServerError, UnreachableError } from '../api/client'
import { messageOf } from './useChangesActions'

describe('messageOf', () => {
  it('says git may still be running when the request timed out', () => {
    expect(messageOf(new UnreachableError('http://h:1'))).toBe("Can't reach http://h:1. Is Meshnet on? Git may still be running on the machine. Check again shortly.")
  })

  it('keeps a server error whole', () => {
    expect(messageOf(new ServerError('git said: no\nmore', 422))).toBe('git said: no\nmore')
  })
})
