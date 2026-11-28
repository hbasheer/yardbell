import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { ChevronDown, ChevronLeft, History, RotateCcw } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { routeIfSignedOut } from '@/api/signedOut'
import type { PairedServer } from '@/servers/store'
import { ActionButton } from '@/ui/ActionButton'
import { ActionSheet } from '@/ui/ActionSheet'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { NavBar, NavBarSubtitleText } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { LoadErrorState, StateView } from '@/ui/StateView'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '@/ui/theme'
import { listPrompts, promptDiff, promptHistory, restorePromptVersion } from '../api'
import type { PromptDiff, PromptHistory } from '../types'
import {
  countLine,
  defaultCompare,
  HISTORY_HELP,
  newestFirst,
  restoreConfirm,
  restoredMessage,
  sameVersions,
  versionLabel,
  versionNote,
  whenWord
} from './history'
import { WordDiff } from './WordDiff'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Picking = 'from' | 'to' | null

export function PromptHistoryScreen({ server, name, serverCount }: { server: PairedServer; name: string; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const queryClient = useQueryClient()
  const promptsKey = ['dispatch', 'prompts', server.id]
  const query = useQuery({ queryKey: ['dispatch', 'prompt-history', server.id, name], queryFn: () => promptHistory(server, name), meta: { serverId: server.id } })
  const history = query.data
  const prompts = useQuery({ queryKey: promptsKey, queryFn: () => listPrompts(server), meta: { serverId: server.id } })
  const customised = Boolean(prompts.data?.find((prompt) => prompt.name === name)?.customised)
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [diff, setDiff] = useState<{ key: string; parts: PromptDiff['parts'] } | { key: string; error: string } | null>(null)
  const [picking, setPicking] = useState<Picking>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)
  const working = useRef(false)

  useEffect(() => {
    if (history && !range) setRange(defaultCompare(history))
  }, [history, range])

  const rangeKey = range ? `${range.from}-${range.to}-${history?.current}` : ''
  const comparing = history && history.versions.length > 1 && range
  useEffect(() => {
    if (!comparing || !range) return
    let live = true
    promptDiff(server, name, range.from, range.to).then(
      (out) => live && setDiff({ key: rangeKey, parts: out.parts }),
      (error) => live && setDiff({ key: rangeKey, error: messageOf(error) })
    )
    return () => {
      live = false
    }
  }, [server, name, rangeKey, comparing, range])

  const adopt = (next: PromptHistory) => queryClient.setQueryData(['dispatch', 'prompt-history', server.id, name], next)

  const restore = async () => {
    const version = confirming
    setConfirming(null)
    if (version === null || !history || working.current) return
    working.current = true
    setBusy(true)
    setNotice(null)
    try {
      const out = await restorePromptVersion(server, name, version)
      queryClient.setQueryData(promptsKey, out.tasks)
      adopt(out.history)
      setRange(defaultCompare(out.history))
      setNotice({ tone: 'info', text: restoredMessage(name, version, history.builtin, out.history.current) })
    } catch (error) {
      if (!routeIfSignedOut(error, server.id)) setNotice({ tone: 'error', text: messageOf(error) })
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  let body
  if (query.isPending) body = <StateView loading title="Loading the history" />
  else if (!history) body = <LoadErrorState message={messageOf(query.error)} onRetry={() => void query.refetch()} />
  else {
    const confirm = confirming === null ? null : restoreConfirm(name, confirming, history.builtin)
    const current = diff && diff.key === rangeKey ? diff : null
    body = (
      <>
        <ScrollView style={styles.fill} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
          <Text style={styles.help}>{HISTORY_HELP}</Text>
          {comparing ? (
            <View style={styles.compare}>
              <View style={styles.picks}>
                <PickRow label="Compare" value={range.from} current={history.current} onPress={() => setPicking('from')} />
                <PickRow label="with" value={range.to} current={history.current} onPress={() => setPicking('to')} />
              </View>
              {!current ? (
                <Text style={styles.help}>Comparing…</Text>
              ) : 'error' in current ? (
                <Text style={styles.error}>{current.error}</Text>
              ) : sameVersions(current.parts) ? (
                <Text style={styles.help}>These two versions are the same.</Text>
              ) : (
                <WordDiff parts={current.parts} />
              )}
            </View>
          ) : null}
          {notice ? (
            <Text style={notice.tone === 'error' ? styles.error : styles.info} accessibilityRole="alert">
              {notice.text}
            </Text>
          ) : null}
          <View style={styles.list}>
            {newestFirst(history).map((version, at) => {
              const isCurrent = version.n === history.current
              const note = versionNote(version, history.builtin)
              return (
                <View key={version.n} style={[styles.version, at > 0 && styles.versionLine]}>
                  <View style={styles.versionHead}>
                    <Text style={styles.versionName}>{`Version ${version.n}`}</Text>
                    {isCurrent ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>Current</Text>
                      </View>
                    ) : null}
                    <View style={styles.fill} />
                    {isCurrent ? null : (
                      <Pressable
                        onPress={() => setConfirming(version.n)}
                        disabled={busy}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={version.n === 1 && history.builtin ? 'Reset to the default' : `Restore version ${version.n}`}
                        accessibilityState={{ disabled: busy }}
                        style={[styles.restore, busy && styles.disabled]}
                      >
                        <Text style={styles.restoreText}>{version.n === 1 && history.builtin ? 'Reset to the default' : 'Restore'}</Text>
                      </Pressable>
                    )}
                  </View>
                  <Text style={styles.when}>{[whenWord(version.at), note].filter(Boolean).join(' · ')}</Text>
                  <Text style={styles.text} selectable>
                    {version.text}
                  </Text>
                </View>
              )
            })}
          </View>
          <Text style={styles.help}>{countLine(history.versions.length)}</Text>
          {history.builtin && customised ? (
            <View style={styles.reset}>
              <ActionButton label="Reset to the default" variant="ghost" icon={RotateCcw} busy={busy} onPress={() => setConfirming(1)} />
            </View>
          ) : null}
        </ScrollView>
        <ActionSheet
          visible={picking !== null}
          title={picking === 'from' ? 'Older version' : 'Newer version'}
          actions={history.versions
            .map((v) => v.n)
            .sort((a, b) => b - a)
            .map((n) => ({
              id: String(n),
              label: versionLabel(n, history.current),
              icon: History,
              checked: range ? range[picking ?? 'from'] === n : false,
              onPress: () => range && picking && setRange({ ...range, [picking]: n })
            }))}
          onClose={() => setPicking(null)}
        />
        <ConfirmModal
          visible={confirm !== null}
          title={confirm?.title ?? ''}
          message={confirm?.message}
          confirmLabel={confirm?.confirm ?? 'Restore'}
          onConfirm={() => void restore()}
          onCancel={() => setConfirming(null)}
        />
      </>
    )
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.bgBase, paddingTop: insets.top }]}>
      <NavBar
        title={`History of ${name}`}
        subtitle={serverCount > 1 ? <NavBarSubtitleText>{server.machine}</NavBarSubtitleText> : undefined}
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />}
      />
      {body}
    </View>
  )
}

function PickRow({ label, value, current, onPress }: { label: string; value: number; current: number; onPress: () => void }) {
  useColorScheme()
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} ${versionLabel(value, current)}`} style={styles.pick}>
      <Text style={styles.pickLabel}>{label}</Text>
      <Text style={styles.pickValue} numberOfLines={1}>
        {versionLabel(value, current)}
      </Text>
      <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.2} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  help: { fontSize: 13, lineHeight: 19, color: colors.textSecondary },
  error: { fontSize: 13, lineHeight: 19, color: colors.statusRed },
  info: { fontSize: 13, lineHeight: 19, color: colors.statusGreen },
  compare: { gap: spacing.md },
  picks: { gap: spacing.sm },
  pick: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetGroup
  },
  pickLabel: { width: 60, fontSize: 12, color: colors.textMuted },
  pickValue: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  list: { borderRadius: radii.control, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgPanel, overflow: 'hidden' },
  version: { gap: 6, padding: spacing.md },
  versionLine: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  versionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  versionName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  badgeText: { fontSize: 11, fontWeight: '600', color: colors.statusGreen },
  when: { fontSize: 12, color: colors.textMuted },
  text: { fontFamily: typography.monoFamily, fontSize: 12.5, lineHeight: 19, color: colors.textPrimary },
  restore: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.control, backgroundColor: colors.sheetGroup },
  restoreText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  disabled: { opacity: 0.5 },
  reset: { alignItems: 'center' }
}))
