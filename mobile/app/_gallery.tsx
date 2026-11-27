import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Bell,
  ChevronLeft,
  Copy,
  Gauge,
  LayoutList,
  MoreHorizontal,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  Plus,
  Trash2
} from 'lucide-react-native'
import { useNewSession } from '@/new-session/NewSessionProvider'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { AgentGlyph } from '@/ui/AgentGlyph'
import { BottomSearchBar } from '@/ui/BottomSearchBar'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { Fab } from '@/ui/Fab'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { NavBar, NavBarSubtitleText } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { PageTitle } from '@/ui/PageTitle'
import { PullDownMenu } from '@/ui/PullDownMenu'
import { SectionHeader } from '@/ui/SectionHeader'
import { SheetHeader } from '@/ui/SheetHeader'
import { BottomDrawer } from '@/ui/BottomDrawer'
import { LoadErrorState, NoMatchState, OfflineState, StateView } from '@/ui/StateView'
import { StatusDot } from '@/ui/StatusDot'
import { SwipeCell } from '@/ui/SwipeCell'
import { TabBar } from '@/ui/TabBar'
import { TabStrip } from '@/ui/TabStrip'
import {
  colors,
  radii,
  setAppearancePreference,
  spacing,
  themedStyleSheet,
  useAppearancePreference,
  useColorScheme
} from '@/ui/theme'

const SECTIONS = ['navigation', 'glyphs', 'lists', 'states', 'bars'] as const
type Section = (typeof SECTIONS)[number]
type Overlay = 'action' | 'pulldown' | 'confirm' | 'drawer'

function isOverlay(value: unknown): value is Overlay {
  return value === 'action' || value === 'pulldown' || value === 'confirm' || value === 'drawer'
}

function Block({ title, children, flush = false }: { title: string; children: ReactNode; flush?: boolean }) {
  useColorScheme()
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>{title}</Text>
      <View style={[styles.blockBody, flush && styles.blockFlush]}>{children}</View>
    </View>
  )
}

export default function Gallery() {
  useColorScheme()
  const params = useLocalSearchParams<{ section?: string; open?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const preference = useAppearancePreference()
  const [overlay, setOverlay] = useState<Overlay | null>(isOverlay(params.open) ? params.open : null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('feed')
  const [log, setLog] = useState('')
  const menuAnchor = useRef(null)
  const newSession = useNewSession()

  useEffect(() => {
    if (isOverlay(params.open)) setOverlay(params.open)
    if (params.open === 'new-session') newSession.open()
    if (params.open === 'new-session-preset') newSession.open({ machine: 'hp', folder: '/home/dev/Projects/feedgest/app' })
  }, [params.open])

  if (!__DEV__) return <Redirect href="/" />

  const only = SECTIONS.find((section) => section === params.section) as Section | undefined
  const show = (section: Section) => only === undefined || only === section
  const close = () => setOverlay(null)

  const actions: ActionSheetAction[] = [
    { label: 'Open', icon: SquareTerminal, onPress: () => setLog('Open') },
    { label: 'Copy branch', icon: Copy, onPress: () => setLog('Copy branch') },
    { label: 'Stop session', icon: Trash2, destructive: true, hint: 'Ends the agent in this session', onPress: () => setLog('Stop') }
  ]
  const menuGroups: ActionSheetAction[][] = [
    [
      { label: 'Session details', icon: LayoutList, onPress: () => setLog('Details') },
      { label: 'Text size', icon: SlidersHorizontal, status: '13', onPress: () => setLog('Text size') }
    ],
    [{ label: 'Stop session', icon: Trash2, destructive: true, onPress: () => setLog('Stop') }]
  ]

  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl * 2 }}>
        <View style={styles.controls}>
          {(['system', 'light', 'dark'] as const).map((choice) => (
            <Text key={choice} style={[styles.chip, preference === choice && styles.chipActive]} onPress={() => void setAppearancePreference(choice)}>
              {choice}
            </Text>
          ))}
          {SECTIONS.map((section) => (
            <Text key={section} style={[styles.chip, only === section && styles.chipActive]} onPress={() => router.setParams({ section: only === section ? '' : section })}>
              {section}
            </Text>
          ))}
        </View>
        {log ? <Text style={styles.log}>Last action: {log}</Text> : null}

        {show('navigation') ? (
          <>
            <Block title="NavBar: back, title, status line, trailing" flush>
              <NavBar
                leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => {}} />}
                title="hp"
                subtitle={
                  <>
                    <StatusDot state="connected" />
                    <NavBarSubtitleText>Connected</NavBarSubtitleText>
                  </>
                }
                trailing={
                  <>
                    <NavBarButton icon={Bell} accessibilityLabel="Notifications" onPress={() => {}} badge={{ count: 120, color: colors.accentBlue }} />
                    <NavBarButton
                      icon={MoreHorizontal}
                      accessibilityLabel="More"
                      onPress={() => setOverlay('pulldown')}
                    />
                  </>
                }
              />
            </Block>
            <Block title="NavBar: refreshing, active button" flush>
              <NavBar
                title="A very long machine name that has to truncate in the bar"
                subtitle="mac-mini"
                refreshing
                trailing={<NavBarButton icon={Settings} accessibilityLabel="Settings" onPress={() => {}} active />}
              />
            </Block>
            <Block title="PageTitle">
              <PageTitle
                title="Home"
                subtitle={
                  <>
                    <StatusDot state="connecting" />
                    <NavBarSubtitleText>2 machines</NavBarSubtitleText>
                  </>
                }
              />
            </Block>
            <Block title="Sheet header">
              <SheetHeader
                title="New session"
                subtitle="hp"
                leading={{ label: 'Cancel', onPress: () => {} }}
                trailing={{ label: 'Start', onPress: () => {} }}
              />
              <SheetHeader title="Tabs" onClose={() => {}} />
            </Block>
          </>
        ) : null}

        {show('glyphs') ? (
          <Block title="AgentGlyph list (12) / tab (10) and StatusDot">
            <View style={styles.row}>
              {(['active', 'blocked', 'idle'] as const).map((activity) => (
                <View key={activity} style={styles.cell}>
                  <AgentGlyph activity={activity} />
                  <AgentGlyph activity={activity} size="tab" />
                  <Text style={styles.small}>{activity}</Text>
                </View>
              ))}
              <View style={styles.cell}>
                <AgentGlyph activity="active" stopped="exited" />
                <AgentGlyph activity="active" stopped="exited" size="tab" />
                <Text style={styles.small}>stopped</Text>
              </View>
            </View>
            <View style={styles.row}>
              {(['connected', 'connecting', 'reconnecting', 'disconnected', 'unreachable', 'warning'] as const).map((state) => (
                <View key={state} style={styles.cell}>
                  <StatusDot state={state} />
                  <Text style={styles.small}>{state}</Text>
                </View>
              ))}
            </View>
          </Block>
        ) : null}

        {show('lists') ? (
          <View style={styles.listPad}>
            <SectionHeader title="Needs you" trailing="See all" first />
            <ListGroup surface="page">
              <ListRow
                key="a"
                leading={<AgentGlyph activity="blocked" />}
                title="yardbell"
                subtitle="mobile-app"
                subtitleMono
                value="hp"
                navigates
                onPress={() => {}}
              />
              <ListRow key="b" leading={<AgentGlyph activity="active" />} title="feedgest" subtitle="Working on tests" navigates onPress={() => {}} />
            </ListGroup>
            <SectionHeader title="Sheet-style rows (collapsible)" expanded onToggle={() => {}} />
            <ListGroup>
              <ListRow key="1" title="Plain row" onPress={() => {}} />
              <ListRow key="2" title="With value and chevron" value="This computer" navigates onPress={() => {}} />
              <ListRow key="3" title="Picked option" selected onPress={() => {}} />
              <ListRow key="4" title="Other option" selected={false} onPress={() => {}} />
              <ListRow key="5" title="Accent action" accent onPress={() => {}} />
              <ListRow key="6" title="Destructive action" destructive onPress={() => {}} />
              <ListRow key="7" title="Disabled" disabled onPress={() => {}} />
              <ListRow key="8" title="A long folder name that has to be cut off before it pushes the value away" value="main" />
            </ListGroup>
            <SectionHeader title="SwipeCell" />
            <ListGroup surface="page">
              <SwipeCell
                key="swipe"
                trailing={{
                  label: 'Stop',
                  accessibilityLabel: 'Stop session',
                  icon: Trash2,
                  background: colors.statusRed,
                  foreground: colors.onStatusRed,
                  onPress: () => setLog('Swipe stop')
                }}
              >
                {(guard) => <ListRow title="Swipe me left" subtitle="Stop is behind the row" onPress={guard(() => setLog('Row press'))} />}
              </SwipeCell>
            </ListGroup>
          </View>
        ) : null}

        {show('states') ? (
          <>
            <Block title="StateView: loading" flush>
              <View style={styles.stateBox}>
                <StateView loading title="Loading sessions" />
              </View>
            </Block>
            <Block title="OfflineState" flush>
              <View style={styles.stateBox}>
                <OfflineState machineName="mac-mini" onReconnect={() => {}} />
              </View>
            </Block>
            <Block title="LoadErrorState" flush>
              <View style={styles.stateBox}>
                <LoadErrorState message="The server did not answer in time." details="GET /state: timeout after 10s" onRetry={() => {}} />
              </View>
            </Block>
            <Block title="StateView: empty" flush>
              <View style={styles.stateBox}>
                <StateView icon={SquareTerminal} title="No sessions" message="Start one with the + button." action={{ label: 'New session', onPress: () => {} }} />
              </View>
            </Block>
            <Block title="NoMatchState" flush>
              <View style={styles.stateBox}>
                <NoMatchState message="Nothing matches 'zzz'." onClear={() => {}} />
              </View>
            </Block>
          </>
        ) : null}

        {show('bars') ? (
          <>
            <Block title="TabBar (Agents badge 120)" flush>
              <TabBar
                bottomInset={0}
                active={tab}
                onSelect={setTab}
                tabs={[
                  { id: 'feed', label: 'Feed', icon: LayoutList },
                  { id: 'sessions', label: 'Sessions', icon: SquareTerminal, badge: 120 },
                  { id: 'usage', label: 'Usage', icon: Gauge }
                ]}
              />
            </Block>
            <Block title="TabStrip" flush>
              <TabStrip
                title="yardbell"
                glyph={{ activity: 'blocked' }}
                count={3}
                othersNeedYou
                hasPrevious
                hasNext
                onStep={(direction) => setLog(`Step ${direction}`)}
                onOpenActions={() => setOverlay('action')}
                onOpenTabs={() => setLog('Tabs')}
                onNew={() => setLog('New')}
              />
            </Block>
            <Block title="Fab (and disabled with hint)" flush>
              <View style={styles.fabBox}>
                <Fab visible disabled={false} accessibilityLabel="New session" bottom={16} onPress={() => setLog('Fab')} />
              </View>
              <View style={styles.fabBox}>
                <Fab visible disabled accessibilityLabel="New session" disabledHint="Pair a server to start a session." bottom={16} onPress={() => {}} />
              </View>
            </Block>
            <Block title="BottomSearchBar (filter badge 2)" flush>
              <View style={styles.searchBox}>
                <BottomSearchBar
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search"
                  bottomInset={0}
                  leading={{ icon: SlidersHorizontal, accessibilityLabel: 'Options', onPress: () => {}, badge: 2 }}
                  primary={{ icon: Plus, accessibilityLabel: 'New session', onPress: () => {} }}
                />
              </View>
            </Block>
            <Block title="Overlays">
              <View style={styles.row}>
                <Text style={styles.chip} onPress={() => setOverlay('action')}>
                  Action sheet
                </Text>
                <Text style={styles.chip} onPress={() => setOverlay('confirm')}>
                  Confirm
                </Text>
                <Text style={styles.chip} onPress={() => setOverlay('drawer')}>
                  Drawer
                </Text>
                <Text style={styles.chip} onPress={() => newSession.open()}>
                  New session
                </Text>
                <Text style={styles.chip} onPress={() => newSession.open({ machine: 'hp', folder: '/home/dev/Projects/feedgest/app' })}>
                  New session (hp preset)
                </Text>
                <View ref={menuAnchor}>
                  <NavBarButton icon={MoreHorizontal} accessibilityLabel="Menu" onPress={() => setOverlay('pulldown')} />
                </View>
              </View>
            </Block>
          </>
        ) : null}
      </ScrollView>

      <ActionSheet visible={overlay === 'action'} title="yardbell" message="mobile-app on hp" actions={actions} groupDestructive onClose={close} />
      <ConfirmModal
        visible={overlay === 'confirm'}
        title="Stop this session?"
        message="The agent in yardbell on hp ends and its terminal closes."
        confirmLabel="Stop session"
        destructive
        onConfirm={() => setLog('Confirmed')}
        onCancel={close}
      />
      <BottomDrawer visible={overlay === 'drawer'} onClose={close}>
        <SheetHeader title="Drawer" onClose={close} />
        <ListGroup>
          <ListRow key="x" title="Row inside a drawer" navigates onPress={() => {}} />
        </ListGroup>
      </BottomDrawer>
      <PullDownMenu visible={overlay === 'pulldown'} anchorRef={menuAnchor} groups={menuGroups} onClose={close} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1, backgroundColor: colors.bgBase },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  chip: {
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    overflow: 'hidden',
    fontSize: 13
  },
  chipActive: { backgroundColor: colors.surfaceBright, color: colors.bgBase },
  log: { color: colors.textSecondary, paddingHorizontal: spacing.lg, marginBottom: spacing.md, fontSize: 13 },
  block: { marginBottom: spacing.lg },
  blockTitle: { color: colors.textMuted, fontSize: 11, paddingHorizontal: spacing.lg, marginBottom: spacing.xs },
  blockBody: { paddingHorizontal: spacing.lg },
  blockFlush: { paddingHorizontal: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.md },
  cell: { alignItems: 'center', gap: spacing.sm },
  small: { color: colors.textSecondary, fontSize: 11 },
  listPad: { paddingHorizontal: spacing.lg },
  stateBox: { height: 220, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.borderSubtle },
  fabBox: { height: 100, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.borderSubtle },
  searchBox: { height: 120, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.borderSubtle }
}))
