import { openLiveSocket, type Connection, type LiveSocket, type LiveSocketEvents } from './liveSocket'

type Target = { id: string; address: string; token: string }
type Open = (target: { address: string; token: string }, events: LiveSocketEvents) => LiveSocket

type Entry = {
  address: string
  token: string
  refs: number
  connection: Connection
  socket: LiveSocket
}

export function createLiveStore(open: Open = openLiveSocket) {
  const entries = new Map<string, Entry>()
  const listeners = new Map<string, Set<() => void>>()

  const notify = (id: string) => {
    for (const listener of listeners.get(id) ?? []) listener()
  }

  const start = (target: Target, onChange: () => void, refs: number): Entry => {
    const entry: Entry = {
      address: target.address,
      token: target.token,
      refs,
      connection: 'reconnecting',
      socket: undefined as unknown as LiveSocket
    }
    entry.socket = open(
      { address: target.address, token: target.token },
      {
        onChange,
        onConnection: (connection) => {
          if (entries.get(target.id) !== entry || entry.connection === connection) return
          entry.connection = connection
          notify(target.id)
        }
      }
    )
    return entry
  }

  return {
    acquire(target: Target, onChange: () => void): () => void {
      const existing = entries.get(target.id)
      let entry: Entry
      if (!existing) {
        entry = start(target, onChange, 0)
        entries.set(target.id, entry)
      } else if (existing.address !== target.address || existing.token !== target.token) {
        existing.socket.stop()
        entry = start(target, onChange, existing.refs)
        entries.set(target.id, entry)
        notify(target.id)
      } else {
        entry = existing
      }
      entry.refs += 1
      let released = false
      return () => {
        if (released) return
        released = true
        const current = entries.get(target.id)
        if (!current) return
        current.refs -= 1
        if (current.refs > 0) return
        current.socket.stop()
        entries.delete(target.id)
      }
    },
    connection(id: string): Connection {
      return entries.get(id)?.connection ?? 'reconnecting'
    },
    subscribe(id: string, listener: () => void): () => void {
      const set = listeners.get(id) ?? new Set()
      set.add(listener)
      listeners.set(id, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(id)
      }
    },
    restart(id: string): void {
      entries.get(id)?.socket.restart()
    },
    reconnectNow(id: string): void {
      entries.get(id)?.socket.reconnectNow()
    },
    size(): number {
      return entries.size
    }
  }
}

export const liveStore = createLiveStore()
