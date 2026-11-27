import { Bell } from 'lucide-react-native'
import { useCallback, useEffect, useState } from 'react'
import { AppState, Linking, PermissionsAndroid, Platform } from 'react-native'
import { SettingsFooter, SettingsScreen } from '@/settings/SettingsScreen'
import { useServers } from '@/settings/useServers'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { SectionHeader } from '@/ui/SectionHeader'
import { colors, useColorScheme } from '@/ui/theme'

type Allowed = 'yes' | 'no' | 'unknown'

async function readPermission(): Promise<Allowed> {
  if (Platform.OS !== 'android') return 'unknown'
  if (Platform.Version < 33) return 'yes'
  return (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) ? 'yes' : 'no'
}

export default function Notifications() {
  useColorScheme()
  const servers = useServers() ?? []
  const [allowed, setAllowed] = useState<Allowed>('unknown')

  const refresh = useCallback(() => {
    readPermission()
      .then(setAllowed)
      .catch((error) => console.error('Could not read the notification permission', error))
  }, [])

  useEffect(() => {
    refresh()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => subscription.remove()
  }, [refresh])

  return (
    <SettingsScreen title="Notifications">
      <ListGroup>
        <ListRow
          key="system"
          title="Phone notification settings"
          subtitle={allowed === 'no' ? 'Notifications are off for Yardbell' : allowed === 'yes' ? 'Notifications are on' : undefined}
          leading={<Bell size={18} color={colors.textSecondary} strokeWidth={2} />}
          navigates
          onPress={() => Linking.openSettings()}
        />
      </ListGroup>
      <SettingsFooter>
        Yardbell tells you when an agent needs you. A small ongoing notification shows while it watches your servers.
      </SettingsFooter>
      <SectionHeader title="Watching" />
      <ListGroup>
        {servers.map((server) => (
          <ListRow key={server.id} title={server.machine} subtitle={server.address} subtitleMono subtitleLines={1} />
        ))}
      </ListGroup>
      <SettingsFooter>
        {servers.length === 0
          ? 'Pair a server to get notifications.'
          : 'Every paired server is watched. Forget a server in Settings > Servers to stop its notifications. Turning individual servers off and test notifications are not available yet.'}
      </SettingsFooter>
    </SettingsScreen>
  )
}
