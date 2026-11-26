import { Text, View } from 'react-native'
import { useTheme } from '@/theme/useTheme'
import type { HomeSection } from '@/state/home'

export function MachineHeader({ section }: { section: HomeSection }) {
  const theme = useTheme()
  const down = section.machine && !section.machine.up
  const dot = section.kind === 'needs-you' ? theme.waiting : down ? theme.down : theme.idle
  const note = down ? (section.machine?.reason ?? 'Down') : section.server
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <Text style={{ color: theme.foreground, fontSize: 15, fontWeight: '600' }}>{section.title}</Text>
      {note ? <Text style={{ color: theme.mutedForeground, fontSize: 13, flexShrink: 1 }}>{note}</Text> : null}
    </View>
  )
}
