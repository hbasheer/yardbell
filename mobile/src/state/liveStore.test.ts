import { describe, expect, test, vi } from 'vitest'
import type { LiveSocket, LiveSocketEvents } from './liveSocket'
import { createLiveStore } from './liveStore'

function setup() {
  const opened: { events: LiveSocketEvents; socket: LiveSocket }[] = []
  const store = createLiveStore((_target, events) => {
    const socket = { reconnectNow: vi.fn(), restart: vi.fn(), stop: vi.fn() }
    opened.push({ events, socket })
    return socket
  })
  return { store, opened }
}

const server = { id: 's1', address: 'http://a:1', token: 't' }

describe('liveStore', () => {
  test('one socket per server however many screens acquire it', () => {
    const { store, opened } = setup()
    const releases = [store.acquire(server, vi.fn()), store.acquire(server, vi.fn()), store.acquire(server, vi.fn())]
    expect(opened).toHaveLength(1)
    releases[0]()
    releases[1]()
    expect(opened[0].socket.stop).not.toHaveBeenCalled()
    releases[2]()
    expect(opened[0].socket.stop).toHaveBeenCalledTimes(1)
    expect(store.size()).toBe(0)
  })

  test('releasing twice does not drop another screen', () => {
    const { store, opened } = setup()
    const first = store.acquire(server, vi.fn())
    store.acquire(server, vi.fn())
    first()
    first()
    expect(opened[0].socket.stop).not.toHaveBeenCalled()
  })

  test('separate servers get separate sockets', () => {
    const { store, opened } = setup()
    store.acquire(server, vi.fn())
    store.acquire({ ...server, id: 's2' }, vi.fn())
    expect(opened).toHaveLength(2)
  })

  test('connection changes reach subscribers, including ones that subscribed first', () => {
    const { store, opened } = setup()
    const listener = vi.fn()
    store.subscribe('s1', listener)
    expect(store.connection('s1')).toBe('reconnecting')
    store.acquire(server, vi.fn())
    opened[0].events.onConnection('connected')
    expect(store.connection('s1')).toBe('connected')
    expect(listener).toHaveBeenCalledTimes(1)
    opened[0].events.onConnection('connected')
    expect(listener).toHaveBeenCalledTimes(1)
    opened[0].events.onConnection('unreachable')
    expect(store.connection('s1')).toBe('unreachable')
  })

  test('live changes call the handler given when the socket was opened', () => {
    const { store, opened } = setup()
    const onChange = vi.fn()
    store.acquire(server, onChange)
    store.acquire(server, vi.fn())
    opened[0].events.onChange()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('restart and reconnectNow reach the shared socket', () => {
    const { store, opened } = setup()
    store.acquire(server, vi.fn())
    store.restart('s1')
    store.reconnectNow('s1')
    expect(opened[0].socket.restart).toHaveBeenCalledTimes(1)
    expect(opened[0].socket.reconnectNow).toHaveBeenCalledTimes(1)
  })

  test('a changed address or token replaces the socket and keeps the holders', () => {
    const { store, opened } = setup()
    const listener = vi.fn()
    store.subscribe('s1', listener)
    const releaseA = store.acquire(server, vi.fn())
    store.acquire({ ...server, address: 'http://b:2' }, vi.fn())
    expect(opened).toHaveLength(2)
    expect(opened[0].socket.stop).toHaveBeenCalledTimes(1)
    opened[0].events.onConnection('connected')
    expect(store.connection('s1')).toBe('reconnecting')
    releaseA()
    expect(opened[1].socket.stop).not.toHaveBeenCalled()
  })

  test('a late event from a closed socket is ignored after release', () => {
    const { store, opened } = setup()
    store.acquire(server, vi.fn())()
    opened[0].events.onConnection('connected')
    expect(store.connection('s1')).toBe('reconnecting')
  })
})
