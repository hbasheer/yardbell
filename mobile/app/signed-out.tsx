import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { forgetServer, listServers } from '@/servers/store'
import { useTheme } from '@/theme/useTheme'

export default function SignedOut() {
  const theme = useTheme()
  const router = useRouter()
  const { server } = useLocalSearchParams<{ server?: string }>()
  const [machine, setMachine] = useState<string | null>(null)

  useEffect(() => {
    listServers()
      .then((servers) => {
        const found = servers.find((s) => s.id === server)
        setMachine(found ? found.machine : 'this server')
        if (found) return forgetServer(found.id)
      })
      .catch((error) => {
        console.error('Could not forget the signed out server', error)
        setMachine((current) => current ?? 'this server')
      })
  }, [server])

  function pairAgain() {
    router.replace('/pair')
  }

  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: theme.background }}>
      <Text style={{ fontSize: 20, fontWeight: '600', color: theme.foreground }}>
        This phone was signed out of {machine ?? '...'}.
      </Text>
      <Pressable
        onPress={pairAgain}
        style={{ marginTop: 24, padding: 12, borderRadius: 8, backgroundColor: theme.accent }}
      >
        <Text style={{ color: theme.accentForeground, fontSize: 16, textAlign: 'center' }}>Pair again</Text>
      </Pressable>
    </View>
  )
}
