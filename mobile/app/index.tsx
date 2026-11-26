import { Redirect } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Text, View } from 'react-native'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'
import { useTheme } from '@/theme/useTheme'

export default function Index() {
  const theme = useTheme()
  const [servers, setServers] = useState<PairedServer[] | null>(null)

  useEffect(() => {
    listServers().then(setServers)
    return onServersChanged(setServers)
  }, [])

  if (servers && servers.length === 0) return <Redirect href="/pair" />

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.background }}>
      <Image source={require('../assets/icon.png')} style={{ width: 96, height: 96, borderRadius: 22 }} />
      <Text style={{ marginTop: 16, fontSize: 24, fontWeight: '600', color: theme.foreground }}>Yardbell</Text>
      {servers === null && <ActivityIndicator style={{ marginTop: 24 }} color={theme.mutedForeground} />}
    </View>
  )
}
