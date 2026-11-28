import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react-native'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { NoticeBanner } from '../../changes/NoticeBanner'
import type { PairedServer } from '../../servers/store'
import { ActionButton } from '../../ui/ActionButton'
import { BottomDrawer } from '../../ui/BottomDrawer'
import { ConfirmModal } from '../../ui/ConfirmModal'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { PageField } from '../../ui/PageField'
import { SectionHeader } from '../../ui/SectionHeader'
import { SheetHeader } from '../../ui/SheetHeader'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { SettingsScreen } from '../SettingsScreen'
import { changeMemory, type DispatchMemory, type MemoryRecord } from '../serverApi'
import { capBar, entryChange, entryLimit, entryProblem, ENTRY_HELP, historyHead, historyTitle, MEMORY_HELP, overCap } from './memoryModel'
import { Failed, Help, Loading, messageOf } from './parts'
import { memoryKey, useMemory, useSettingsTask } from './queries'

type Form = { old: string | null; entry: string }

const stamp = (at: string) => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function MemoryScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const queryClient = useQueryClient()
  const query = useMemory(server)
  const { busy: running, notice, setNotice, run } = useSettingsTask(server)
  const busy = running !== null
  const [form, setForm] = useState<Form | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const memory = query.data
  const limit = entryLimit(memory)

  const apply = (name: string, change: Parameters<typeof changeMemory>[1], done: string) =>
    run(name, async () => {
      const next = await changeMemory(server, change)
      queryClient.setQueryData<DispatchMemory>(memoryKey(server.id), next)
      setNotice({ kind: 'info', text: done })
      return true
    })

  const saveEntry = async () => {
    if (!form) return
    const found = entryProblem(form.entry, limit)
    setProblem(found)
    if (found) return
    const ok = await apply('entry', entryChange(form.old, form.entry), 'Saved. Dispatch reads it from the next message.')
    if (ok) setForm(null)
  }

  const forget = async (entry: string) => {
    setDeleting(null)
    const ok = await apply('forget', { change: 'forget', old: entry }, 'Deleted.')
    if (ok) setForm(null)
  }

  const open = (next: Form) => {
    setProblem(null)
    setForm(next)
  }

  let body
  if (query.isPending) body = <Loading title="Loading memory" />
  else if (!memory) body = <Failed message={messageOf(query.error, 'Could not read the memory.')} onRetry={() => void query.refetch()} />
  else {
    const bar = capBar(memory)
    const over = overCap(memory.omitted)
    body = (
      <>
        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {memory.error ? <NoticeBanner notice={{ kind: 'error', text: memory.error }} onDismiss={() => void query.refetch()} /> : null}
        {serverCount > 1 ? <SectionHeader title={server.machine} first /> : null}
        <View style={styles.cap}>
          <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: bar.percent }}>
            <View style={[styles.fill, styles[bar.tone], { width: `${bar.width}%` }]} />
          </View>
          <Text style={styles.capLabel}>{bar.label}</Text>
        </View>
        {over ? <Help tone="warn">{over}</Help> : null}
        <SectionHeader title="Entries" />
        <ListGroup>
          {memory.entries.map((entry) => (
            <ListRow key={entry} title={entry} titleLines={3} navigates disabled={busy} accessibilityLabel={`Entry: ${entry}`} onPress={() => open({ old: entry, entry })} />
          ))}
          <ListRow
            key="add"
            title="Add entry"
            leading={<Plus size={18} color={colors.accentBlue} strokeWidth={2.2} />}
            accent
            disabled={busy}
            onPress={() => open({ old: null, entry: '' })}
          />
        </ListGroup>
        <Help>{memory.entries.length ? `${MEMORY_HELP} Kept in ${memory.file || 'memory.md'}, which only your account can read.` : `Nothing remembered yet. When you correct Dispatch or tell it something that lasts, it proposes an entry for you to approve. ${MEMORY_HELP}`}</Help>
        {memory.history.length ? (
          <>
            <SectionHeader title={historyTitle(memory.history.length)} expanded={showHistory} onToggle={() => setShowHistory(!showHistory)} />
            {showHistory ? (
              <View style={styles.history}>
                {memory.history.map((record, at) => (
                  <HistoryItem key={`${record.at}-${at}`} record={record} />
                ))}
              </View>
            ) : null}
          </>
        ) : null}

        <BottomDrawer visible={form !== null} onClose={() => setForm(null)}>
          <SheetHeader
            title={form?.old === null ? 'New entry' : 'Entry'}
            onClose={() => setForm(null)}
            trailing={{ label: 'Save', onPress: () => void saveEntry(), disabled: busy, busy: running === 'entry' }}
          />
          <PageField
            value={form?.entry ?? ''}
            onChangeText={(entry) => form && setForm({ ...form, entry })}
            multiline
            maxLength={limit}
            autoFocus
            placeholder="Always use the shared docker stack on hp."
            accessibilityLabel="Entry"
            style={styles.area}
          />
          <View style={styles.counterRow}>
            <Text style={styles.counterHelp}>{ENTRY_HELP}</Text>
            <Text style={[styles.counter, (form?.entry.length ?? 0) >= limit && styles.counterFull]}>{`${form?.entry.length ?? 0} / ${limit}`}</Text>
          </View>
          {problem ? (
            <Text style={styles.problem} accessibilityRole="alert">
              {problem}
            </Text>
          ) : null}
          {form?.old ? (
            <View style={styles.delete}>
              <ActionButton label="Delete entry" variant="ghost" disabled={busy} onPress={() => setDeleting(form.old)} />
            </View>
          ) : null}
        </BottomDrawer>
        <ConfirmModal
          visible={deleting !== null}
          title="Delete this entry?"
          message={deleting ? `Dispatch stops reading "${deleting}" from the next message. The history keeps a record of it.` : undefined}
          confirmLabel="Delete"
          destructive
          onConfirm={() => deleting && void forget(deleting)}
          onCancel={() => setDeleting(null)}
        />
      </>
    )
  }

  return <SettingsScreen title="Memory">{body}</SettingsScreen>
}

function HistoryItem({ record }: { record: MemoryRecord }) {
  useColorScheme()
  return (
    <View style={styles.item}>
      <Text style={styles.itemHead}>{historyHead(record, stamp(record.at))}</Text>
      {record.change !== 'add' && record.old ? <Text style={[styles.diff, styles.removed]}>{`- ${record.old}`}</Text> : null}
      {record.change !== 'forget' && record.entry ? <Text style={[styles.diff, styles.added]}>{`+ ${record.entry}`}</Text> : null}
      {record.reason ? <Text style={styles.itemHead}>{record.reason}</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  cap: { gap: spacing.sm, paddingTop: spacing.md },
  track: { height: 6, borderRadius: radii.pill, overflow: 'hidden', backgroundColor: colors.sheetGroup },
  fill: { height: '100%', borderRadius: radii.pill },
  ok: { backgroundColor: colors.statusGreen },
  warn: { backgroundColor: colors.statusAmber },
  full: { backgroundColor: colors.statusRed },
  capLabel: { fontSize: 13, color: colors.textSecondary },
  history: { gap: spacing.md, paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  item: { gap: 4 },
  itemHead: { fontSize: 12, lineHeight: 17, color: colors.textSecondary },
  diff: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: 6, overflow: 'hidden' },
  removed: { color: colors.statusRed, backgroundColor: colors.sheetGroup },
  added: { color: colors.statusGreen, backgroundColor: colors.sheetGroup },
  area: { minHeight: 96, paddingTop: spacing.md, textAlignVertical: 'top' },
  counterRow: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.xs, paddingTop: spacing.sm },
  counterHelp: { flex: 1, fontSize: 13, color: colors.textSecondary },
  counter: { fontSize: 13, fontVariant: ['tabular-nums'], color: colors.textMuted },
  counterFull: { color: colors.statusRed },
  problem: { fontSize: 13, color: colors.statusRed, paddingHorizontal: spacing.xs, paddingTop: spacing.sm },
  delete: { alignItems: 'center', paddingTop: spacing.md }
}))
