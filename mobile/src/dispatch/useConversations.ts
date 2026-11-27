import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { routeIfSignedOut } from '@/api/signedOut'
import { useAppActive } from '@/ui/useAppActive'
import type { PairedServer } from '@/servers/store'
import { listConversations } from './api'
import type { ConversationRow } from './listModel'
import { sortRows } from './listModel'

export const REFRESH_MS = 5000

type Loaded = { rows: ConversationRow[]; error: string | null }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function useConversations(servers: readonly PairedServer[], active: boolean, waitingKey: string) {
  const foreground = useAppActive()
  const polling = active && foreground
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const inFlight = useRef(false)
  const serversRef = useRef(servers)
  serversRef.current = servers

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const results = await Promise.all(
        serversRef.current.map(async (server): Promise<[string, Loaded | null]> => {
          try {
            const list = await listConversations(server)
            return [server.id, { rows: list.map((chat) => ({ ...chat, serverId: server.id, machine: server.machine })), error: null }]
          } catch (error) {
            if (routeIfSignedOut(error, server.id)) return [server.id, null]
            return [server.id, { rows: [], error: messageOf(error) }]
          }
        })
      )
      setLoaded((previous) => {
        const next = { ...previous }
        for (const [id, result] of results) {
          if (!result) continue
          next[id] = result.error ? { rows: previous[id]?.rows ?? [], error: result.error } : result
        }
        return next
      })
    } finally {
      inFlight.current = false
    }
  }, [])

  const serverKey = servers.map((server) => server.id).join(',')
  useEffect(() => {
    if (!polling) return
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [polling, refresh, serverKey])

  const firstWaiting = useRef(true)
  useEffect(() => {
    if (firstWaiting.current) {
      firstWaiting.current = false
      return
    }
    if (active) void refresh()
  }, [waitingKey, active, refresh])

  const rows = useMemo(
    () => sortRows(servers.flatMap((server) => loaded[server.id]?.rows ?? [])),
    [servers, loaded]
  )
  const ready = servers.length > 0 && servers.every((server) => loaded[server.id] !== undefined)
  const errors = servers.flatMap((server) => {
    const error = loaded[server.id]?.error
    return error ? [{ serverId: server.id, machine: server.machine, message: error }] : []
  })
  return { rows, ready, errors, refresh }
}
