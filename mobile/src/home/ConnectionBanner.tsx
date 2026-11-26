import { Text, View } from 'react-native'
import type { Connection } from '@/state/liveSocket'
import { useTheme } from '@/theme/useTheme'

export function ConnectionBanner({ server, connection }: { server: string; connection: Connection }) {
  const theme = useTheme()
  if (connection === 'connected') return null
  const unreachable = connection === 'unreachable'
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginTop: 8,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.muted,
        borderLeftWidth: 3,
        borderLeftColor: unreachable ? theme.down : theme.busy
      }}
    >
      <Text style={{ color: theme.foreground, fontSize: 14 }}>
        {unreachable ? `Can't reach ${server}. Is Meshnet on?` : `Reconnecting to ${server}...`}
      </Text>
    </View>
  )
}
