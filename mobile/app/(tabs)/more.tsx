import { useQuery } from '@tanstack/react-query'
import Constants from 'expo-constants'
import { Link } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { forgetServer, listServers, onServersChanged, type PairedServer } from '@/servers/store'
import { stateQuery } from '@/state/useServerState'
import { useTheme } from '@/theme/useTheme'

function Heading({ children }: { children: string }) {
  const theme = useTheme()
  return (
    <Text style={{ color: theme.mutedForeground, fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
      {children.toUpperCase()}
    </Text>
  )
}

function ServerRow({ server }: { server: PairedServer }) {
  const theme = useTheme()
  const confirmForget = () =>
    Alert.alert(`Forget ${server.machine}?`, 'This phone will stop showing its sessions until you pair it again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => {
          forgetServer(server.id).catch((error) => {
            console.error('Could not forget server', error)
            Alert.alert('Could not forget the server', error instanceof Error ? error.message : String(error))
          })
        }
      }
    ])
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.foreground, fontSize: 16 }}>{server.machine}</Text>
        <Text style={{ color: theme.mutedForeground, fontSize: 13 }}>{server.address}</Text>
      </View>
      <Pressable onPress={confirmForget} hitSlop={8}>
        <Text style={{ color: theme.down, fontSize: 15 }}>Forget</Text>
      </Pressable>
    </View>
  )
}

function ServerVersion({ server }: { server: PairedServer }) {
  const theme = useTheme()
  const { data } = useQuery(stateQuery(server))
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 6 }}>
      <Text style={{ color: theme.foreground, fontSize: 15 }}>{server.machine}</Text>
      <Text style={{ color: theme.mutedForeground, fontSize: 15 }}>{data?.server?.version || '...'}</Text>
    </View>
  )
}

export default function More() {
  const theme = useTheme()
  const [servers, setServers] = useState<PairedServer[]>([])

  useEffect(() => {
    listServers()
      .then(setServers)
      .catch((error) => console.error('Could not read saved servers', error))
    return onServersChanged(setServers)
  }, [])

  const linkStyle = { color: theme.foreground, fontSize: 16, paddingHorizontal: 16, paddingVertical: 12 }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ paddingBottom: 32 }}>
      <Heading>Servers</Heading>
      {servers.map((server) => (
        <ServerRow key={server.id} server={server} />
      ))}
      <Link href="/pair" style={linkStyle}>
        Pair another server
      </Link>
      <Heading>About</Heading>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 6 }}>
        <Text style={{ color: theme.foreground, fontSize: 15 }}>Yardbell app</Text>
        <Text style={{ color: theme.mutedForeground, fontSize: 15 }}>{Constants.expoConfig?.version ?? ''}</Text>
      </View>
      {servers.map((server) => (
        <ServerVersion key={server.id} server={server} />
      ))}
      <Link href="/licences" style={linkStyle}>
        Licences
      </Link>
    </ScrollView>
  )
}
