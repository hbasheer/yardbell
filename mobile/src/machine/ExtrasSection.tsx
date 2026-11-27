import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { ArrowUpRight, Play, Square, Terminal, Trash2, type LucideIcon } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ApiClient } from '@/api/client'
import { sessionHref } from '@/home/presentation'
import { START_TIMEOUT_MS, type Started } from '@/new-session/request'
import type { PairedServer } from '@/servers/store'
import type { AgentView, EndedView } from '@/state/types'
import type { MachineExtras, ServerSession } from '@/state/views'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { SectionHeader } from '@/ui/SectionHeader'
import { triggerMediumImpact } from '@/ui/haptics'
import { colors, spacing, themedStyleSheet, typography, useColorScheme } from '@/ui/theme'
import { LOOSE_NOTE, moveCopy, short, staleNote, stopCopy } from './extras'
import { ROW_SEPARATOR_INSET } from './WorkspaceRow'

type Kind = 'stale' | 'loose' | 'ended'

type Pending =
  | { kind: 'move'; session: ServerSession }
  | { kind: 'stop'; session: ServerSession }

type Menu = { kind: 'loose'; session: ServerSession } | { kind: 'ended'; ended: EndedView }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function Glyph({ off }: { off: boolean }) {
  return (
    <View style={styles.glyph}>
      <Terminal size={14} color={colors.textMuted} strokeWidth={2} />
      {off ? <View style={styles.slash} /> : null}
    </View>
  )
}

function ExtraRow(props: {
  title: string
  branch?: string | null
  line: string
  off: boolean
  accessibilityLabel: string
  onPress?: () => void
}) {
  useColorScheme()
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onPress ? () => { triggerMediumImpact(); props.onPress?.() } : undefined}
      disabled={!props.onPress}
      accessibilityRole={props.onPress ? 'button' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.onPress ? 'Opens the actions for this session' : undefined}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.indicator}>
        <Glyph off={props.off} />
      </View>
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={1}>
          {props.title}
        </Text>
        {props.branch ? (
          <Text style={styles.branch} numberOfLines={1} ellipsizeMode="middle">
            {props.branch}
          </Text>
        ) : null}
        <Text style={styles.line} numberOfLines={1}>
          {props.line}
        </Text>
      </View>
    </Pressable>
  )
}

const branchOf = (branch: string | undefined) => (branch && branch !== '-' ? branch : null)

export function ExtrasSection({
  server,
  machine,
  extras,
  agents,
  forceOpen
}: {
  server: PairedServer
  machine: string
  extras: MachineExtras
  agents: AgentView[] | undefined
  forceOpen: boolean
}) {
  useColorScheme()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<ReadonlySet<Kind>>(new Set())
  const [menu, setMenu] = useState<Menu | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)

  const api = () => new ApiClient(server)
  const refresh = () => queryClient.refetchQueries({ queryKey: ['state', server.id] })
  const toggle = (kind: Kind) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(kind)) next.add(kind)
      return next
    })
  const isOpen = (kind: Kind) => forceOpen || open.has(kind)
  const fail = (title: string) => (error: unknown) => setFailure({ title, message: message(error) })
  const pidPath = (session: ServerSession, action: string) =>
    `/sessions/${encodeURIComponent(session.machine)}/${encodeURIComponent(String(session.pid))}/${action}`

  const confirm = () => {
    const current = pending
    setPending(null)
    if (!current || busy) return
    setBusy(true)
    if (current.kind === 'move') {
      api()
        .post<{ name: string }>(pidPath(current.session, 'move-to-tmux'), undefined, START_TIMEOUT_MS)
        .then(async (res) => {
          await refresh()
          const href = sessionHref({ serverId: server.id, machine: current.session.machine, tmux: res.name })
          if (href) router.push(href as never)
        })
        .catch(fail('Could not move the session into tmux'))
        .finally(() => setBusy(false))
      return
    }
    api()
      .post(pidPath(current.session, 'stop-process'))
      .then(refresh)
      .catch(fail('Could not stop the agent'))
      .finally(() => setBusy(false))
  }

  const resume = (ended: EndedView) => {
    if (busy) return
    setBusy(true)
    const body = {
      machine: ended.machine,
      ...(ended.path ? { path: ended.path } : { folder: ended.folder }),
      resume: true,
      agent: ended.agent,
      wait: true
    }
    api()
      .post<Started>('/sessions', body, START_TIMEOUT_MS)
      .then(async (res) => {
        await refresh()
        const href = sessionHref({ serverId: server.id, machine: ended.machine, tmux: res.name })
        if (href) router.push(href as never)
      })
      .catch(fail('Could not resume the session'))
      .finally(() => setBusy(false))
  }

  const forget = (ended: EndedView) => {
    api()
      .post(`/ended/${encodeURIComponent(ended.id)}/forget`)
      .then(refresh)
      .catch(fail('Could not forget the session'))
  }

  const menuActions = (): ActionSheetAction[] => {
    if (!menu) return []
    if (menu.kind === 'ended') {
      const ended = menu.ended
      return [
        { label: 'Resume', icon: Play, closeBeforePress: true, onPress: () => resume(ended) },
        { label: 'Forget', icon: Trash2, destructive: true, closeBeforePress: true, onPress: () => forget(ended) }
      ]
    }
    const session = menu.session
    const canAct = typeof session.pid === 'number'
    const actions: [string, LucideIcon, Pending['kind'], boolean][] = [
      ['Move to tmux', ArrowUpRight, 'move', false],
      ['Stop', Square, 'stop', true]
    ]
    return actions.map(([label, icon, kind, destructive]) => ({
      label,
      icon,
      destructive,
      disabled: !canAct,
      hint: canAct ? undefined : 'The server did not report a process id',
      closeBeforePress: true,
      onPress: () => setPending({ kind, session })
    }))
  }

  const copy = pending
    ? (pending.kind === 'move' ? moveCopy : stopCopy)(pending.session, agents)
    : null
  const menuTitle = menu ? (menu.kind === 'loose' ? short(menu.session.folder) : short(menu.ended.folder)) : undefined
  const menuBranch = menu ? branchOf(menu.kind === 'loose' ? menu.session.branch : menu.ended.branch) : null

  const panels: { kind: Kind; count: number; label: string }[] = [
    { kind: 'stale' as const, count: extras.stale.length, label: 'last known' },
    { kind: 'loose' as const, count: extras.loose.length, label: 'outside tmux' },
    { kind: 'ended' as const, count: extras.ended.length, label: 'ended' }
  ].filter((panel) => panel.count > 0)

  return (
    <View>
      {panels.map((panel) => (
        <View key={panel.kind}>
          <SectionHeader
            title={`${panel.count} ${panel.label}`}
            expanded={isOpen(panel.kind)}
            onToggle={() => toggle(panel.kind)}
          />
          {isOpen(panel.kind) ? (
            <View>
              {panel.kind === 'loose' ? <Text style={styles.note}>{LOOSE_NOTE}</Text> : null}
              {panel.kind === 'stale' ? <Text style={styles.note}>{staleNote(machine)}</Text> : null}
              {panel.kind === 'stale'
                ? extras.stale.map((session, i) => (
                    <View key={session.id}>
                      <ExtraRow
                        title={short(session.folder)}
                        branch={branchOf(session.branch)}
                        line={`${session.agent} · Last known`}
                        off={false}
                        accessibilityLabel={`${session.folder}, last known`}
                      />
                      {i === extras.stale.length - 1 ? null : <View style={styles.separator} />}
                    </View>
                  ))
                : null}
              {panel.kind === 'loose'
                ? extras.loose.map((session, i) => (
                    <View key={session.id}>
                      <ExtraRow
                        title={short(session.folder)}
                        branch={branchOf(session.branch)}
                        line={`${session.agent} · ${session.activity === 'active' ? 'Working' : 'Outside tmux'}`}
                        off
                        accessibilityLabel={`${session.folder}, outside tmux`}
                        onPress={() => setMenu({ kind: 'loose', session })}
                      />
                      {i === extras.loose.length - 1 ? null : <View style={styles.separator} />}
                    </View>
                  ))
                : null}
              {panel.kind === 'ended'
                ? extras.ended.map((ended, i) => (
                    <View key={ended.id}>
                      <ExtraRow
                        title={short(ended.folder)}
                        branch={ended.worktree ? branchOf(ended.branch) : null}
                        line={`${ended.agent} · Ended`}
                        off
                        accessibilityLabel={`${ended.folder}, ended`}
                        onPress={() => setMenu({ kind: 'ended', ended })}
                      />
                      {i === extras.ended.length - 1 ? null : <View style={styles.separator} />}
                    </View>
                  ))
                : null}
            </View>
          ) : null}
        </View>
      ))}
      <ActionSheet
        visible={menu !== null}
        title={menuTitle}
        message={menuBranch ?? undefined}
        actions={menuActions()}
        onClose={() => setMenu(null)}
      />
      <ConfirmModal
        visible={pending !== null}
        title={copy?.title ?? ''}
        message={copy?.message}
        confirmLabel={copy?.confirm}
        destructive={pending?.kind === 'stop'}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
      <ConfirmModal
        visible={failure !== null}
        title={failure?.title ?? ''}
        message={failure?.message}
        cancelLabel={null}
        confirmLabel="OK"
        onCancel={() => setFailure(null)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  note: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
    opacity: 0.7
  },
  pressed: { backgroundColor: colors.bgRaised },
  indicator: { width: 20, paddingTop: 3, marginRight: spacing.sm },
  glyph: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  slash: {
    position: 'absolute',
    width: 18,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: colors.textMuted,
    transform: [{ rotate: '-45deg' }]
  },
  main: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: colors.textPrimary },
  branch: { marginTop: 2, fontSize: 11, color: colors.textMuted, fontFamily: typography.monoFamily },
  line: { marginTop: 3, fontSize: 11, color: colors.textMuted },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: ROW_SEPARATOR_INSET, backgroundColor: colors.borderSubtle }
}))
