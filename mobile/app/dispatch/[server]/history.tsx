import { useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { PromptHistoryScreen } from '@/dispatch/prompts/PromptHistoryScreen'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { useServers } from '@/settings/useServers'
import { colors } from '@/ui/theme'

export default function PromptHistoryRoute() {
  const { server: serverId, name } = useLocalSearchParams<{ server?: string; name?: string }>()
  const servers = useServers()
  const server = servers?.find((s) => s.id === serverId)
  if (servers === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgBase }}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (!server || !name) return <SettingsScreen title="Prompt history">{null}</SettingsScreen>
  return <PromptHistoryScreen server={server} name={name} serverCount={servers.length} />
}
