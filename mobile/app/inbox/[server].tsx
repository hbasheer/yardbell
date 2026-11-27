import { useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { InboxScreen } from '@/inbox/InboxScreen'
import { useServers } from '@/settings/useServers'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { colors } from '@/ui/theme'

export default function InboxRoute() {
  const { server: id } = useLocalSearchParams<{ server?: string }>()
  const servers = useServers()
  const server = servers?.find((s) => s.id === id)
  if (servers === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgBase }}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (!server) return <SettingsScreen title="Inbox">{null}</SettingsScreen>
  return <InboxScreen server={server} serverCount={servers.length} />
}
