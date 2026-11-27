import { useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { PromptsScreen } from '@/dispatch/prompts/PromptsScreen'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { useServers } from '@/settings/useServers'
import { colors } from '@/ui/theme'

export default function PromptsRoute() {
  const { server: serverId } = useLocalSearchParams<{ server?: string }>()
  const servers = useServers()
  const server = servers?.find((s) => s.id === serverId)
  if (servers === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgBase }}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (!server) return <SettingsScreen title="Saved prompts">{null}</SettingsScreen>
  return <PromptsScreen server={server} serverCount={servers.length} />
}
