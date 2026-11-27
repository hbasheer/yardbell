import { useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { ChatScreen } from '@/dispatch/ChatScreen'
import { useServers } from '@/settings/useServers'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { colors } from '@/ui/theme'

export default function ChatRoute() {
  const { server: serverId, id, run, ask } = useLocalSearchParams<{ server?: string; id?: string; run?: string; ask?: string }>()
  const servers = useServers()
  const server = servers?.find((s) => s.id === serverId)
  if (servers === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgBase }}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (!server || !id) return <SettingsScreen title="Chat">{null}</SettingsScreen>
  return <ChatScreen server={server} routeId={id} run={run} ask={ask} serverCount={servers.length} />
}
