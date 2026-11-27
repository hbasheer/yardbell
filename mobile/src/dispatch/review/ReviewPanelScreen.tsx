import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react-native'
import { useCallback } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DiffList } from '../../code/DiffList'
import { statsWord } from '../../changes/model'
import type { PairedServer } from '../../servers/store'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { NavBarButton } from '../../ui/NavBarButton'
import { LoadErrorState, StateView } from '../../ui/StateView'
import { colors, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { reviewChanges, reviewFilePage, scanFiles, scanFilePage } from '../api'
import type { ReviewFileStat } from '../types'
import { changeLetter, changeTotals, changeWord, diffNote, fileWord, MOVED_WORDS } from './model'
import { usePagedFile } from './usePagedFile'

export type ReviewPanel = 'changes' | 'files'

type Props = { server: PairedServer; conversation: string; card: number; panel: ReviewPanel; file: string }

const letterColor = (file: ReviewFileStat) =>
  file.untracked || file.status === 'A' ? colors.gitDecorationAdded : file.status === 'D' ? colors.gitDecorationDeleted : colors.gitDecorationModified

const splitPath = (path: string) => {
  const at = path.lastIndexOf('/')
  return { name: path.slice(at + 1), dir: at < 0 ? '' : path.slice(0, at) }
}

export function ReviewPanelScreen({ server, conversation, card, panel, file }: Props) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scan = panel === 'files'
  const open = useCallback((path: string) => router.push({ pathname: '/dispatch/[server]/review/[id]/[card]', params: { server: server.id, id: conversation, card: String(card), panel, file: path } } as never), [router, server.id, conversation, card, panel])

  let body
  let title = scan ? 'Files' : 'Changes'
  let subtitle = ''
  if (file) {
    const { name, dir } = splitPath(file)
    title = name
    subtitle = dir
    body = <FileBody server={server} conversation={conversation} card={card} scan={scan} file={file} />
  } else if (scan) {
    body = <ScanList server={server} conversation={conversation} card={card} onOpen={open} />
  } else {
    body = <ChangesList server={server} conversation={conversation} card={card} onOpen={open} />
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <NavBar leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />} title={title} subtitle={subtitle || undefined} />
      {body}
    </View>
  )
}

type ListProps = { server: PairedServer; conversation: string; card: number; onOpen: (path: string) => void }

function ChangesList({ server, conversation, card, onOpen }: ListProps) {
  const query = useQuery({
    queryKey: ['review-changes', server.id, conversation, card],
    queryFn: () => reviewChanges(server, conversation, card),
    retry: false,
    refetchOnWindowFocus: false,
    meta: { serverId: server.id }
  })
  const list = query.data
  if (query.error) return <LoadErrorState message={query.error instanceof Error ? query.error.message : 'Could not read the changes.'} onRetry={() => query.refetch()} />
  if (!list) return <StateView loading title="Reading the changes" />
  const totals = changeTotals(list.files)
  return (
    <FlatList
      data={list.files}
      keyExtractor={(f) => f.path}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={
        <View style={styles.notes}>
          <Text style={styles.totals}>
            {fileWord(totals.files)}
            {totals.files ? <Text>{'  '}<Text style={styles.added}>{`+${totals.added}`}</Text>{' '}<Text style={styles.removed}>{`-${totals.removed}`}</Text></Text> : null}
          </Text>
          <Text style={styles.note}>{diffNote(list)}</Text>
          {list.moved ? <Text style={styles.warn}>{MOVED_WORDS}</Text> : null}
          {list.truncated ? <Text style={styles.note}>Only part of a very large change is listed.</Text> : null}
        </View>
      }
      ListEmptyComponent={<Text style={styles.empty}>No changes.</Text>}
      renderItem={({ item }) => {
        const parts = splitPath(item.path)
        const stats = item.binary ? 'binary' : statsWord(item)
        return (
          <ListGroup style={styles.rowGroup}>
            <ListRow
              title={parts.name}
              subtitle={[item.old_path ? `${item.old_path} → ${item.path}` : parts.dir, stats].filter(Boolean).join('  ')}
              subtitleLines={1}
              leading={<Text style={[styles.letter, { color: letterColor(item) }]}>{changeLetter(item)}</Text>}
              accessory={<ChevronRight size={17} color={colors.textMuted} strokeWidth={2.2} />}
              accessibilityLabel={`${parts.name}, ${changeWord(item)}${stats ? `, ${stats}` : ''}`}
              onPress={() => onOpen(item.path)}
            />
          </ListGroup>
        )
      }}
    />
  )
}

function ScanList({ server, conversation, card, onOpen }: ListProps) {
  const query = useQuery({
    queryKey: ['scan-files', server.id, conversation, card],
    queryFn: () => scanFiles(server, conversation, card),
    retry: false,
    refetchOnWindowFocus: false,
    meta: { serverId: server.id }
  })
  const list = query.data
  if (query.error) return <LoadErrorState message={query.error instanceof Error ? query.error.message : 'Could not read the files.'} onRetry={() => query.refetch()} />
  if (!list) return <StateView loading title="Reading the files" />
  return (
    <FlatList
      data={list.files}
      keyExtractor={(f) => f}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={
        <View style={styles.notes}>
          <Text style={styles.totals}>{fileWord(list.files.length)}</Text>
          <Text style={styles.note}>{`The files the findings point at, read from ${list.folder} as it is now.`}</Text>
        </View>
      }
      ListEmptyComponent={<Text style={styles.empty}>No finding points at a file.</Text>}
      renderItem={({ item }) => {
        const parts = splitPath(item)
        return (
          <ListGroup style={styles.rowGroup}>
            <ListRow
              title={parts.name}
              subtitle={parts.dir || undefined}
              subtitleLines={1}
              leading={<FileText size={17} color={colors.textMuted} strokeWidth={2} />}
              accessory={<ChevronRight size={17} color={colors.textMuted} strokeWidth={2.2} />}
              onPress={() => onOpen(item)}
            />
          </ListGroup>
        )
      }}
    />
  )
}

function FileBody({ server, conversation, card, scan, file }: { server: PairedServer; conversation: string; card: number; scan: boolean; file: string }) {
  const fetchPage = useCallback(
    (from: number) => (scan ? scanFilePage : reviewFilePage)(server, conversation, card, { file, from }),
    [server, conversation, card, scan, file]
  )
  const { loaded, error, loadingMore, more, retry } = usePagedFile(fetchPage, `${scan}:${file}`)
  if (error) return <LoadErrorState message={error} onRetry={retry} />
  if (!loaded) return <StateView loading title={scan ? 'Reading the file' : 'Reading the diff'} />
  const { first, pages } = loaded
  return (
    <DiffList
      style={styles.diff}
      lines={pages.lines}
      next={pages.next}
      total={pages.total}
      binary={first.binary}
      cut={first.cut}
      notes={first.notes}
      loadingMore={loadingMore}
      onMore={more}
    />
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  diff: { flex: 1 },
  listContent: { paddingBottom: spacing.xl },
  notes: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
  totals: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  note: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  warn: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.statusAmber },
  added: { color: colors.gitDecorationAdded },
  removed: { color: colors.gitDecorationDeleted },
  empty: { padding: spacing.lg, fontSize: 14, color: colors.textSecondary },
  rowGroup: { marginHorizontal: spacing.lg, marginBottom: spacing.xs },
  letter: { fontFamily: typography.monoFamily, fontSize: typography.metaSize, fontWeight: '700' }
}))
