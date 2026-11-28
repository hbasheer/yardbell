import * as Clipboard from 'expo-clipboard'
import { Check, ChevronLeft, ChevronRight, CircleAlert, Copy, FileText, Folder, FolderOpen, ListCollapse, MoreHorizontal, RefreshCw } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { statusLetter, absolutePath, rootName } from '../changes/model'
import { statusColor } from '../changes/ChangeRow'
import { Segmented } from '../inbox/Segmented'
import { usePersisted } from '../machine/usePersisted'
import type { PairedServer } from '../servers/store'
import { ActionSheet, type ActionSheetAction } from '../ui/ActionSheet'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { PullDownMenu } from '../ui/PullDownMenu'
import { SearchField } from '../ui/SearchField'
import { LoadErrorState, NoMatchState, StateView } from '../ui/StateView'
import { triggerMediumImpact } from '../ui/haptics'
import { colors, feedback, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { listFiles, type SearchMode } from './api'
import { machineHref } from '../home/presentation'
import { fileHref, flattenTree, moreWord, splitResult, type Listing, type TreeRow } from './model'
import { useChangeStatuses, useFileSearch } from './useFiles'

const INDENT = 18
const parseDotfiles = (raw: string | null) => raw !== '0'
const serializeDotfiles = (on: boolean) => (on ? '1' : '0')

const SEGMENTS: { id: SearchMode; label: string }[] = [
  { id: 'names', label: 'Names' },
  { id: 'contents', label: 'Contents' }
]

type RowProps = { row: TreeRow; onToggle: (path: string) => void; onOpen: (path: string) => void; onMenu: (path: string) => void }

const Row = memo(function Row({ row, onToggle, onOpen, onMenu }: RowProps) {
  useColorScheme()
  const pad = spacing.lg + Math.min(row.depth * INDENT, INDENT * 8)
  if (row.kind === 'loading') {
    return (
      <View style={[styles.row, { paddingLeft: pad + 22 }]}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.muted}>Loading</Text>
      </View>
    )
  }
  if (row.kind === 'error') {
    return (
      <View style={[styles.row, { paddingLeft: pad + 22 }]} accessibilityRole="alert">
        <CircleAlert size={14} color={colors.statusRed} strokeWidth={2} />
        <Text style={styles.error} numberOfLines={3}>
          {row.message}
        </Text>
      </View>
    )
  }
  if (row.kind === 'more') {
    return (
      <View style={[styles.row, { paddingLeft: pad + 22 }]}>
        <Text style={styles.muted}>Only the first entries are shown.</Text>
      </View>
    )
  }
  const tint = row.status ? statusColor(row.status) : undefined
  if (row.kind === 'dir') {
    const Icon = row.open ? FolderOpen : Folder
    return (
      <Pressable
        onPress={() => onToggle(row.path)}
        accessibilityRole="button"
        accessibilityLabel={row.name}
        accessibilityState={{ expanded: row.open }}
        style={({ pressed }) => [styles.row, { paddingLeft: pad }, pressed && styles.pressed]}
      >
        <ChevronRight size={14} color={colors.textMuted} strokeWidth={2.2} style={row.open ? styles.turned : undefined} />
        <Icon size={16} color={colors.textMuted} strokeWidth={2} />
        <Text style={[styles.name, tint ? { color: tint } : null]} numberOfLines={1}>
          {row.name}
        </Text>
        {tint ? <View style={[styles.dot, { backgroundColor: tint }]} /> : null}
      </Pressable>
    )
  }
  return (
    <Pressable
      onPress={() => onOpen(row.path)}
      onLongPress={() => onMenu(row.path)}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={row.name}
      style={({ pressed }) => [styles.row, { paddingLeft: pad }, pressed && styles.pressed]}
    >
      <View style={styles.chevronSpace} />
      <FileText size={16} color={colors.textMuted} strokeWidth={2} />
      <Text style={[styles.name, tint ? { color: tint } : null]} numberOfLines={1}>
        {row.name}
      </Text>
      {row.status && tint ? <Text style={[styles.letter, { color: tint }]}>{statusLetter(row.status)}</Text> : null}
    </Pressable>
  )
})

export function FilesScreen({ server, machine, root, multipleServers }: { server: PairedServer; machine: string; root: string; multipleServers: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [dotfiles, setDotfiles] = usePersisted('yardbell:files-dotfiles', true, parseDotfiles, serializeDotfiles)
  const [listings, setListings] = useState<Map<string, Listing>>(new Map())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [mode, setMode] = useState<SearchMode>('names')
  const [find, setFind] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const moreRef = useRef<HostInstance>(null)
  const { statuses, refetch: refetchStatuses } = useChangeStatuses(server, machine, root)
  const search = useFileSearch(server, machine, root, find, mode)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadDir = useCallback(
    (path: string) =>
      listFiles(server, machine, root, path)
        .then((listing): Listing => ({ entries: listing.entries, more: listing.more }))
        .catch((e): Listing => ({ error: e instanceof Error ? e.message : String(e) }))
        .then((next) => {
          if (mounted.current) setListings((current) => new Map(current).set(path, next))
        }),
    [server, machine, root]
  )

  useEffect(() => {
    setListings(new Map())
    setOpen(new Set())
    loadDir('')
  }, [loadDir])

  const toggle = useCallback(
    (path: string) => {
      setOpen((current) => {
        const next = new Set(current)
        if (next.has(path)) next.delete(path)
        else {
          next.add(path)
          if (!listings.get(path)?.entries) loadDir(path)
        }
        return next
      })
    },
    [listings, loadDir]
  )

  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([loadDir(''), ...[...open].map(loadDir), refetchStatuses()])
    if (mounted.current) setRefreshing(false)
  }

  const openFile = useCallback(
    (path: string, withFind?: string) => router.push(fileHref({ serverId: server.id, machine, root, path, find: withFind }) as never),
    [router, server.id, machine, root]
  )
  const onOpen = useCallback((path: string) => openFile(path), [openFile])
  const onMenu = useCallback((path: string) => {
    triggerMediumImpact()
    setMenuPath(path)
  }, [])

  const rows = useMemo(() => flattenTree(listings, open, dotfiles, statuses ?? new Map()), [listings, open, dotfiles, statuses])

  const copy = (text: string) => {
    Clipboard.setStringAsync(text).catch((error) => console.error('Could not copy', error))
  }

  const moreActions: ActionSheetAction[] = [
    { label: 'Show Dotfiles', icon: Check, checked: dotfiles, skipAutoClose: true, onPress: () => setDotfiles(!dotfiles) },
    { label: 'Copy Path', icon: Copy, onPress: () => copy(root) }
  ]
  const menuActions = (path: string): ActionSheetAction[] => [
    { label: 'Open', icon: FileText, onPress: () => openFile(path, mode === 'contents' && find.trim() ? find.trim() : undefined) },
    { label: 'Copy path', icon: Copy, onPress: () => copy(absolutePath(root, path)) },
    { label: 'Copy relative path', icon: Copy, onPress: () => copy(path) }
  ]

  const searching = find.trim() !== ''
  const tree = listings.get('')
  const subtitle = `${machine}${multipleServers && server.machine !== machine ? ` · ${server.machine}` : ''}`

  let body
  if (searching) {
    const matches = search.result?.matches ?? []
    body = (
      <FlatList
        data={matches}
        keyExtractor={(path) => path}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + spacing.xl }}
        ListFooterComponent={search.result?.more ? <Text style={styles.footnote}>{moreWord(mode)}</Text> : <View />}
        ListEmptyComponent={
          search.error ? (
            <LoadErrorState message={search.error instanceof Error ? search.error.message : 'The search failed.'} />
          ) : search.waiting || !search.result ? (
            <StateView loading title="Searching" />
          ) : (
            <NoMatchState message={mode === 'contents' ? 'No file contains that.' : 'No file has that name.'} />
          )
        }
        renderItem={({ item }) => {
          const { name, dir } = splitResult(item)
          const status = statuses?.get(item)
          return (
            <Pressable
              onPress={() => openFile(item, mode === 'contents' ? search.settled : undefined)}
              onLongPress={() => onMenu(item)}
              delayLongPress={350}
              accessibilityRole="button"
              accessibilityLabel={item}
              style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
            >
              <FileText size={16} color={colors.textMuted} strokeWidth={2} />
              <View style={styles.hitText}>
                <Text style={[styles.name, status ? { color: statusColor(status) } : null]} numberOfLines={1}>
                  {name}
                </Text>
                {dir ? (
                  <Text style={styles.dir} numberOfLines={1}>
                    {dir}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )
        }}
      />
    )
  } else if (!tree) {
    body = <StateView loading title="Reading the folder" />
  } else if (tree.error !== undefined) {
    body = <LoadErrorState message={tree.error} onRetry={refresh} />
  } else {
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + spacing.xl }}
        ListEmptyComponent={<Text style={styles.footnote}>This folder has nothing to show.</Text>}
        renderItem={({ item }) => <Row row={item} onToggle={toggle} onOpen={onOpen} onMenu={onMenu} />}
        initialNumToRender={30}
        windowSize={9}
      />
    )
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace(machineHref({ serverId: server.id, machine }) as never))} />}
        title={rootName(root)}
        subtitle={subtitle}
        refreshing={refreshing}
        trailing={
          <>
            <NavBarButton icon={ListCollapse} accessibilityLabel="Collapse All" disabled={open.size === 0} onPress={() => setOpen(new Set())} />
            <NavBarButton icon={RefreshCw} accessibilityLabel="Refresh Explorer" disabled={refreshing} onPress={refresh} />
            <View ref={moreRef} collapsable={false}>
              <NavBarButton icon={MoreHorizontal} accessibilityLabel="More Explorer Actions" active={moreOpen} onPress={() => setMoreOpen(true)} />
            </View>
          </>
        }
      />
      <Segmented segments={SEGMENTS} value={mode} onChange={setMode} />
      <View style={styles.search}>
        <SearchField value={find} onChangeText={setFind} placeholder={mode === 'contents' ? 'Search file contents' : 'Filter files by name'} accessibilityLabel="Search files" />
      </View>
      {body}
      <PullDownMenu visible={moreOpen} anchorRef={moreRef} groups={[moreActions]} onClose={() => setMoreOpen(false)} />
      <ActionSheet visible={menuPath !== null} title={menuPath ?? undefined} actions={menuPath ? menuActions(menuPath) : []} onClose={() => setMenuPath(null)} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  search: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  row: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: spacing.lg },
  pressed: { opacity: feedback.pressedOpacity },
  turned: { transform: [{ rotate: '90deg' }] },
  chevronSpace: { width: 14 },
  name: { flexShrink: 1, fontSize: typography.bodySize, color: colors.textPrimary },
  letter: { marginLeft: 'auto', fontSize: typography.metaSize, fontWeight: '700' },
  dot: { marginLeft: 'auto', width: 6, height: 6, borderRadius: 3 },
  muted: { fontSize: typography.metaSize, color: colors.textMuted },
  error: { flex: 1, fontSize: typography.metaSize, color: colors.statusRed },
  hit: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  hitText: { flex: 1, minWidth: 0 },
  dir: { fontSize: typography.metaSize, color: colors.textMuted },
  footnote: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, fontSize: typography.metaSize + 1, color: colors.textMuted }
}))
