import { useRouter } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import type { HomeSession } from '@/state/home'
import { useTheme } from '@/theme/useTheme'

export function SessionRow({ session }: { session: HomeSession }) {
  const theme = useTheme()
  const router = useRouter()
  const dot = session.stopped || session.stale ? theme.down : session.activity === 'blocked' ? theme.waiting : session.activity === 'active' ? theme.busy : theme.idle
  const open = () => {
    if (!session.attachable || !session.tmux) return
    router.push(
      `/session/${encodeURIComponent(session.serverId)}/${encodeURIComponent(session.machine)}/${encodeURIComponent(session.tmux)}` as never
    )
  }
  const detail = [session.agent, session.branch, session.machine].filter(Boolean).join('  ·  ')
  return (
    <Pressable
      onPress={open}
      disabled={!session.attachable}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        opacity: session.attachable ? 1 : 0.55,
        backgroundColor: pressed ? theme.accent : 'transparent'
      })}
    >
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.foreground, fontSize: 16 }}>
          {session.folder || session.tmux}
        </Text>
        <Text numberOfLines={1} style={{ color: theme.mutedForeground, fontSize: 13, marginTop: 2 }}>
          {detail}
        </Text>
      </View>
    </Pressable>
  )
}
