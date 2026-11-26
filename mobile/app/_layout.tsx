import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { routeIfSignedOut } from '@/api/signedOut'
import { listServers, onServersChanged } from '@/servers/store'

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      routeIfSignedOut(error, query.meta?.serverId as string | undefined)
    }
  })
})

const PUBLIC_ROUTES = ['pair', 'sign-in', 'signed-out']

function useRouteGuard() {
  const router = useRouter()
  const segments = useSegments()
  const [hasServers, setHasServers] = useState<boolean | null>(null)

  useEffect(() => {
    listServers().then((servers) => setHasServers(servers.length > 0))
    return onServersChanged((servers) => setHasServers(servers.length > 0))
  }, [])

  const first = segments[0] as string | undefined
  useEffect(() => {
    if (hasServers === false && !PUBLIC_ROUTES.includes(first ?? '')) router.replace('/pair')
  }, [hasServers, first, router])
}

export default function RootLayout() {
  useRouteGuard()
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </QueryClientProvider>
  )
}
