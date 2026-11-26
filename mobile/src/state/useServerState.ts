import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'
import { openLiveSocket, type Connection } from './liveSocket'
import type { StateView } from './types'

export const stateKey = (serverId: string) => ['state', serverId] as const

export function stateQuery(server: PairedServer) {
  return {
    queryKey: stateKey(server.id),
    queryFn: () => new ApiClient(server).get<StateView>('/state'),
    meta: { serverId: server.id }
  }
}

export function useServerState(server: PairedServer): { state: StateView | undefined; connection: Connection } {
  const queryClient = useQueryClient()
  const [connection, setConnection] = useState<Connection>('reconnecting')
  const query = useQuery(stateQuery(server))

  useEffect(() => {
    const live = openLiveSocket(
      { address: server.address, token: server.token },
      {
        onChange: () => {
          queryClient.refetchQueries({ queryKey: stateKey(server.id) }).catch(() => {})
        },
        onConnection: setConnection
      }
    )
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') live.reconnectNow()
    })
    return () => {
      subscription.remove()
      live.stop()
    }
  }, [server.id, server.address, server.token, queryClient])

  return { state: query.data, connection }
}
