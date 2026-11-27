import { useEffect, useMemo, useRef, useState } from 'react'
import type { PairedServer } from '../servers/store'
import { backoffMs, type SocketCtor } from '../state/liveSocket'
import { createExitBudget } from './reconnect'
import { decodeServer, encodeInput, encodeResize, encodeScroll, encodeView } from './protocol'

export type TerminalStatus = 'connecting' | 'open' | 'reconnecting' | 'ended'

export type TerminalEvents = {
  onOutput: (bytes: Uint8Array) => void
  onExit: (msg: string) => void
  onStatus: (status: TerminalStatus) => void
  onReopen: () => void
  canRetryAfterExit?: () => Promise<boolean>
}

export type TerminalSocket = {
  send: (d: string) => void
  resize: (rows: number, cols: number) => void
  scroll: (lines: number) => void
  view: (on: boolean) => void
  reconnect: () => void
  stop: () => void
}

const RETRY_CHECK_TIMEOUT_MS = 5000

type Target = { address: string; token: string }

export function terminalUrl(address: string, machine: string, name: string): string {
  return `${address.replace(/^http/, 'ws')}/term/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/ws`
}

export function openTerminalSocket(
  target: Target,
  machine: string,
  name: string,
  events: TerminalEvents,
  SocketImpl: SocketCtor = WebSocket as unknown as SocketCtor
): TerminalSocket {
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let isOpen = false
  let everOpened = false
  let ended = false
  let exitPending = false
  let generation = 0
  const budget = createExitBudget()
  let stopped = false
  let size: { rows: number; cols: number } | null = null
  let shown = true

  const status = (next: TerminalStatus) => events.onStatus(next)

  const write = (frame: string) => {
    if (isOpen && socket) socket.send(frame)
  }

  const scheduleRetry = () => {
    failures += 1
    status('reconnecting')
    if (timer) clearTimeout(timer)
    timer = setTimeout(connect, backoffMs(failures))
  }

  const finish = (msg: string) => {
    ended = true
    events.onExit(msg)
    status('ended')
  }

  const exitFrame = (from: WebSocket, msg: string) => {
    const withinBudget = budget.recordExit(Date.now())
    if (!withinBudget || !events.canRetryAfterExit) {
      finish(msg)
      return
    }
    exitPending = true
    status('reconnecting')
    const mine = generation
    let giveUp: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      giveUp = setTimeout(() => resolve(false), RETRY_CHECK_TIMEOUT_MS)
    })
    Promise.race([events.canRetryAfterExit().catch(() => false), timeout])
      .then((retry) => {
        clearTimeout(giveUp)
        if (mine !== generation) return
        exitPending = false
        if (stopped || ended) return
        if (!retry) {
          finish(msg)
          return
        }
        if (socket === from) {
          socket = null
          isOpen = false
          from.close()
        }
        scheduleRetry()
      })
  }

  const connect = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const next = new SocketImpl(terminalUrl(target.address, machine, name), undefined, {
      headers: { Authorization: `Bearer ${target.token}` }
    })
    next.binaryType = 'arraybuffer'
    socket = next
    next.onopen = () => {
      if (socket !== next) return
      isOpen = true
      failures = 0
      if (everOpened) events.onReopen()
      everOpened = true
      status('open')
      if (size) write(encodeResize(size.rows, size.cols))
      write(encodeView(shown))
    }
    next.onmessage = (event: MessageEvent) => {
      if (socket !== next) return
      const frame = decodeServer(event.data as string | ArrayBuffer)
      if (frame.kind === 'output') {
        events.onOutput(frame.bytes)
        return
      }
      exitFrame(next, frame.msg)
    }
    next.onclose = () => {
      if (socket !== next || stopped) return
      socket = null
      isOpen = false
      if (ended || exitPending) return
      scheduleRetry()
    }
  }

  status('connecting')
  connect()

  return {
    send: (d) => write(encodeInput(d)),
    resize(rows, cols) {
      size = { rows, cols }
      write(encodeResize(rows, cols))
    },
    scroll: (lines) => write(encodeScroll(lines)),
    view(on) {
      shown = on
      write(encodeView(on))
    },
    reconnect() {
      if (stopped) return
      generation += 1
      budget.reset()
      ended = false
      exitPending = false
      failures = 0
      if (timer) clearTimeout(timer)
      timer = null
      const old = socket
      socket = null
      isOpen = false
      old?.close()
      status('connecting')
      connect()
    },
    stop() {
      stopped = true
      generation += 1
      if (timer) clearTimeout(timer)
      timer = null
      socket?.close()
      socket = null
      isOpen = false
    }
  }
}

export function useTerminalSocket(
  server: PairedServer | null,
  machine: string,
  name: string,
  onOutput: (bytes: Uint8Array) => void,
  onExit: (msg: string) => void,
  onReopen: () => void,
  canRetryAfterExit?: () => Promise<boolean>
): Omit<TerminalSocket, 'stop'> & { status: TerminalStatus } {
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const socket = useRef<TerminalSocket | null>(null)
  const handlers = useRef({ onOutput, onExit, onReopen, canRetryAfterExit })
  handlers.current = { onOutput, onExit, onReopen, canRetryAfterExit }
  const size = useRef<{ rows: number; cols: number } | null>(null)
  const shown = useRef(true)

  const address = server?.address
  const token = server?.token
  useEffect(() => {
    if (!address || !token) return
    const live = openTerminalSocket({ address, token }, machine, name, {
      onOutput: (bytes) => handlers.current.onOutput(bytes),
      onExit: (msg) => handlers.current.onExit(msg),
      onReopen: () => handlers.current.onReopen(),
      canRetryAfterExit: () => handlers.current.canRetryAfterExit?.() ?? Promise.resolve(false),
      onStatus: setStatus
    })
    if (size.current) live.resize(size.current.rows, size.current.cols)
    live.view(shown.current)
    socket.current = live
    return () => {
      live.stop()
      if (socket.current === live) socket.current = null
    }
  }, [address, token, machine, name])

  const actions = useMemo(
    () => ({
      send: (d: string) => socket.current?.send(d),
      resize(rows: number, cols: number) {
        size.current = { rows, cols }
        socket.current?.resize(rows, cols)
      },
      scroll: (lines: number) => socket.current?.scroll(lines),
      view(on: boolean) {
        shown.current = on
        socket.current?.view(on)
      },
      reconnect: () => socket.current?.reconnect()
    }),
    []
  )
  return { ...actions, status }
}
