import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { openLiveSocket, type LiveSocketEvents } from './liveSocket'

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(
    readonly url: string,
    _protocols?: string | string[],
    readonly options?: { headers: Record<string, string> }
  ) {
    FakeSocket.all.push(this)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  drop() {
    this.onclose?.()
  }
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1]

function start() {
  const events: LiveSocketEvents = { onChange: vi.fn(), onConnection: vi.fn() }
  const live = openLiveSocket(
    { address: 'http://100.64.0.1:4000', token: 'tok' },
    events,
    FakeSocket as unknown as typeof WebSocket
  )
  return { events, live }
}

beforeEach(() => {
  FakeSocket.all = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('openLiveSocket', () => {
  test('connects to the ws url with the bearer token', () => {
    start()
    expect(latest().url).toBe('ws://100.64.0.1:4000/state/live')
    expect(latest().options?.headers.Authorization).toBe('Bearer tok')
  })

  test('refetches_after_live_socket_reopens', () => {
    const { events } = start()
    latest().open()
    expect(events.onConnection).toHaveBeenLastCalledWith('connected')
    expect(events.onChange).toHaveBeenCalledTimes(1)
    latest().drop()
    expect(events.onConnection).toHaveBeenLastCalledWith('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    latest().open()
    expect(events.onChange).toHaveBeenCalledTimes(2)
    latest().onmessage?.()
    expect(events.onChange).toHaveBeenCalledTimes(3)
  })

  test('marks unreachable after three failed reconnects', () => {
    const { events } = start()
    latest().drop()
    vi.advanceTimersByTime(1000)
    latest().drop()
    expect(events.onConnection).toHaveBeenLastCalledWith('reconnecting')
    vi.advanceTimersByTime(2000)
    latest().drop()
    expect(events.onConnection).toHaveBeenLastCalledWith('unreachable')
    vi.advanceTimersByTime(4000)
    expect(FakeSocket.all).toHaveLength(4)
  })

  test('backoff caps at 30 seconds', () => {
    start()
    for (let i = 0; i < 8; i++) {
      latest().drop()
      vi.advanceTimersByTime(30_000)
    }
    const before = FakeSocket.all.length
    latest().drop()
    vi.advanceTimersByTime(29_999)
    expect(FakeSocket.all).toHaveLength(before)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(before + 1)
  })

  test('reconnectNow skips the wait', () => {
    const { live } = start()
    latest().drop()
    live.reconnectNow()
    expect(FakeSocket.all).toHaveLength(2)
  })

  test('restart drops the open socket and connects again at once', () => {
    const { events, live } = start()
    const first = latest()
    first.open()
    live.restart()
    expect(first.closed).toBe(true)
    expect(FakeSocket.all).toHaveLength(2)
    expect(events.onConnection).toHaveBeenLastCalledWith('reconnecting')
    first.drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(2)
    latest().open()
    expect(events.onConnection).toHaveBeenLastCalledWith('connected')
  })

  test('restart after stop does nothing', () => {
    const { live } = start()
    live.stop()
    live.restart()
    expect(FakeSocket.all).toHaveLength(1)
  })

  test('stop closes the socket and stops reconnecting', () => {
    const { live } = start()
    const socket = latest()
    live.stop()
    expect(socket.closed).toBe(true)
    socket.drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })
})
