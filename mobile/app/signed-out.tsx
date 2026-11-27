import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { CenteredMessage, PairFrame } from '@/pairing/PairFrame'
import { forgetServer, listServers } from '@/servers/store'
import { ActionButton } from '@/ui/ActionButton'
import { spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export default function SignedOut() {
  useColorScheme()
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

  return (
    <PairFrame back={false}>
      <CenteredMessage
        title={`Signed out of ${machine ?? '...'}`}
        message="This phone no longer has access. Pair it again to see its sessions."
      >
        <View style={styles.actions}>
          <ActionButton label="Pair again" fullWidth onPress={() => router.replace('/pair')} />
        </View>
      </CenteredMessage>
    </PairFrame>
  )
}

const styles = themedStyleSheet(() => ({
  actions: { alignSelf: 'stretch', alignItems: 'center', maxWidth: 360, marginTop: spacing.lg }
}))
