import * as Clipboard from 'expo-clipboard'
import { useQueryClient } from '@tanstack/react-query'
import { useIsFocused, useRouter } from 'expo-router'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  FileDiff,
  FileText,
  GitBranch,
  MoreHorizontal,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X
} from 'lucide-react-native'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, SectionList, Text, TextInput, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PairedServer } from '../servers/store'
import { ActionSheet, type ActionSheetAction } from '../ui/ActionSheet'
import { ConfirmModal } from '../ui/ConfirmModal'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { PullDownMenu } from '../ui/PullDownMenu'
import { SearchField } from '../ui/SearchField'
import { DisclosureChevron } from '../ui/DisclosureChevron'
import { LoadErrorState, StateView } from '../ui/StateView'
import { triggerMediumImpact } from '../ui/haptics'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { useAppActive } from '../ui/useAppActive'
import { useKeyboardHeight } from '../ui/useKeyboardHeight'
import { fileHref } from '../files/model'
import { changePaths, commitChanges, draftMessage, gitAction, type Change, type GitAction } from './api'
import { ChangeRow } from './ChangeRow'
import {
  absolutePath,
  commitAllConfirm,
  commitInput,
  committedNotice,
  diffHref,
  discardConfirm,
  fileKey,
  filterChanges,
  primaryAction,
  rootName,
  splitChanges,
  uniquePaths
} from './model'
import { NoticeBanner } from './NoticeBanner'
import { changesKey, useChangesList, useGuardedActions } from './useChangesActions'

const DONE: Record<GitAction, string> = { push: 'Pushed', pull: 'Pulled', fetch: 'Fetched' }

type Section = { key: 'staged' | 'changes'; title: string; count: number; folded: boolean; data: Change[] }

export function ChangesScreen({ server, machine, root, multipleServers }: { server: PairedServer; machine: string; root: string; multipleServers: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight().height
  const focused = useIsFocused()
  const appActive = useAppActive()
  const queryClient = useQueryClient()
  const key = changesKey(server.id, machine, root)
  const { busy, notice, setNotice, run } = useGuardedActions(
    () => queryClient.cancelQueries({ queryKey: key }),
    () => {
      queryClient.refetchQueries({ queryKey: key }).catch(() => {})
    }
  )
  const polling = focused && appActive && busy === null
  const query = useChangesList(server, machine, root, polling)
  const { data, refetch } = query

  const wasPolling = useRef(polling)
  useEffect(() => {
    if (polling && !wasPolling.current) refetch({ cancelRefetch: false }).catch(() => {})
    wasPolling.current = polling
  }, [polling, refetch])

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  const [message, setMessage] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [filter, setFilter] = useState('')
  const [folded, setFolded] = useState({ staged: false, changes: false })
  const [discarding, setDiscarding] = useState<Change[] | null>(null)
  const [committingAll, setCommittingAll] = useState<'commit' | 'push' | null>(null)
  const [rowMenu, setRowMenu] = useState<Change | null>(null)
  const [splitOpen, setSplitOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HostInstance>(null)

  const files = data?.files ?? []
  const anyStaged = files.some((f) => f.staged)
  const dirty = files.length > 0
  const ahead = data?.ahead || 0
  const behind = data?.behind || 0
  const canCommit = dirty && message.trim() !== ''
  const inflight = busy !== null

  const shown = useMemo(() => filterChanges(files, filter), [files, filter])
  const split = useMemo(() => splitChanges(shown), [shown])
  const all: Section[] = [
    { key: 'staged', title: 'Staged Changes', count: split.staged.length, folded: folded.staged, data: folded.staged ? [] : split.staged },
    { key: 'changes', title: 'Changes', count: split.unstaged.length, folded: folded.changes, data: folded.changes ? [] : split.unstaged }
  ]
  const sections = all.filter((section) => section.count > 0)

  const git = (action: GitAction) =>
    run(action, async () => {
      await gitAction(server, machine, action, root)
      setNotice({ kind: 'info', text: DONE[action] })
    })

  const moveFiles = (action: 'stage' | 'unstage', paths: string[]) =>
    run(action, async () => {
      await changePaths(server, machine, action, root, paths)
    })

  const discard = (list: Change[]) =>
    run('discard', async () => {
      await changePaths(server, machine, 'discard', root, uniquePaths(list))
    })

  const draft = () =>
    run('draft', async () => {
      const drafted = await draftMessage(server, machine, root)
      setMessage(drafted.message || '')
      if (drafted.from === 'files') setNotice({ kind: 'info', text: 'Drafted from the file names. Edit it before you commit.' })
    })

  const commit = (then: 'commit' | 'push') =>
    run('commit', async () => {
      const { short } = await commitChanges(server, machine, root, message, commitInput({ files, truncated: data?.truncated ?? false }))
      setMessage('')
      if (then === 'push') {
        try {
          await gitAction(server, machine, 'push', root)
        } catch (error) {
          throw new Error(committedNotice(short, error instanceof Error ? error.message : String(error)))
        }
        setNotice({ kind: 'info', text: `Committed ${short} and pushed` })
        return
      }
      setNotice({ kind: 'info', text: committedNotice(short, null) })
    })

  const requestCommit = (then: 'commit' | 'push') => {
    if (!message.trim()) {
      setNotice({ kind: 'error', text: 'Write a commit message first' })
      return
    }
    if (anyStaged) commit(then)
    else setCommittingAll(then)
  }

  const primary = data ? primaryAction(data) : null
  const runPrimary = () => {
    if (!primary) return
    if (primary.kind === 'commit') requestCommit('commit')
    else git(primary.kind)
  }
  const primaryDisabled = inflight || !primary || (primary.kind === 'commit' && !canCommit)
  const PrimaryIcon = primary?.kind === 'commit' ? Check : primary?.kind === 'pull' ? ArrowDown : primary?.kind === 'push' ? ArrowUp : RefreshCw

  const open = (file: Change) => router.push(diffHref(server.id, machine, root, file) as never)
  const toggleStage = (file: Change) => moveFiles(file.staged ? 'unstage' : 'stage', [file.path])

  const copy = (text: string) => {
    Clipboard.setStringAsync(text).catch((error) => console.error('Could not copy', error))
  }

  const menuActions = (file: Change): ActionSheetAction[] => {
    const untracked = file.status === 'untracked'
    return [
      { label: 'Open Changes', icon: FileDiff, onPress: () => open(file) },
      {
        label: 'Open File',
        icon: FileText,
        disabled: file.status === 'deleted',
        hint: file.status === 'deleted' ? 'File was deleted' : undefined,
        onPress: () => router.push(fileHref({ serverId: server.id, machine, root, path: file.path }) as never)
      },
      { label: file.staged ? 'Unstage' : 'Stage', icon: file.staged ? Minus : Plus, disabled: inflight, onPress: () => toggleStage(file) },
      ...(file.staged
        ? []
        : [
            {
              label: untracked ? 'Delete File' : 'Discard Changes',
              icon: untracked ? Trash2 : Undo2,
              destructive: true,
              disabled: inflight,
              closeBeforePress: true,
              onPress: () => setDiscarding([file])
            }
          ]),
      { label: 'Copy path', icon: Copy, onPress: () => copy(absolutePath(root, file.path)) },
      { label: 'Copy relative path', icon: Copy, onPress: () => copy(file.path) }
    ]
  }

  const remoteActions: ActionSheetAction[] = [
    { label: 'Fetch', icon: RefreshCw, disabled: inflight, onPress: () => git('fetch') },
    { label: 'Pull', icon: ArrowDown, status: behind ? String(behind) : undefined, disabled: inflight, onPress: () => git('pull') },
    { label: 'Push', icon: ArrowUp, status: ahead ? String(ahead) : undefined, disabled: inflight, onPress: () => git('push') }
  ]
  const moreActions: ActionSheetAction[] = [...remoteActions, { label: 'Refresh', icon: RotateCw, disabled: inflight, onPress: () => refetch().catch(() => {}) }]
  const splitActions: ActionSheetAction[] = [
    { label: 'Commit', icon: Check, disabled: inflight || !canCommit, onPress: () => requestCommit('commit') },
    { label: 'Commit & Push', icon: ArrowUp, disabled: inflight || !canCommit, onPress: () => requestCommit('push') },
    ...remoteActions
  ]

  const discardText = discarding ? discardConfirm(discarding) : null
  const commitAllText = data ? commitAllConfirm({ files, truncated: data.truncated }) : null

  const serverLabel = multipleServers && server.machine !== machine ? ` · ${server.machine}` : ''

  const header = data ? (
    <View>
      <View style={styles.branchRow}>
        <GitBranch size={14} color={colors.textMuted} strokeWidth={2} />
        <Text style={styles.branch} numberOfLines={1}>
          {data.branch || 'no branch'}
        </Text>
        {data.upstream ? (
          <Text style={styles.upstream} numberOfLines={1}>
            {`→ ${data.upstream}`}
          </Text>
        ) : null}
        {ahead > 0 ? (
          <View style={styles.counter}>
            <ArrowUp size={12} color={colors.textMuted} strokeWidth={2.2} />
            <Text style={styles.counterText}>{ahead}</Text>
          </View>
        ) : null}
        {behind > 0 ? (
          <View style={styles.counter}>
            <ArrowDown size={12} color={colors.textMuted} strokeWidth={2.2} />
            <Text style={styles.counterText}>{behind}</Text>
          </View>
        ) : null}
      </View>
      {query.isError ? (
        <Text style={styles.stale} numberOfLines={2}>
          {`Not updating: ${query.error instanceof Error ? query.error.message : 'unknown error'}`}
        </Text>
      ) : null}
      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
      <View style={styles.commit}>
        {dirty ? (
          <View>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="Message"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Commit message"
              multiline
              style={styles.message}
            />
            <Pressable
              onPress={draft}
              disabled={inflight}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Draft a message from the changes"
              style={({ pressed }) => [styles.draft, (pressed || busy === 'draft') && styles.pressed]}
            >
              {busy === 'draft' ? <ActivityIndicator size="small" color={colors.textSecondary} /> : <Sparkles size={16} color={colors.textSecondary} strokeWidth={2} />}
            </Pressable>
          </View>
        ) : null}
        <View style={styles.buttons}>
          <Pressable
            onPress={runPrimary}
            disabled={primaryDisabled}
            accessibilityRole="button"
            accessibilityLabel={primary?.label}
            accessibilityState={{ disabled: primaryDisabled, busy: inflight }}
            style={({ pressed }) => [styles.primary, primaryDisabled && styles.disabled, pressed && styles.pressed]}
          >
            {inflight && busy !== 'draft' ? <ActivityIndicator size="small" color={colors.bgBase} /> : <PrimaryIcon size={16} color={colors.bgBase} strokeWidth={2.2} />}
            <Text style={styles.primaryText} numberOfLines={1}>
              {primary?.label}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSplitOpen(true)}
            disabled={inflight}
            accessibilityRole="button"
            accessibilityLabel="More commit and remote actions"
            style={({ pressed }) => [styles.split, inflight && styles.disabled, pressed && styles.pressed]}
          >
            <ChevronDown size={16} color={colors.bgBase} strokeWidth={2.2} />
          </Pressable>
        </View>
      </View>
      {filtering ? (
        <View style={styles.filter}>
          <SearchField value={filter} onChangeText={setFilter} placeholder="Filter files by name" autoFocus />
        </View>
      ) : null}
    </View>
  ) : null

  const sectionTools = (section: Section) =>
    section.key === 'staged' ? (
      <View style={styles.tools}>
        <Text style={styles.count}>{section.count}</Text>
        <Tool icon={Minus} label="Unstage All Changes" disabled={inflight} onPress={() => moveFiles('unstage', uniquePaths(split.staged))} />
      </View>
    ) : (
      <View style={styles.tools}>
        <Text style={styles.count}>{section.count}</Text>
        <Tool icon={Undo2} label="Discard All Changes" disabled={inflight} onPress={() => setDiscarding(split.unstaged)} />
        <Tool icon={Plus} label="Stage All Changes" disabled={inflight} onPress={() => moveFiles('stage', uniquePaths(split.unstaged))} />
      </View>
    )

  let empty = null
  if (query.isPending) empty = <StateView loading title="Reading the changes" />
  else if (!data) empty = <LoadErrorState message={query.error instanceof Error ? query.error.message : 'Could not read the changes.'} onRetry={() => refetch()} />
  else if (!files.length) empty = <Text style={styles.note}>No changes. The working tree matches the last commit.</Text>
  else if (!shown.length) empty = <Text style={styles.note}>No changed file matches the filter.</Text>

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        title={rootName(root)}
        subtitle={`${machine}${serverLabel}`}
        refreshing={query.isFetching && !query.isPending}
        trailing={
          <>
            <NavBarButton
              icon={filtering ? X : Search}
              accessibilityLabel={filtering ? 'Close filter' : 'Filter files by name'}
              active={filtering}
              onPress={() => {
                setFilter('')
                setFiltering(!filtering)
              }}
            />
            <View ref={moreRef} collapsable={false}>
              <NavBarButton icon={MoreHorizontal} accessibilityLabel="More Source Control Actions" active={moreOpen} onPress={() => setMoreOpen(true)} />
            </View>
          </>
        }
      />
      {data ? (
        <SectionList<Change, Section>
          sections={sections}
          keyExtractor={fileKey}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={header ?? undefined}
          ListEmptyComponent={empty ? <View style={styles.empty}>{empty}</View> : undefined}
          ListFooterComponent={data.truncated ? <Text style={styles.note}>Too many changes to list them all here.</Text> : <View />}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: Math.max(insets.bottom, keyboard) + spacing.xl }}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionBar}>
              <Pressable
                onPress={() => setFolded((f) => ({ ...f, [section.key]: !f[section.key] }))}
                accessibilityRole="button"
                accessibilityLabel={section.title}
                accessibilityState={{ expanded: !section.folded }}
                style={({ pressed }) => [styles.sectionToggle, pressed && styles.pressed]}
              >
                <DisclosureChevron expanded={!section.folded} collapsedDeg={-90} expandedDeg={0}>
                  <ChevronDown size={15} color={colors.textMuted} strokeWidth={2.2} />
                </DisclosureChevron>
                <Text style={styles.sectionTitle} numberOfLines={1}>
                  {section.title}
                </Text>
              </Pressable>
              {sectionTools(section)}
            </View>
          )}
          renderItem={({ item }) => (
            <ChangeRow
              file={item}
              busy={inflight}
              onOpen={open}
              onMenu={(file) => {
                triggerMediumImpact()
                setRowMenu(file)
              }}
              onToggleStage={toggleStage}
              onDiscard={(file) => setDiscarding([file])}
            />
          )}
        />
      ) : (
        <View style={styles.empty}>{empty}</View>
      )}
      <PullDownMenu visible={moreOpen} anchorRef={moreRef} groups={[moreActions]} onClose={() => setMoreOpen(false)} />
      <ActionSheet visible={splitOpen} actions={splitActions} onClose={() => setSplitOpen(false)} />
      <ActionSheet
        visible={rowMenu !== null}
        title={rowMenu ? rowMenu.path : undefined}
        actions={rowMenu ? menuActions(rowMenu) : []}
        groupDestructive
        onClose={() => setRowMenu(null)}
      />
      <ConfirmModal
        visible={discarding !== null}
        title={discardText?.title ?? ''}
        message={discardText?.body}
        confirmLabel={discardText?.confirm}
        destructive
        onConfirm={() => discarding && discard(discarding)}
        onCancel={() => setDiscarding(null)}
      />
      <ConfirmModal
        visible={committingAll !== null}
        title={commitAllText?.title ?? ''}
        message={commitAllText?.body}
        confirmLabel={committingAll === 'push' ? 'Commit all and push' : 'Commit all'}
        onConfirm={() => committingAll && commit(committingAll)}
        onCancel={() => setCommittingAll(null)}
      />
    </View>
  )
}

function Tool({ icon: Icon, label, disabled, onPress }: { icon: typeof Plus; label: string; disabled: boolean; onPress: () => void }) {
  useColorScheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.tool, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Icon size={16} color={colors.textSecondary} strokeWidth={2.2} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  branchRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  branch: { flexShrink: 1, fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  upstream: { flexShrink: 2, fontSize: typography.metaSize, color: colors.textMuted },
  counter: { flexDirection: 'row', alignItems: 'center' },
  counterText: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  stale: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, fontSize: typography.metaSize, color: colors.statusAmber },
  commit: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.sm },
  message: {
    minHeight: 72,
    maxHeight: 160,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.sm,
    paddingRight: 40,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    textAlignVertical: 'top'
  },
  draft: { position: 'absolute', top: spacing.sm, right: spacing.sm, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', gap: 2 },
  primary: {
    flex: 1,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderTopLeftRadius: radii.control,
    borderBottomLeftRadius: radii.control,
    backgroundColor: colors.textPrimary
  },
  primaryText: { fontSize: typography.bodySize, fontWeight: '600', color: colors.bgBase, flexShrink: 1 },
  split: {
    width: 44,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopRightRadius: radii.control,
    borderBottomRightRadius: radii.control,
    backgroundColor: colors.textPrimary
  },
  disabled: { opacity: feedback.disabledOpacity },
  pressed: { opacity: feedback.pressedOpacity },
  filter: { paddingTop: spacing.sm },
  tools: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionBar: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.lg, paddingTop: spacing.sm },
  sectionToggle: { flex: 1, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sectionTitle: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
  count: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  tool: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  empty: { minHeight: 240, flex: 1 },
  note: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, fontSize: typography.metaSize + 1, color: colors.textMuted }
}))
