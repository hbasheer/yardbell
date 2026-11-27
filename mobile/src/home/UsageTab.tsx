import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, RefreshCw, Settings, Sparkles } from 'lucide-react-native'
import { useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { ApiClient } from '@/api/client'
import type { PairedServer } from '@/servers/store'
import {
  isPast,
  percentOf,
  providersOf,
  resetLabel,
  tightestWindow,
  toneOf,
  type MeterTone,
  type UsageProvider,
  type UsageReply,
  type UsageWindow
} from '@/state/usage'
import type { ServerState } from '@/state/views'
import { ListGroup } from '@/ui/ListGroup'
import { LoadErrorState, OfflineState, StateView } from '@/ui/StateView'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { HeaderIconButton, HomeHeader } from './HomeHeader'
import { HomeSectionHeading } from './HomeSectionHeading'

const REFRESH_MS = 60_000
const usageKey = (serverId: string) => ['usage', serverId] as const

function toneColor(tone: MeterTone): string {
  if (tone === 'critical') return colors.statusRed
  if (tone === 'warn') return colors.statusAmber
  return colors.statusGreen
}

function Meter({ window, nowMs }: { window: UsageWindow; nowMs: number }) {
  const percent = percentOf(window, nowMs)
  const reset = resetLabel(window, nowMs)
  return (
    <View>
      <View
        style={styles.meter}
        accessible
        accessibilityLabel={[window.label, `${percent}%`, reset].filter(Boolean).join(', ')}
      >
        <Text style={styles.meterLabel} numberOfLines={1}>
          {window.short || window.label}
        </Text>
        <View style={styles.track}>
          <View style={[styles.bar, { width: `${percent}%`, backgroundColor: toneColor(toneOf(percent)) }]} />
        </View>
        <Text style={styles.meterValue}>{`${percent}%`}</Text>
      </View>
      {reset ? (
        <Text style={styles.reset} numberOfLines={1}>
          {reset}
        </Text>
      ) : null}
    </View>
  )
}

function ProviderCard({ provider, nowMs, separated }: { provider: UsageProvider; nowMs: number; separated: boolean }) {
  const tight = tightestWindow(provider.windows, nowMs)
  const percent = percentOf(tight, nowMs)
  const subtitle = isPast(tight, nowMs)
    ? 'Limits have reset'
    : `${tight.label} limit at ${percent}%`
  return (
    <View style={[styles.card, separated && styles.cardSeparated]}>
      <View style={styles.head}>
        <View style={styles.tile}>
          <Sparkles size={16} color={colors.textPrimary} strokeWidth={1.8} />
        </View>
        <View style={styles.headText}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {provider.name}
          </Text>
          <Text style={styles.cardSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>
      {provider.windows.map((window) => (
        <Meter key={window.label} window={window} nowMs={nowMs} />
      ))}
    </View>
  )
}

function ServerUsage({ entry, showName, first }: { entry: ServerState; showName: boolean; first: boolean }) {
  const { server, connection } = entry
  const query = useQuery({
    queryKey: usageKey(server.id),
    queryFn: () => new ApiClient(server).get<UsageReply>('/dispatch/usage'),
    refetchInterval: REFRESH_MS,
    meta: { serverId: server.id }
  })
  const providers = providersOf(query.data)
  const nowMs = Date.now()

  let body
  if (providers.length > 0) {
    body = (
      <ListGroup surface="page">
        {providers.map((provider, index) => (
          <ProviderCard key={provider.id} provider={provider} nowMs={nowMs} separated={index > 0} />
        ))}
      </ListGroup>
    )
  } else if (query.isPending) {
    body = <StateView loading title="Checking limits" />
  } else if (query.isError) {
    body =
      connection === 'unreachable' ? (
        <OfflineState machineName={server.machine} message={`Cannot reach ${server.address}.`} onReconnect={() => void query.refetch()} />
      ) : (
        <LoadErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      )
  } else {
    body = (
      <StateView
        icon={Gauge}
        title="No usage yet"
        message={`${server.machine} has not reported any agent limits. Sign in to Claude or Codex there.`}
      />
    )
  }

  return (
    <View>
      {showName ? <HomeSectionHeading title={server.machine} first={first} /> : null}
      {body}
    </View>
  )
}

export function UsageTab(props: { servers: ServerState[]; bottomPad: number; onOpenSettings: () => void }) {
  useColorScheme()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    if (busy) return
    setBusy(true)
    const results = await Promise.allSettled(
      props.servers.map(async ({ server }: { server: PairedServer }) => {
        const reply = await new ApiClient(server).post<UsageReply>('/dispatch/usage/refresh')
        queryClient.setQueryData(usageKey(server.id), reply)
      })
    )
    for (const result of results) if (result.status === 'rejected') console.error('Could not refresh usage', result.reason)
    setBusy(false)
  }

  return (
    <View style={styles.fill}>
      <HomeHeader title="Usage">
        <HeaderIconButton icon={RefreshCw} label="Check usage now" onPress={() => void refresh()} active={busy} />
        <HeaderIconButton icon={Settings} label="Settings" onPress={props.onOpenSettings} />
      </HomeHeader>
      <ScrollView style={styles.fill} contentContainerStyle={[styles.content, { paddingBottom: props.bottomPad }]}>
        {props.servers.map((entry, index) => (
          <ServerUsage key={entry.server.id} entry={entry} showName={props.servers.length > 1} first={index === 0} />
        ))}
      </ScrollView>
    </View>
  )
}

const METER_LABEL_WIDTH = 26
const METER_GAP = 10

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  card: { paddingVertical: 14, paddingHorizontal: spacing.lg, backgroundColor: colors.bgPanel },
  cardSeparated: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  head: { flexDirection: 'row', alignItems: 'center', gap: METER_GAP, marginBottom: 4 },
  tile: {
    width: 28,
    height: 28,
    borderRadius: radii.tile,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headText: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, lineHeight: 22, color: colors.textPrimary },
  cardSubtitle: { fontSize: 13, lineHeight: 17, color: colors.textSecondary, marginTop: 1 },
  meter: { flexDirection: 'row', alignItems: 'center', gap: METER_GAP, marginTop: 6 },
  meterLabel: { width: METER_LABEL_WIDTH, fontSize: 13, color: colors.textSecondary },
  track: { flex: 1, height: 6, borderRadius: radii.pill, backgroundColor: colors.translucentFill, overflow: 'hidden' },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radii.pill },
  meterValue: { minWidth: 40, fontSize: 13, color: colors.textPrimary, textAlign: 'right', fontVariant: ['tabular-nums'] },
  reset: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginLeft: METER_LABEL_WIDTH + METER_GAP }
}))
