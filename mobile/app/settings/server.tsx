import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useState } from 'react'
import { SettingsFooter, SettingsScreen } from '@/settings/SettingsScreen'
import { useServers } from '@/settings/useServers'
import { forgetServer, listServers, type PairedServer } from '@/servers/store'
import { stateQuery } from '@/state/useServerState'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { colors, useColorScheme } from '@/ui/theme'

function ServerDetails({ server }: { server: PairedServer }) {
  useColorScheme()
  const router = useRouter()
  const { data, isError } = useQuery(stateQuery(server))
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const forget = () => {
    setConfirming(false)
    forgetServer(server.id)
      .then(listServers)
      .then((remaining) => (remaining.length === 0 ? router.replace('/pair') : router.back()))
      .catch((error) => {
        console.error('Could not forget server', error)
        setFailure(error instanceof Error ? error.message : String(error))
      })
  }

  return (
    <SettingsScreen title={server.machine}>
      <ListGroup>
        <ListRow key="address" title="Address" value={server.address} />
        <ListRow key="version" title="Version" value={data?.server?.version || (isError ? 'Unreachable' : '...')} />
        <ListRow key="machines" title="Machines" value={data ? String(data.machines.length) : '...'} />
      </ListGroup>
      <ListGroup style={{ marginTop: 24 }}>
        <ListRow
          key="pair"
          title="Pair another server"
          leading={<Plus size={18} color={colors.accentBlue} strokeWidth={2.2} />}
          accent
          onPress={() => router.push('/pair')}
        />
        <ListRow key="forget" title="Forget this server" destructive onPress={() => setConfirming(true)} />
      </ListGroup>
      {failure ? <SettingsFooter>{`Could not forget the server: ${failure}`}</SettingsFooter> : null}
      <ConfirmModal
        visible={confirming}
        title={`Forget ${server.machine}?`}
        message="This phone will stop showing its sessions until you pair it again."
        confirmLabel="Forget"
        destructive
        onConfirm={forget}
        onCancel={() => setConfirming(false)}
      />
    </SettingsScreen>
  )
}

export default function ServerPage() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const servers = useServers()
  const server = servers?.find((s) => s.id === id)
  if (!server) return <SettingsScreen title="Server">{null}</SettingsScreen>
  return <ServerDetails server={server} />
}
