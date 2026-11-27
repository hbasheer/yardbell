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

  it('opens the Inbox for a proposals link', () => {
    expect(routeForLink('http://100.64.0.10:4000/proposals', [s])).toBe('/inbox/http%3A%2F%2F100.64.0.10%3A4000')
    expect(routeForLink('http://100.64.0.10:4000/proposals/?x=1', [s])).toBe('/inbox/http%3A%2F%2F100.64.0.10%3A4000')
  })

  it('opens the chat a Dispatch link names', () => {
    expect(routeForLink('http://100.64.0.10:4000/dispatch?c=abc123def4567890', [s])).toBe(
      '/dispatch/http%3A%2F%2F100.64.0.10%3A4000/abc123def4567890'
    )
    expect(routeForLink('http://100.64.0.10:4000/dispatch/?c=a%20b#x', [s])).toBe(
      '/dispatch/http%3A%2F%2F100.64.0.10%3A4000/a%20b'
    )
  })

  it('goes home for a Dispatch link without a chat or a look-alike path', () => {
    expect(routeForLink('http://100.64.0.10:4000/dispatch', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:4000/dispatchers?c=1', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:4000/proposals-old', [s])).toBe('/')
  })

  it('picks the server the link belongs to', () => {
    const other = { ...s, id: 'http://10.0.0.9:4000', address: 'http://10.0.0.9:4000/' }
    expect(routeForLink('http://10.0.0.9:4000/proposals', [s, other])).toBe('/inbox/http%3A%2F%2F10.0.0.9%3A4000')
    expect(routeForLink('http://10.0.0.9:40000/proposals', [s, other])).toBe('/')
  })

  it('needs a path, query or fragment boundary after the server address', () => {
    const short = { ...s, address: 'http://100.64.0.10:400', id: 'http://100.64.0.10:400' }
    expect(routeForLink('http://100.64.0.10:4000/proposals', [short])).toBe('/')
    expect(routeForLink('http://100.64.0.10:400/proposals', [short])).toBe('/inbox/http%3A%2F%2F100.64.0.10%3A400')
    expect(routeForLink('http://100.64.0.10:400?x=1', [short])).toBe('/')
  })

  it('opens the run a pipeline notification names', () => {
    expect(routeForLink('http://100.64.0.10:4000/pipeline?p=nightly&run=r-1', [s])).toBe(
      '/pipelines/http%3A%2F%2F100.64.0.10%3A4000/run/r-1'
    )
    expect(routeForLink('http://100.64.0.10:4000/pipeline/?p=a%20b&run=r%202#x', [s])).toBe(
      '/pipelines/http%3A%2F%2F100.64.0.10%3A4000/run/r%202'
    )
  })

  it('opens the pipelines list for a pipeline link without a run, and ignores look-alikes', () => {
    expect(routeForLink('http://100.64.0.10:4000/pipeline?p=nightly', [s])).toBe('/pipelines/http%3A%2F%2F100.64.0.10%3A4000')
    expect(routeForLink('http://100.64.0.10:4000/pipelines?run=1', [s])).toBe('/')
    expect(routeForLink('http://100.64.0.10:40000/pipeline?run=1', [s])).toBe('/')
  })
})
