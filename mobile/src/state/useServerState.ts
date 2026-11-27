import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'
import { openLiveSocket, type Connection, type LiveSocket } from './liveSocket'
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
  const socketRef = useRef<LiveSocket | null>(null)
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
    socketRef.current = live
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') live.reconnectNow()
    })
    return () => {
      subscription.remove()
      live.stop()
      socketRef.current = null
    }
  }, [server.id, server.address, server.token, queryClient])

  const reconnect = useCallback(() => {
    socketRef.current?.restart()
    queryClient.refetchQueries({ queryKey: stateKey(server.id) }).catch(() => {})
  }, [queryClient, server.id])

  return { state: query.data, connection, reconnect }
}
