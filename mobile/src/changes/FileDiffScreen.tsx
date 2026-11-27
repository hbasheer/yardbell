import { useRouter } from 'expo-router'
import { Check, ChevronDown, ChevronLeft, ChevronUp } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DiffList } from '../code/DiffList'
import type { PairedServer } from '../servers/store'
import { BottomDrawer } from '../ui/BottomDrawer'
import { ListGroup } from '../ui/ListGroup'
import { ListRow } from '../ui/ListRow'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { SheetHeader } from '../ui/SheetHeader'
import { LoadErrorState, StateView } from '../ui/StateView'
import { colors, pressedStyle, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { changeDiff, type ChangeDiff } from './api'
import { statusColor } from './ChangeRow'
import { appendPage, fileKey, neighbour, ordered, splitPath, statsWord, statusLetter, type DiffPages } from './model'
import { useChangesList } from './useChangesActions'

type Loaded = { diff: ChangeDiff; pages: DiffPages }

function useDiff(server: PairedServer, machine: string, root: string, path: string, staged: boolean) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const token = useRef(0)
  const fetching = useRef(false)

  const first = useCallback(() => {
    const mine = ++token.current
    fetching.current = false
    setLoaded(null)
    setError(null)
    setLoadingMore(false)
    changeDiff(server, machine, { root, path, staged })
      .then((diff) => {
        if (token.current === mine) setLoaded({ diff, pages: appendPage(null, diff) })
      })
      .catch((e) => {
        if (token.current === mine) setError(e instanceof Error ? e.message : String(e))
      })
  }, [server, machine, root, path, staged])

  useEffect(() => {
    first()
    return () => {
      token.current += 1
    }
  }, [first])

  const more = useCallback(() => {
    if (!loaded || fetching.current) return
    const mine = token.current
    fetching.current = true
    setLoadingMore(true)
    changeDiff(server, machine, { root, path, staged, from: loaded.pages.next })
      .then((page) => {
        if (token.current === mine) setLoaded((current) => (current ? { diff: current.diff, pages: appendPage(current.pages, page) } : current))
      })
      .catch((e) => {
        if (token.current === mine) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (token.current === mine) {
          fetching.current = false
          setLoadingMore(false)
        }
      })
  }, [loaded, server, machine, root, path, staged])

  return { loaded, error, loadingMore, more, retry: first }
}

export function FileDiffScreen({ server, machine, root, path, staged }: { server: PairedServer; machine: string; root: string; path: string; staged: boolean }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [sheet, setSheet] = useState(false)
  const list = useChangesList(server, machine, root, false)
  const files = useMemo(() => ordered(list.data?.files ?? []), [list.data])
  const current = { path, staged }
  const previous = neighbour(files, current, -1)
  const next = neighbour(files, current, 1)
  const { loaded, error, loadingMore, more, retry } = useDiff(server, machine, root, path, staged)

  const go = (file: { path: string; staged: boolean }) => router.setParams({ path: file.path, staged: file.staged ? '1' : '0' })
  const { name, dir } = splitPath(path)
  const diff = loaded?.diff
  const subtitle = [staged ? 'Staged' : 'Working tree', diff ? statsWord(diff) : ''].filter(Boolean).join(' · ')
  const renamedFrom = diff?.old_path && diff.old_path !== path ? diff.old_path : null

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        center={
          <Pressable
            onPress={() => setSheet(true)}
            disabled={files.length < 2}
            accessibilityRole="button"
            accessibilityLabel={`${name}, show changed files`}
            style={({ pressed }) => [styles.title, pressed && pressedStyle]}
          >
            <View style={styles.titleRow}>
              <Text style={styles.titleText} numberOfLines={1}>
                {name}
              </Text>
              {files.length > 1 ? <ChevronDown size={14} color={colors.textSecondary} strokeWidth={2.2} /> : null}
            </View>
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          </Pressable>
        }
        trailing={
          <>
            <NavBarButton icon={ChevronUp} accessibilityLabel="Previous file" disabled={!previous} onPress={() => previous && go(previous)} />
            <NavBarButton icon={ChevronDown} accessibilityLabel="Next file" disabled={!next} onPress={() => next && go(next)} />
          </>
        }
      />
      {error ? (
        <LoadErrorState message={error} onRetry={retry} />
      ) : !loaded ? (
        <StateView loading title="Reading the diff" />
      ) : (
        <DiffList
          style={styles.list}
          lines={loaded.pages.lines}
          next={loaded.pages.next}
          total={loaded.pages.total}
          binary={loaded.diff.binary}
          cut={loaded.diff.cut}
          notes={loaded.diff.notes}
          loadingMore={loadingMore}
          onMore={more}
          header={
            <View style={styles.pathRow}>
              <Text style={styles.path} numberOfLines={1}>
                {renamedFrom ? `${renamedFrom} → ${path}` : dir || path}
              </Text>
            </View>
          }
        />
      )}
      <BottomDrawer visible={sheet} onClose={() => setSheet(false)}>
        <SheetHeader title={`${files.length} changed files`} onClose={() => setSheet(false)} />
        <View style={styles.sheetBody}>
          <ListGroup>
            {files.map((file) => {
              const here = fileKey(file) === fileKey(current)
              const parts = splitPath(file.path)
              return (
                <ListRow
                  key={fileKey(file)}
                  title={parts.name}
                  subtitle={[file.staged ? 'Staged' : 'Changes', parts.dir].filter(Boolean).join(' · ')}
                  subtitleLines={1}
                  leading={<Text style={[styles.letter, { color: statusColor(file.status) }]}>{statusLetter(file.status)}</Text>}
                  accessory={here ? <Check size={17} color={colors.accentBlue} strokeWidth={2.4} /> : undefined}
                  accessibilityLabel={`${parts.name}, ${file.staged ? 'staged' : 'unstaged'}${here ? ', current' : ''}`}
                  onPress={() => {
                    if (!here) go(file)
                    setSheet(false)
                  }}
                />
              )
            })}
          </ListGroup>
        </View>
      </BottomDrawer>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  list: { flex: 1 },
  title: { alignItems: 'center', minHeight: 44, justifyContent: 'center', maxWidth: '100%' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: '100%' },
  titleText: { flexShrink: 1, color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  subtitle: { color: colors.textSecondary, fontSize: 12 },
  pathRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  path: { fontSize: typography.metaSize, fontFamily: typography.monoFamily, color: colors.textMuted },
  sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  letter: { fontFamily: typography.monoFamily, fontSize: typography.metaSize, fontWeight: '700' }
}))
