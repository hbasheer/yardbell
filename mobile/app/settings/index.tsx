import { useRouter } from 'expo-router'
import { Bell, FileText, Info, Server, SunMoon, Terminal, Volume2 } from 'lucide-react-native'
import { Switch } from 'react-native'
import { useSpeakReplies } from '@/dispatch/voice/speakPrefs'
import { SettingsFooter, SettingsScreen } from '@/settings/SettingsScreen'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { SectionHeader } from '@/ui/SectionHeader'
import { colors, useColorScheme } from '@/ui/theme'

export default function Settings() {
  useColorScheme()
  const router = useRouter()
  const [speak, setSpeak] = useSpeakReplies()
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
      <SectionHeader title="Dispatch" />
      <ListGroup>
        <ListRow
          key="speak"
          title="Speak replies"
          leading={icon(Volume2)}
          accessibilityRole="switch"
          checked={speak}
          accessory={<Switch value={speak} onValueChange={setSpeak} trackColor={{ true: colors.accentBlue }} accessibilityLabel="Speak replies" />}
          onPress={() => setSpeak(!speak)}
        />
      </ListGroup>
      <SettingsFooter>Dispatch reads its new replies, errors and waiting sessions aloud while a chat is open. Kept on this phone.</SettingsFooter>
      <ListGroup style={{ marginTop: 24 }}>
        <ListRow key="licences" title="Licences" leading={icon(FileText)} navigates onPress={() => router.push('/licences')} />
      </ListGroup>
    </SettingsScreen>
  )
}
