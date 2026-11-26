import { Redirect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, Text, View } from 'react-native'
import { ConnectionBanner } from '@/home/ConnectionBanner'
import { MachineHeader } from '@/home/MachineHeader'
import { SessionRow } from '@/home/SessionRow'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'
import { homeSections } from '@/state/home'
import type { Connection } from '@/state/liveSocket'
import type { StateView } from '@/state/types'
import { useServerState } from '@/state/useServerState'
import { useTheme } from '@/theme/useTheme'

type Live = { state: StateView | undefined; connection: Connection }

function ServerFeed({ server, onChange }: { server: PairedServer; onChange: (id: string, live: Live) => void }) {
  const { state, connection } = useServerState(server)
  useEffect(() => {
    onChange(server.id, { state, connection })
  }, [server.id, state, connection, onChange])
  return null
}

export default function Home() {
  const theme = useTheme()
  const [servers, setServers] = useState<PairedServer[] | null>(null)
  const [live, setLive] = useState<Record<string, Live>>({})

  useEffect(() => {
    listServers()
      .then(setServers)
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setServers([])
      })
    return onServersChanged(setServers)
  }, [])

  const report = useCallback((id: string, next: Live) => setLive((prev) => ({ ...prev, [id]: next })), [])

  const sections = useMemo(() => {
    const loaded = (servers ?? []).flatMap((server) => {
      const state = live[server.id]?.state
      return state ? [{ server, state }] : []
    })
    return homeSections(loaded)
  }, [servers, live])

  if (servers && servers.length === 0) return <Redirect href="/pair" />
  if (servers === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.background }}>
        <ActivityIndicator color={theme.mutedForeground} />
      </View>
    )
  }

  const serverFor = (machine: string) =>
    servers.find((s) => live[s.id]?.state?.machines.some((m) => m.name === machine)) ?? servers[0]
  const loadedAny = servers.some((s) => live[s.id]?.state)

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ paddingBottom: 32 }}>
      {servers.map((server) => (
        <ServerFeed key={server.id} server={server} onChange={report} />
      ))}
      {servers.map((server) => (
        <ConnectionBanner key={server.id} server={server.machine} connection={live[server.id]?.connection ?? 'reconnecting'} />
      ))}
      {!loadedAny && <ActivityIndicator style={{ marginTop: 32 }} color={theme.mutedForeground} />}
      {sections.map((section) => (
        <View key={`${section.kind}:${section.server ?? ''}:${section.title}`}>
          <MachineHeader section={section} />
          {section.sessions.length === 0 ? (
            <Text style={{ color: theme.mutedForeground, paddingHorizontal: 16, paddingVertical: 8, fontSize: 14 }}>
              No sessions
            </Text>
          ) : (
            section.sessions.map((session) => (
              <SessionRow
                key={`${session.machine}:${session.id}`}
                server={serverFor(session.machine)}
                session={session}
              />
            ))
          )}
        </View>
      ))}
    </ScrollView>
  )
}
