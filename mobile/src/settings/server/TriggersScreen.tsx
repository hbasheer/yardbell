import { useIsFocused, useRouter } from 'expo-router'
import { Zap } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Switch, Text, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { NoticeBanner } from '../../changes/NoticeBanner'
import { dispatchHref } from '../../dispatch/listModel'
import type { PairedServer } from '../../servers/store'
import { ActionButton } from '../../ui/ActionButton'
import { ConfirmModal } from '../../ui/ConfirmModal'
import { ListGroup } from '../../ui/ListGroup'
import { SectionHeader } from '../../ui/SectionHeader'
import { StateView } from '../../ui/StateView'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { useAppActive } from '../../ui/useAppActive'
import { SettingsScreen } from '../SettingsScreen'
import { runTrigger, setTriggerEnabled, type TriggerList, type TriggerState } from '../serverApi'
import { Failed, Help, Loading, messageOf } from './parts'
import { triggersKey, useSettingsTask, useTriggers } from './queries'
import { canRun, lastWord, planWord, problemWord, runConfirm, runLabel, runResult, sentence } from './triggersModel'

const TRIGGERS_HELP = (zone: string | undefined) =>
  `A trigger starts a Dispatch conversation from one of your saved prompts, on a schedule or when a ticket comes your way. Its steps follow your Dispatch rules like any other conversation. Times are in ${zone || "this server's time zone"}, the time zone of the machine Yardbell runs on. Editing triggers stays on the computer.`

export function TriggersScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const queryClient = useQueryClient()
  const focused = useIsFocused()
  const appActive = useAppActive()
  const { busy: running, notice, setNotice, run } = useSettingsTask(server, () => [triggersKey(server.id)])
  const busy = running !== null
  const query = useTriggers(server, focused && appActive && !busy)
  const [switching, setSwitching] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<TriggerState | null>(null)

  const open = (conversation: string) => router.push(dispatchHref(server.id, conversation) as never)

  const toggle = (name: string, on: boolean) =>
    run(`enable:${name}`, async () => {
      setSwitching({ [name]: on })
      try {
        const next = await setTriggerEnabled(server, name, on)
        queryClient.setQueryData<TriggerList>(triggersKey(server.id), next)
        setNotice({ kind: 'info', text: `Trigger ${name} is ${on ? 'on' : 'off'}.` })
        return true
      } finally {
        setSwitching({})
      }
    })

  const start = async (t: TriggerState) => {
    setConfirming(null)
    const out = await run(`run:${t.trigger.name}`, async () => {
      try {
        return runResult(t.trigger.name, await runTrigger(server, t.trigger.name))
      } catch (error) {
        throw new Error(sentence(messageOf(error, 'The trigger did not run')))
      }
    })
    if (!out) return
    setNotice({ kind: 'info', text: out.text })
    if (out.conversation) open(out.conversation)
  }

  const list = query.data
  let body
  if (query.isPending) body = <Loading title="Reading triggers" />
  else if (!list) body = <Failed message={messageOf(query.error, 'Could not read the triggers.')} onRetry={() => void query.refetch()} />
  else
    body = (
      <>
        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {serverCount > 1 ? <SectionHeader title={server.machine} first /> : null}
        {list.triggers.length === 0 ? (
          <View style={styles.empty}>
            <StateView
              icon={Zap}
              title="No triggers yet"
              message="Start a Dispatch conversation from a saved prompt every morning, on weekdays, or when a Linear or GitHub ticket is assigned to you. Add triggers on the computer."
            />
          </View>
        ) : (
          <ListGroup surface="page" style={styles.group}>
            {list.triggers.map((t) => (
              <TriggerRow
                key={t.trigger.name}
                item={t}
                now={list.now}
                enabled={switching[t.trigger.name] ?? t.trigger.enabled}
                busy={busy}
                onToggle={(on) => void toggle(t.trigger.name, on)}
                onRun={() => setConfirming(t)}
                onOpen={open}
              />
            ))}
          </ListGroup>
        )}
        <Help>{TRIGGERS_HELP(list.zone)}</Help>
        <ConfirmModal
          visible={confirming !== null}
          title={confirming ? runConfirm(confirming).title : ''}
          message={confirming ? runConfirm(confirming).message : undefined}
          confirmLabel={confirming ? runConfirm(confirming).confirm : undefined}
          onConfirm={() => confirming && void start(confirming)}
          onCancel={() => setConfirming(null)}
        />
      </>
    )

  return <SettingsScreen title="Triggers">{body}</SettingsScreen>
}

type RowProps = {
  item: TriggerState
  now: string | undefined
  enabled: boolean
  busy: boolean
  onToggle: (on: boolean) => void
  onRun: () => void
  onOpen: (conversation: string) => void
}

function TriggerRow({ item, now, enabled, busy, onToggle, onRun, onOpen }: RowProps) {
  useColorScheme()
  const t = item.trigger
  const plan = planWord(item, now)
  const last = lastWord(item, now)
  const conversation = item.last?.conversation
  return (
    <View style={[styles.row, !t.enabled && styles.off]}>
      <View style={styles.head}>
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {t.name}
          </Text>
          {item.describe ? <Text style={styles.meta}>{item.describe}</Text> : null}
        </View>
        <Switch value={enabled} disabled={busy} onValueChange={onToggle} trackColor={{ true: colors.accentBlue }} accessibilityLabel={`${t.name} on`} />
      </View>
      <Text style={styles.meta}>{`Runs the saved prompt ${t.task}${plan ? ` · ${plan}` : ''}`}</Text>
      {last ? <Text style={[styles.meta, last.failed && styles.failed]}>{last.text}</Text> : null}
      {item.note ? <Text style={styles.meta}>{`${item.note}.`}</Text> : null}
      {item.problem ? <Text style={styles.failed}>{problemWord(item.problem)}</Text> : null}
      <View style={styles.actions}>
        <ActionButton label={runLabel(item)} variant="ghost" disabled={!canRun(item, busy) || item.busy === true} onPress={onRun} />
        {conversation ? (
          <Pressable onPress={() => onOpen(conversation)} accessibilityRole="button" accessibilityLabel={`Open the conversation of ${t.name}`} hitSlop={6} style={styles.link}>
            <Text style={styles.linkText}>Open the conversation</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  group: { marginTop: spacing.md },
  empty: { paddingTop: 40 },
  row: { gap: 4, padding: spacing.lg },
  off: { opacity: 0.75 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  meta: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  failed: { fontSize: 13, lineHeight: 18, color: colors.statusRed },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginLeft: -spacing.md, marginTop: spacing.xs },
  link: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radii.control },
  linkText: { fontSize: 14, fontWeight: '500', color: colors.accentBlue }
}))
