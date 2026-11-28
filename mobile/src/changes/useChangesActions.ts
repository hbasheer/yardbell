import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PairedServer } from '../servers/store'
import { UnreachableError } from '../api/client'
import { routeIfSignedOut } from '../api/signedOut'
import { createGuard } from './guard'
import { listChanges } from './api'

export const POLL_MS = 5000

export const changesKey = (serverId: string, machine: string, root: string) => ['changes', serverId, machine, root] as const

export function useChangesList(server: PairedServer, machine: string, root: string, poll: boolean) {
  return useQuery({
    queryKey: changesKey(server.id, machine, root),
    queryFn: () => listChanges(server, machine, root),
    refetchInterval: poll ? POLL_MS : false,
    refetchOnWindowFocus: false,
    retry: 1,
    meta: { serverId: server.id }
  })
}

export type Notice = { kind: 'error' | 'info'; text: string }

export function messageOf(error: unknown): string {
  if (error instanceof UnreachableError) return `${error.message} Git may still be running on the machine. Check again shortly.`
  return error instanceof Error ? error.message : String(error)
}

export function useGuardedActions(serverId: string, before: () => Promise<unknown>, afterEach: () => void) {
  const guard = useRef(createGuard()).current
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const after = useRef(afterEach)
  after.current = afterEach
  const prepare = useRef(before)
  prepare.current = before
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(
    async <T>(name: string, task: () => Promise<T>): Promise<T | undefined> => {
      if (!guard.begin(name)) return undefined
      setBusy(name)
      setNotice(null)
      try {
        await prepare.current().catch(() => {})
        return await task()
      } catch (error) {
        if (routeIfSignedOut(error, serverId)) return undefined
        if (mounted.current) setNotice({ kind: 'error', text: messageOf(error) })
        return undefined
      } finally {
        guard.end()
        if (mounted.current) setBusy(null)
        after.current()
      }
    },
    [guard, serverId]
  )

  return { busy, notice, setNotice, run }
}
