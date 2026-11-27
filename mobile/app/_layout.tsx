import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack, useRouter, useSegments } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef, useState } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SignedOutError } from '@/api/client'
import { routeIfSignedOut } from '@/api/signedOut'
import { NewSessionProvider } from '@/new-session/NewSessionProvider'
import { routeForLink } from '@/notifications/route'
import { listServers, onServersChanged } from '@/servers/store'
import '@/preview/seed'
import { startAppearance } from '@/ui/theme'
import { settleWithin } from '@/ui/theme/settleWithin'
import { addOpenListener, getInitialLink, start as startNotifications } from '../modules/yardbell-notify'

SplashScreen.preventAutoHideAsync().catch((error) => console.error('Could not hold the splash screen', error))
const SPLASH_HOLD_MS = 1500
settleWithin(startAppearance, SPLASH_HOLD_MS).then(() => {
  SplashScreen.hideAsync().catch((error) => console.error('Could not hide the splash screen', error))
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (failureCount, error) => !(error instanceof SignedOutError) && failureCount < 3 }
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      routeIfSignedOut(error, query.meta?.serverId as string | undefined)
    }
  })
})

const PUBLIC_ROUTES = ['pair', 'sign-in', 'signed-out', ...(__DEV__ ? ['_gallery'] : [])]

function useRouteGuard() {
  const router = useRouter()
  const segments = useSegments()
  const [hasServers, setHasServers] = useState<boolean | null>(null)

  useEffect(() => {
    listServers()
      .then((servers) => setHasServers(servers.length > 0))
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setHasServers(false)
      })
    return onServersChanged((servers) => setHasServers(servers.length > 0))
  }, [])

  const first = segments[0] as string | undefined
  useEffect(() => {
    if (hasServers === false && first !== undefined && !PUBLIC_ROUTES.includes(first)) router.replace('/pair')
  }, [hasServers, first, router])

  return hasServers
}

async function requestNotificationPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
}

function useNotifications(hasServers: boolean | null) {
  const router = useRouter()
  const initialHandled = useRef(false)

  useEffect(() => {
    if (!hasServers) return
    startNotifications()
    requestNotificationPermission().catch((error) => console.error('Could not ask to show notifications', error))

    const open = (link: string) => {
      listServers()
        .then((servers) => router.navigate(routeForLink(link, servers) as never))
        .catch((error) => console.error('Could not open the notification', error))
    }
    if (!initialHandled.current) {
      initialHandled.current = true
      const initial = getInitialLink()
      if (initial) open(initial)
    }
    const subscription = addOpenListener(open)
    return () => subscription.remove()
  }, [hasServers, router])
}

export default function RootLayout() {
  const hasServers = useRouteGuard()
  useNotifications(hasServers)
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <NewSessionProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </NewSessionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  )
}
