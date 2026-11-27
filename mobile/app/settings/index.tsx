import { useRouter } from 'expo-router'
import { Bell, FileText, Info, Server, SunMoon, Terminal } from 'lucide-react-native'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { colors, useColorScheme } from '@/ui/theme'

export default function Settings() {
  useColorScheme()
  const router = useRouter()
  const icon = (Icon: typeof Server) => <Icon size={18} color={colors.textSecondary} strokeWidth={2} />
  return (
    <SettingsScreen title="Settings">
      <ListGroup>
        <ListRow key="servers" title="Servers" leading={icon(Server)} navigates onPress={() => router.push('/settings/servers')} />
        <ListRow key="appearance" title="Appearance" leading={icon(SunMoon)} navigates onPress={() => router.push('/settings/appearance')} />
        <ListRow key="terminal" title="Terminal" leading={icon(Terminal)} navigates onPress={() => router.push('/settings/terminal')} />
        <ListRow key="notifications" title="Notifications" leading={icon(Bell)} navigates onPress={() => router.push('/settings/notifications')} />
        <ListRow key="about" title="About" leading={icon(Info)} navigates onPress={() => router.push('/settings/about')} />
      </ListGroup>
      <ListGroup style={{ marginTop: 24 }}>
        <ListRow key="licences" title="Licences" leading={icon(FileText)} navigates onPress={() => router.push('/licences')} />
      </ListGroup>
    </SettingsScreen>
  )
}
