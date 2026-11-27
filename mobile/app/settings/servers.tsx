import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { SettingsFooter, SettingsScreen } from '@/settings/SettingsScreen'
import { useServers } from '@/settings/useServers'
import type { PairedServer } from '@/servers/store'
import { stateQuery } from '@/state/useServerState'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { colors, useColorScheme } from '@/ui/theme'

function ServerListRow({ server }: { server: PairedServer }) {
  const router = useRouter()
  const { data } = useQuery(stateQuery(server))
  const version = data?.server?.version
  return (
    <ListRow
      title={server.machine}
      subtitle={version ? `${server.address} · ${version}` : server.address}
      subtitleMono
      subtitleLines={1}
      navigates
      onPress={() => router.push({ pathname: '/settings/server', params: { id: server.id } })}
    />
  )
}

export default function Servers() {
  useColorScheme()
  const router = useRouter()
  const servers = useServers() ?? []
  return (
    <SettingsScreen title="Servers">
      <ListGroup>
        {servers.map((server) => (
          <ServerListRow key={server.id} server={server} />
        ))}
        <ListRow
          key="pair"
          title="Pair a server"
          leading={<Plus size={18} color={colors.accentBlue} strokeWidth={2.2} />}
          accent
          onPress={() => router.push('/pair')}
        />
      </ListGroup>
      {servers.length === 0 ? <SettingsFooter>No servers are paired with this phone.</SettingsFooter> : null}
    </SettingsScreen>
  )
}
