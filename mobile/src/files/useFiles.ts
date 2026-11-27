import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { PairedServer } from '../servers/store'
import { listChanges } from '../changes/api'
import { readFile, searchFiles, type SearchMode } from './api'
import { changeStatuses, searchDelay } from './model'

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

export function useChangeStatuses(server: PairedServer, machine: string, root: string) {
  const query = useQuery({
    queryKey: ['files-statuses', server.id, machine, root],
    queryFn: async () => changeStatuses((await listChanges(server, machine, root)).files),
    retry: false,
    refetchOnWindowFocus: false,
    meta: { serverId: server.id }
  })
  return { statuses: query.data, refetch: query.refetch }
}

export function useFileSearch(server: PairedServer, machine: string, root: string, text: string, mode: SearchMode) {
  const trimmed = text.trim()
  const settled = useDebounced(trimmed, searchDelay(mode))
  const query = useQuery({
    queryKey: ['files-search', server.id, machine, root, mode, settled],
    queryFn: () => searchFiles(server, machine, root, settled, mode),
    enabled: settled !== '',
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    meta: { serverId: server.id }
  })
  const waiting = trimmed !== '' && (trimmed !== settled || query.isFetching)
  return { settled, result: trimmed === '' ? undefined : query.data, error: trimmed === '' || trimmed !== settled ? null : query.error, waiting }
}

export function useFileText(server: PairedServer, machine: string, root: string, path: string) {
  return useQuery({
    queryKey: ['file-text', server.id, machine, root, path],
    queryFn: () => readFile(server, machine, root, path),
    retry: false,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    meta: { serverId: server.id }
  })
}
