import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { openTerminalSocket, terminalUrl, type TerminalEvents } from './useTerminalSocket'

class FakeSocket {
  static all: FakeSocket[] = []
  static OPEN = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  binaryType = 'blob'
  readyState = 0
  sent: string[] = []
  closed = false
  constructor(
    readonly url: string,
    _protocols?: string | string[],
    readonly options?: { headers: Record<string, string> }
  ) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
  receive(data: string | ArrayBuffer) {
    this.onmessage?.({ data })
  }
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1]

function start() {
  const events: TerminalEvents = { onOutput: vi.fn(), onExit: vi.fn(), onStatus: vi.fn(), onReopen: vi.fn() }
  const socket = openTerminalSocket(
    { address: 'http://100.64.0.1:4000', token: 'tok' },
    'hp box',
    'main',
    events,
    FakeSocket as unknown as typeof WebSocket
  )
  return { events, socket }
}

beforeEach(() => {
  FakeSocket.all = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('openTerminalSocket', () => {
  test('connects to the session with the bearer token and binary frames', () => {
    const { events } = start()
    expect(latest().url).toBe('ws://100.64.0.1:4000/term/hp%20box/main/ws')
    expect(latest().options?.headers.Authorization).toBe('Bearer tok')
    expect(latest().binaryType).toBe('arraybuffer')
    expect(events.onStatus).toHaveBeenLastCalledWith('connecting')
  })

  test('terminalUrl keeps https as wss', () => {
    expect(terminalUrl('https://a.example', 'm', 'a/b')).toBe('wss://a.example/term/m/a%2Fb/ws')
  })

  test('opening reports the size and says the terminal is shown', () => {
    const { socket } = start()
    socket.resize(30, 80)
    latest().open()
    expect(latest().sent).toEqual(['{"t":"resize","rows":30,"cols":80}', '{"t":"view","on":true}'])
  })

  test('reconnects_and_drops_input_while_down', () => {
    const { socket, events } = start()
    latest().open()
    socket.resize(40, 100)
    socket.send('a')
    expect(latest().sent).toContain('{"t":"in","d":"a"}')

    const first = latest()
    first.drop()
    expect(events.onStatus).toHaveBeenLastCalledWith('reconnecting')
    socket.send('x')
    expect(first.sent).not.toContain('{"t":"in","d":"x"}')

    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    expect(latest().sent).toEqual([])
    latest().open()
    expect(events.onStatus).toHaveBeenLastCalledWith('open')
    expect(latest().sent[0]).toBe('{"t":"resize","rows":40,"cols":100}')
    expect(latest().sent.some((frame) => frame.includes('"x"'))).toBe(false)
  })

  test('a reopen is signalled before the new socket delivers output', () => {
    const order: string[] = []
    const { events } = start()
    events.onReopen = vi.fn(() => order.push('reopen'))
    events.onOutput = vi.fn(() => order.push('output'))
    latest().open()
    expect(events.onReopen).not.toHaveBeenCalled()
    latest().drop()
    vi.advanceTimersByTime(1000)
    latest().open()
    latest().receive(new Uint8Array([104]).buffer)
    expect(order).toEqual(['reopen', 'output'])
  })

  test('backs off like the live socket', () => {
    start()
    latest().drop()
    vi.advanceTimersByTime(999)
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    latest().drop()
    vi.advanceTimersByTime(1999)
    expect(FakeSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(3)
  })

  test('exit_frame_shows_message', () => {
    const { events } = start()
    latest().open()
    latest().receive('{"t":"exit","msg":"session ended"}')
    expect(events.onExit).toHaveBeenCalledWith('session ended')
    expect(events.onStatus).toHaveBeenLastCalledWith('ended')
    latest().drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(events.onStatus).toHaveBeenLastCalledWith('ended')
  })

  test('an exit frame for a session still listed reconnects with backoff and says reconnecting', async () => {
    const { events } = start()
    events.canRetryAfterExit = vi.fn(async () => true)
    latest().open()
    latest().receive('{"t":"exit","msg":"session ended or machine unreachable"}')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.onExit).not.toHaveBeenCalled()
    expect(events.onStatus).toHaveBeenLastCalledWith('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    latest().open()
    expect(events.onReopen).toHaveBeenCalled()
  })

  test('the third exit within a minute ends the session', async () => {
    const { events } = start()
    events.canRetryAfterExit = vi.fn(async () => true)
    for (let i = 0; i < 2; i++) {
      latest().open()
      latest().receive('{"t":"exit","msg":"x"}')
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(1000)
    }
    latest().open()
    latest().receive('{"t":"exit","msg":"x"}')
    expect(events.onExit).toHaveBeenCalledWith('x')
    expect(events.onStatus).toHaveBeenLastCalledWith('ended')
  })

  test('an exit frame for a session no longer listed ends it', async () => {
    const { events } = start()
    events.canRetryAfterExit = vi.fn(async () => false)
    latest().open()
    latest().receive('{"t":"exit","msg":"gone"}')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.onExit).toHaveBeenCalledWith('gone')
    expect(events.onStatus).toHaveBeenLastCalledWith('ended')
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  test('reconnect after ended connects at once and restores the budget', () => {
    const { events, socket } = start()
    latest().open()
    latest().receive('{"t":"exit","msg":"x"}')
    socket.reconnect()
    expect(FakeSocket.all).toHaveLength(2)
    expect(events.onStatus).toHaveBeenLastCalledWith('connecting')
    latest().open()
    expect(events.onReopen).toHaveBeenCalled()
    expect(events.onStatus).toHaveBeenLastCalledWith('open')
  })

  test('reconnect while a backoff timer is pending leaves one connection', () => {
    const { socket } = start()
    latest().drop()
    expect(FakeSocket.all).toHaveLength(1)
    socket.reconnect()
    expect(FakeSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  test('reconnect while an exit refetch is pending ignores the late result', async () => {
    const { events, socket } = start()
    let answer: (retry: boolean) => void = () => {}
    events.canRetryAfterExit = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    latest().open()
    latest().receive('{"t":"exit","msg":"x"}')
    socket.reconnect()
    latest().drop()
    answer(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.onExit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(3)
    answer(true)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all.length).toBeLessThanOrEqual(8)
    expect(events.onStatus).not.toHaveBeenCalledWith('ended')
  })

  test('a hung refetch times out and ends with a reconnect available', async () => {
    const { events, socket } = start()
    events.canRetryAfterExit = vi.fn(() => new Promise<boolean>(() => {}))
    latest().open()
    latest().receive('{"t":"exit","msg":"x"}')
    expect(events.onStatus).toHaveBeenLastCalledWith('reconnecting')
    await vi.advanceTimersByTimeAsync(5000)
    expect(events.onExit).toHaveBeenCalledWith('x')
    expect(events.onStatus).toHaveBeenLastCalledWith('ended')
    socket.reconnect()
    expect(FakeSocket.all).toHaveLength(2)
  })

  test('binary frames are passed on as output', () => {
    const { events } = start()
    latest().open()
    latest().receive(new Uint8Array([104, 105]).buffer)
    expect(Array.from((events.onOutput as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual([104, 105])
  })

  test('scroll and view go out only while open', () => {
    const { socket } = start()
    socket.scroll(-2)
    latest().open()
    socket.scroll(-2)
    socket.view(false)
    expect(latest().sent.slice(-2)).toEqual(['{"t":"scroll","lines":-2}', '{"t":"view","on":false}'])
  })

  test('a hidden terminal reconnects without claiming the view', () => {
    const { socket } = start()
    latest().open()
    socket.view(false)
    latest().drop()
    vi.advanceTimersByTime(1000)
    latest().open()
    expect(latest().sent).toEqual(['{"t":"view","on":false}'])
  })

  test('stop closes and stays closed', () => {
    const { socket } = start()
    const first = latest()
    socket.stop()
    expect(first.closed).toBe(true)
    first.drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })
})
