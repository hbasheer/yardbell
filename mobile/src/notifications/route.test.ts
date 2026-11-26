import { describe, expect, it } from 'vitest'
import { routeForLink } from './route'

const s = { id: 'http://100.64.0.10:4000', address: 'http://100.64.0.10:4000', token: 't', machine: 'hp', deviceId: '1' }

describe('routeForLink', () => {
  it('opens the session a paired server links to', () => {
    expect(routeForLink('http://100.64.0.10:4000/term/hp/yb-fix%20it', [s])).toBe(
      '/session/http%3A%2F%2F100.64.0.10%3A4000/hp/yb-fix%20it'
    )
  })

  it('decodes each segment before encoding it again', () => {
    expect(routeForLink('http://100.64.0.10:4000/term/dev%20box/a%20b%2F%C3%BC', [s])).toBe(
      '/session/http%3A%2F%2F100.64.0.10%3A4000/dev%20box/a%20b%2F%C3%BC'
    )
  })

  it('goes home for a link that is not a session', () => {
    expect(routeForLink('http://100.64.0.10:4000/', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:4000/term/hp', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:4000/term/hp/x/y', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:4000/term/hp/%E0%A4%A', [s])).toBe('/')
  })

  it('goes home for a server that is not paired', () => {
    expect(routeForLink('http://10.0.0.9:4000/term/hp/x', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:40000/term/hp/x', [s])).toBe('/')
  })
})
