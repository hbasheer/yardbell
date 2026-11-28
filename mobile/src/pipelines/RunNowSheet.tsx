import { useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react-native'
import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { NoticeBanner } from '../changes/NoticeBanner'
import type { Notice } from '../changes/useChangesActions'
import type { PairedServer } from '../servers/store'
import { BottomDrawer } from '../ui/BottomDrawer'
import { ListGroup } from '../ui/ListGroup'
import { ListRow } from '../ui/ListRow'
import { SheetHeader } from '../ui/SheetHeader'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { listDiagrams, openTickets, startRuns, type DiagramRef } from './api'
import type { Definition } from './model'
import { Button } from './parts'
import { pipelinesKey } from './queries'
import { addItem, canStart, diagramLabel, runNowForm, runStartBody, startedWord } from './screenModel'

type Props = {
  visible: boolean
  server: PairedServer
  d: Definition
  busy: string | null
  notice: Notice | null
  onDismissNotice: () => void
  run: <T>(name: string, task: () => Promise<T>) => Promise<T | undefined>
  onClose: () => void
  onStarted: (text: string) => void
}

const sameDiagram = (a: DiagramRef | null, b: DiagramRef) => Boolean(a) && a!.machine === b.machine && a!.folder === b.folder && a!.dir === b.dir

export function RunNowSheet({ visible, server, d, busy, notice, onDismissNotice, run, onClose, onStarted }: Props) {
  useColorScheme()
  const kind = d.trigger.kind
  const form = runNowForm(kind)
  const [text, setText] = useState('')
  const [diagram, setDiagram] = useState<DiagramRef | null>(null)

  const diagrams = useQuery({
    queryKey: [...pipelinesKey(server.id), 'diagrams'],
    queryFn: async () => (await listDiagrams(server)).diagrams,
    enabled: visible && form.kind === 'items' && form.diagrams,
    retry: false,
    meta: { serverId: server.id }
  })
  const tickets = useQuery({
    queryKey: [...pipelinesKey(server.id), 'tickets'],
    queryFn: async () => (await openTickets(server)).tickets,
    enabled: visible && form.kind === 'items' && form.tickets,
    retry: false,
    meta: { serverId: server.id }
  })

  const start = () =>
    run('start', async () => {
      const out = await startRuns(server, d.id, runStartBody(kind, text, diagram))
      setText('')
      setDiagram(null)
      onStarted(startedWord(out.runs.length))
    })

  const starting = busy === 'start'
  const error = notice?.kind === 'error' ? notice : null

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <SheetHeader title="Run now" subtitle={d.name} onClose={onClose} />
      <View style={styles.body}>
        {form.kind === 'none' ? (
          <Text style={styles.help}>{form.message}</Text>
        ) : (
          <View style={styles.field}>
            <Text style={styles.label}>{form.label}</Text>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={form.placeholder}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel={form.label}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={styles.input}
            />
            <Text style={styles.help}>{form.help}</Text>
          </View>
        )}
        {form.kind === 'items' && form.tickets && tickets.data?.length ? (
          <View style={styles.field}>
            <Text style={styles.label}>Your open tickets</Text>
            <ListGroup>
              {tickets.data.map((t) => (
                <ListRow
                  key={t.linear_id}
                  title={`${t.id} ${t.title}`}
                  subtitle={[t.state, t.running_in.length ? `Running in ${t.running_in.join(', ')}` : ''].filter(Boolean).join(' · ')}
                  subtitleLines={1}
                  checked={text.split(/[\s,]+/).some((x) => x.toLowerCase() === t.id.toLowerCase())}
                  onPress={() => setText((now) => addItem(now, t.id))}
                />
              ))}
            </ListGroup>
          </View>
        ) : null}
        {form.kind === 'items' && form.diagrams && diagrams.data?.length ? (
          <View style={styles.field}>
            <Text style={styles.label}>Work from a diagram (optional)</Text>
            <ListGroup>
              {[
                <ListRow key="none" title="None" checked={diagram === null} onPress={() => setDiagram(null)} />,
                ...diagrams.data.map((c) => (
                  <ListRow
                    key={`${c.machine}:${c.folder}:${c.dir}`}
                    title={diagramLabel(c)}
                    checked={sameDiagram(diagram, c)}
                    onPress={() => setDiagram({ machine: c.machine, folder: c.folder, dir: c.dir })}
                  />
                ))
              ]}
            </ListGroup>
            <Text style={styles.help}>The run keeps its own copy, so drawing again does not change it.</Text>
          </View>
        ) : null}
        {error ? <NoticeBanner notice={error} onDismiss={onDismissNotice} /> : null}
        <Button label="Start" variant="primary" icon={Play} busy={starting} disabled={busy !== null || !canStart(form, text)} onPress={() => void start()} />
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  body: { gap: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  input: {
    minHeight: 64,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    textAlignVertical: 'top'
  },
  help: { fontSize: typography.metaSize, lineHeight: 17, color: colors.textMuted }
}))
