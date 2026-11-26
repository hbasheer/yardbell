import { useEffect, useMemo, useRef, useState } from 'react'
import type { PairedServer } from '../servers/store'
import { backoffMs, type SocketCtor } from '../state/liveSocket'
import { decodeServer, encodeInput, encodeResize, encodeScroll, encodeView } from './protocol'

export type TerminalStatus = 'connecting' | 'open' | 'reconnecting' | 'ended'

export type TerminalEvents = {
  onOutput: (bytes: Uint8Array) => void
  onExit: (msg: string) => void
  onStatus: (status: TerminalStatus) => void
}

export type TerminalSocket = {
  send: (d: string) => void
  resize: (rows: number, cols: number) => void
  scroll: (lines: number) => void
  view: (on: boolean) => void
  stop: () => void
}

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
  let ended = false
  let stopped = false
  let size: { rows: number; cols: number } | null = null
  let shown = true

  const status = (next: TerminalStatus) => events.onStatus(next)

  const write = (frame: string) => {
    if (isOpen && socket) socket.send(frame)
  }

  const connect = () => {
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
      ended = true
      events.onExit(frame.msg)
      status('ended')
    }
    next.onclose = () => {
      if (socket !== next || stopped) return
      socket = null
      isOpen = false
      if (ended) return
      failures += 1
      status('reconnecting')
      timer = setTimeout(connect, backoffMs(failures))
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
    stop() {
      stopped = true
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
  onExit: (msg: string) => void
): Omit<TerminalSocket, 'stop'> & { status: TerminalStatus } {
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const socket = useRef<TerminalSocket | null>(null)
  const handlers = useRef({ onOutput, onExit })
  handlers.current = { onOutput, onExit }
  const size = useRef<{ rows: number; cols: number } | null>(null)
  const shown = useRef(true)

  const address = server?.address
  const token = server?.token
  useEffect(() => {
    if (!address || !token) return
    const live = openTerminalSocket({ address, token }, machine, name, {
      onOutput: (bytes) => handlers.current.onOutput(bytes),
      onExit: (msg) => handlers.current.onExit(msg),
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
      }
    }),
    []
  )
  return { ...actions, status }
}
