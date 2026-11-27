import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'
import type { Connection } from './liveSocket'
import { liveStore } from './liveStore'
import type { StateView } from './types'

export const stateKey = (serverId: string) => ['state', serverId] as const

export function stateQuery(server: PairedServer) {
  return {
    queryKey: stateKey(server.id),
    queryFn: () => new ApiClient(server).get<StateView>('/state'),
    meta: { serverId: server.id }
  }
}

export function useServerState(server: PairedServer): {
  state: StateView | undefined
  connection: Connection
  reconnect: () => void
} {
  const queryClient = useQueryClient()
  const query = useQuery(stateQuery(server))
  const { id, address, token } = server

  useEffect(() => {
    const release = liveStore.acquire({ id, address, token }, () => {
      queryClient.refetchQueries({ queryKey: stateKey(id) }).catch(() => {})
    })
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') liveStore.reconnectNow(id)
    })
    return () => {
      subscription.remove()
      release()
    }
  }, [id, address, token, queryClient])

  const connection = useSyncExternalStore(
    useCallback((listener) => liveStore.subscribe(id, listener), [id]),
    () => liveStore.connection(id)
  )

  const reconnect = useCallback(() => {
    liveStore.restart(id)
    queryClient.refetchQueries({ queryKey: stateKey(id) }).catch(() => {})
  }, [queryClient, id])

  return { state: query.data, connection, reconnect }
}
