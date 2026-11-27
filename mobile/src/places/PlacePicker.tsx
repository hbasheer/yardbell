import { ChevronLeft, FolderOpen, GitBranch } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { SectionList, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PairedServer } from '../servers/store'
import { useServerState } from '../state/useServerState'
import { ListGroup } from '../ui/ListGroup'
import { ListRow } from '../ui/ListRow'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { SearchField } from '../ui/SearchField'
import { LoadErrorState, NoMatchState, StateView } from '../ui/StateView'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import { filterGroups, placeGroups, type Place } from './model'

export type PlacePickerProps = {
  server: PairedServer
  machine: string
  title?: string
  onPick: (place: Place) => void
  onBack: () => void
}

export function PlacePicker({ server, machine, title = 'Pick a folder', onPick, onBack }: PlacePickerProps) {
  useColorScheme()
  const insets = useSafeAreaInsets()
  const live = useServerState(server)
  const [query, setQuery] = useState('')
  const all = useMemo(() => placeGroups(live.state, machine), [live.state, machine])
  const groups = useMemo(() => filterGroups(all, query), [all, query])

  let empty = null
  if (!live.state) {
    empty =
      live.connection === 'unreachable' ? (
        <LoadErrorState message="Can't reach this server." onRetry={live.reconnect} />
      ) : (
        <StateView loading title="Loading folders" />
      )
  } else if (all.length === 0) {
    empty = <StateView icon={FolderOpen} title="No folders" message={`${machine} has no folders or sessions to open yet.`} />
  } else if (groups.length === 0) {
    empty = <NoMatchState message={`No folder matches "${query.trim()}".`} onClear={() => setQuery('')} />
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={onBack} />}
        title={title}
        subtitle={machine}
      />
      {all.length > 0 ? (
        <View style={styles.search}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search folders" />
        </View>
      ) : null}
      <SectionList
        sections={groups.map((group) => ({ key: group.key, title: group.title, data: [group.places] }))}
        keyExtractor={(section) => section[0]?.path ?? 'empty'}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, flexGrow: 1 }}
        ListEmptyComponent={empty ? <View style={styles.empty}>{empty}</View> : undefined}
        renderSectionHeader={({ section }) => (
          <View style={styles.header}>
            <Text style={styles.headerText} numberOfLines={1}>
              {section.title}
            </Text>
          </View>
        )}
        renderItem={({ item: places }) => (
          <ListGroup surface="page" style={styles.group}>
            {places.map((place) => (
              <ListRow
                key={place.path}
                title={place.label}
                subtitle={place.path}
                subtitleMono
                subtitleLines={1}
                leading={<FolderOpen size={17} color={colors.textSecondary} strokeWidth={2} />}
                accessory={place.branch ? <Branch name={place.branch} /> : undefined}
                value={place.sessions > 0 ? String(place.sessions) : undefined}
                onPress={() => onPick(place)}
                accessibilityLabel={`${place.label}, ${place.path}`}
              />
            ))}
          </ListGroup>
        )}
      />
    </View>
  )
}

function Branch({ name }: { name: string }) {
  useColorScheme()
  return (
    <View style={styles.branch}>
      <GitBranch size={12} color={colors.textMuted} strokeWidth={2} />
      <Text style={styles.branchText} numberOfLines={1}>
        {name}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  search: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  header: { paddingHorizontal: spacing.lg + spacing.sm, paddingTop: spacing.lg, paddingBottom: 6 },
  headerText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  group: { marginHorizontal: spacing.lg },
  empty: { minHeight: 360, flex: 1 },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: 110 },
  branchText: { fontSize: 12, color: colors.textMuted, flexShrink: 1 }
}))
