import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { routeIfSignedOut } from '../api/signedOut'
import type { Notice } from '../changes/useChangesActions'
import type { PairedServer } from '../servers/store'
import { briefRuns, listPipelines, pipelineRuns } from './api'
import { LIST_POLL_MS, runPollMs } from './screenModel'
import { createTaskRunner, errorText } from './taskRunner'

export const pipelinesKey = (serverId: string) => ['pipelines', serverId] as const
export const listKey = (serverId: string) => [...pipelinesKey(serverId), 'list'] as const
export const briefKey = (serverId: string) => [...pipelinesKey(serverId), 'brief'] as const
export const runsKey = (serverId: string, pipeline: string) => [...pipelinesKey(serverId), 'runs', pipeline] as const
export const runKey = (serverId: string, run: string) => [...pipelinesKey(serverId), 'run', run] as const

export class RunGoneError extends Error {
  constructor() {
    super('This run is not on the server any more. It may have been deleted.')
    this.name = 'RunGoneError'
  }
}

const common = (serverId: string) => ({ refetchOnWindowFocus: false, retry: 1, meta: { serverId } })

export function usePipelineList(server: PairedServer, poll: boolean) {
  return useQuery({
    queryKey: listKey(server.id),
    queryFn: () => listPipelines(server),
    refetchInterval: poll ? LIST_POLL_MS : false,
    ...common(server.id)
  })
}

export function useBriefRuns(server: PairedServer, poll: boolean) {
  return useQuery({
    queryKey: briefKey(server.id),
    queryFn: async () => (await briefRuns(server)).runs,
    refetchInterval: poll ? LIST_POLL_MS : false,
    ...common(server.id)
  })
}

export function usePipelineRuns(server: PairedServer, pipeline: string, poll: boolean) {
  return useQuery({
    queryKey: runsKey(server.id, pipeline),
    queryFn: async () => (await pipelineRuns(server, pipeline)).runs,
    refetchInterval: poll ? LIST_POLL_MS : false,
    ...common(server.id)
  })
}

export function useRun(server: PairedServer, runId: string, pipelineHint: string, poll: boolean) {
  const pipelineOf = useRef(pipelineHint)
  return useQuery({
    queryKey: runKey(server.id, runId),
    queryFn: async () => {
      if (!pipelineOf.current) {
        const found = (await briefRuns(server)).runs.find((r) => r.id === runId)
        if (!found) throw new RunGoneError()
        pipelineOf.current = found.pipeline
      }
      const run = (await pipelineRuns(server, pipelineOf.current)).runs.find((r) => r.id === runId)
      if (!run) throw new RunGoneError()
      return run
    },
    refetchInterval: (query) => (poll && !(query.state.error instanceof RunGoneError) ? runPollMs(query.state.data) : false),
    ...common(server.id)
  })
}

export function useRefetchOnChange(value: unknown, refetch: () => unknown) {
  const seen = useRef(value)
  const latest = useRef(refetch)
  latest.current = refetch
  useEffect(() => {
    if (seen.current === value) return
    seen.current = value
    latest.current()
  }, [value])
}

export function useRefetchWhenResumed(poll: boolean, refetch: () => unknown) {
  const was = useRef(poll)
  const latest = useRef(refetch)
  latest.current = refetch
  useEffect(() => {
    if (poll && !was.current) latest.current()
    was.current = poll
  }, [poll])
}

export function useGuardedTask(serverId: string, keys: QueryKey[]) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const keysRef = useRef(keys)
  keysRef.current = keys
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const [run] = useState(() =>
    createTaskRunner(() => ({
      start: (name) => {
        setBusy(name)
        setNotice(null)
      },
      before: () => Promise.all(keysRef.current.map((queryKey) => queryClient.cancelQueries({ queryKey }))),
      fail: (error) => {
        if (routeIfSignedOut(error, serverId)) return
        if (mounted.current) setNotice({ kind: 'error', text: errorText(error) })
      },
      end: () => {
        if (mounted.current) setBusy(null)
        for (const queryKey of keysRef.current) queryClient.refetchQueries({ queryKey }).catch(() => {})
      }
    }))
  )

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  return { busy, notice, setNotice, run }
}
