export type Connection = 'connected' | 'reconnecting' | 'unreachable'

export type LiveSocketEvents = {
  onChange: () => void
  onConnection: (connection: Connection) => void
}

export type LiveSocket = {
  reconnectNow: () => void
  stop: () => void
}

type Target = { address: string; token: string }
type SocketCtor = new (url: string, protocols?: string | string[], options?: { headers: Record<string, string> }) => WebSocket

const FAILURES_BEFORE_UNREACHABLE = 3
const MAX_DELAY_MS = 30_000

export function liveUrl(address: string): string {
  return `${address.replace(/^http/, 'ws')}/state/live`
}

export function openLiveSocket(
  target: Target,
  events: LiveSocketEvents,
  SocketImpl: SocketCtor = WebSocket as unknown as SocketCtor
): LiveSocket {
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let isOpen = false
  let stopped = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const connect = () => {
    clearTimer()
    const next = new SocketImpl(liveUrl(target.address), undefined, {
      headers: { Authorization: `Bearer ${target.token}` }
    })
    socket = next
    next.onopen = () => {
      if (socket !== next) return
      isOpen = true
      failures = 0
      events.onConnection('connected')
      events.onChange()
    }
    next.onmessage = () => {
      if (socket === next) events.onChange()
    }
    next.onclose = () => {
      if (socket !== next || stopped) return
      socket = null
      isOpen = false
      failures += 1
      events.onConnection(failures >= FAILURES_BEFORE_UNREACHABLE ? 'unreachable' : 'reconnecting')
      timer = setTimeout(connect, Math.min(2 ** (failures - 1) * 1000, MAX_DELAY_MS))
    }
  }

  connect()

  return {
    reconnectNow() {
      if (stopped || isOpen || socket) return
      connect()
    },
    stop() {
      stopped = true
      clearTimer()
      socket?.close()
      socket = null
    }
  }
}
