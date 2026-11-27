import { useEffect, useState } from 'react'

export type Health = { mem_total_kb?: number; mem_used_kb?: number; limit_kb?: number; limit_used_kb?: number }
export type Machine = { name: string; up: boolean; reason?: string | null; local?: boolean; health?: Health | null }
export type Pull = { number?: number; url?: string; state?: string; [k: string]: unknown }
export type Session = {
  id: string
  machine: string
  agent: string
  folder?: string
  ticket?: string
  branch?: string
  activity?: string
  attachable?: boolean
  stale?: boolean
  stopped?: boolean
  tmux?: string
  path?: string
  cwd?: string
  pull?: Pull | null
}
export type Project = { id: string; machine: string; path: string; name: string; repo?: string; sessions: string[] }
export type Agent = { name: string; label: string }
export type YardbellState = {
  machines: Machine[]
  sessions: Session[]
  projects: Project[]
  agents: Agent[]
  proposals?: number
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (res.status === 401) {
    location.assign('/login')
    throw new Error('log in first')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Yardbell answered ${res.status}`)
  return body as T
}

const RETRY = [1000, 2000, 5000, 10000, 30000]
const POLL = 5000

// The server says on a websocket when the state changed and the page fetches /state then, as the
// old pages do; while the socket is down it polls instead.
export function useYardbellState(): { state: YardbellState | null; live: boolean; updated: number; offline: boolean } {
  const [state, setState] = useState<YardbellState | null>(null)
  const [live, setLive] = useState(false)
  const [updated, setUpdated] = useState(0)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | null = null
    let attempt = 0
    let retry = 0
    let poll = 0

    const load = () =>
      getJson<YardbellState>('/state')
        .then((s) => {
          if (stopped) return
          setState(s)
          setUpdated(Date.now())
          setOffline(false)
        })
        .catch(() => !stopped && setOffline(true))

    const startPoll = () => {
      clearInterval(poll)
      poll = window.setInterval(load, POLL)
    }

    const connect = () => {
      if (stopped) return
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/state/live`)
      socket = ws
      ws.onopen = () => {
        attempt = 0
        setLive(true)
        clearInterval(poll)
        load()
      }
      ws.onmessage = load
      ws.onclose = () => {
        if (stopped) return
        socket = null
        setLive(false)
        startPoll()
        retry = window.setTimeout(connect, RETRY[Math.min(attempt++, RETRY.length - 1)])
      }
    }

    load()
    startPoll()
    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      clearInterval(poll)
      socket?.close()
    }
  }, [])

  return { state, live, updated, offline }
}
