import { useQuery } from '@tanstack/react-query'
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { ExternalLink } from 'lucide-react-native'
import { Linking } from 'react-native'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { useServers } from '@/settings/useServers'
import type { PairedServer } from '@/servers/store'
import { stateQuery } from '@/state/useServerState'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { SectionHeader } from '@/ui/SectionHeader'
import { colors, useColorScheme } from '@/ui/theme'

const REPOSITORY = 'https://github.com/hbasheer/yardbell'

function ServerVersionRow({ server }: { server: PairedServer }) {
  const { data, isError } = useQuery(stateQuery(server))
  return <ListRow title={server.machine} value={data?.server?.version || (isError ? 'Unreachable' : '...')} />
}

export default function About() {
  useColorScheme()
  const router = useRouter()
  const servers = useServers() ?? []
  return (
    <SettingsScreen title="About">
      <ListGroup>
        <ListRow key="app" title="Yardbell app" value={Constants.expoConfig?.version ?? ''} />
      </ListGroup>
      {servers.length > 0 ? (
        <>
          <SectionHeader title="Servers" />
          <ListGroup>
            {servers.map((server) => (
              <ServerVersionRow key={server.id} server={server} />
            ))}
          </ListGroup>
        </>
      ) : null}
      <SectionHeader title="Links" />
      <ListGroup>
        <ListRow
          key="source"
          title="Source code"
          accessory={<ExternalLink size={15} color={colors.textMuted} strokeWidth={2.2} />}
          onPress={() => Linking.openURL(REPOSITORY).catch((error) => console.error('Could not open the link', error))}
        />
        <ListRow key="licences" title="Licences" navigates onPress={() => router.push('/licences')} />
      </ListGroup>
    </SettingsScreen>
  )
}
