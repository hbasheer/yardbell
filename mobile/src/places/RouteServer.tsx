import { useRouter } from 'expo-router'
import { useEffect, type ReactNode } from 'react'
import { View } from 'react-native'
import type { PairedServer } from '../servers/store'
import { useServers } from '../settings/useServers'
import { colors } from '../ui/theme'

export const routeParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? ''

export function RouteServer({ id, children }: { id: string; children: (server: PairedServer, serverCount: number) => ReactNode }) {
  const servers = useServers()
  const router = useRouter()
  const server = servers?.find((s) => s.id === id)
  useEffect(() => {
    if (servers !== null && !server) router.replace('/')
  }, [servers, server, router])
  if (!server) return <View style={{ flex: 1, backgroundColor: colors.bgBase }} />
  return <>{children(server, servers?.length ?? 0)}</>
}
