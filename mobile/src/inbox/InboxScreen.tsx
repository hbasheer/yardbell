import { useFocusEffect, useRouter } from 'expo-router'
import { ChevronLeft, Trash2 } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { routeIfSignedOut } from '@/api/signedOut'
import type { Decision } from '@/dispatch/types'
import type { PairedServer } from '@/servers/store'
import { useServerState } from '@/state/useServerState'
import { StepCard } from '@/steps/StepCard'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { NavBar, NavBarSubtitleText } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { LoadErrorState, StateView } from '@/ui/StateView'
import { colors, feedback, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { clearDecided, decideProposal, deleteProposal, listProposals, type Proposal } from './api'
import { countsOf, deleteCopy, emptyCopy, sectionsFor, type InboxTab } from './model'
import { Segmented } from './Segmented'

const REFRESH_MS = 5000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function InboxScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { state } = useServerState(server)
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tab, setTab] = useState<InboxTab>('all')
  const [deleting, setDeleting] = useState<Proposal | null>(null)
  const [clearing, setClearing] = useState(false)
  const seen = useRef('')

  const load = useCallback(
    async (opened: boolean) => {
      try {
        const list = await listProposals(server, opened)
        setLoadError(null)
        const key = JSON.stringify(list.proposals)
        if (key === seen.current) return
        seen.current = key
        setProposals(list.proposals)
      } catch (error) {
        if (routeIfSignedOut(error, server.id)) return
        setLoadError(messageOf(error))
      }
    },
    [server]
  )

  useFocusEffect(
    useCallback(() => {
      void load(true)
      const timer = setInterval(() => void load(false), REFRESH_MS)
      return () => clearInterval(timer)
    }, [load])
  )

  const waitingOnServer = state?.proposals
  useEffect(() => {
    if (waitingOnServer !== undefined) void load(false)
  }, [waitingOnServer, load])

  const counts = useMemo(() => countsOf(proposals ?? []), [proposals])
  const sections = useMemo(() => sectionsFor(proposals ?? [], tab), [proposals, tab])
  const machines = useMemo(() => state?.machines.map((machine) => machine.name), [state])
  const agents = useMemo(() => state?.agents?.map(({ name, label }) => ({ name, label })), [state])

  const decide = (proposal: Proposal) => async (decision: Decision, input?: Record<string, unknown>) => {
    try {
      await decideProposal(server, proposal.id, decision, input)
    } catch (error) {
      if (routeIfSignedOut(error, server.id)) return
      await load(false)
      throw error
    }
    await load(false)
  }

  const confirmDelete = async () => {
    const target = deleting
    if (!target) return
    setActionError(null)
    try {
      await deleteProposal(server, target.id)
    } catch (error) {
      if (routeIfSignedOut(error, server.id)) return
      setActionError(`Could not delete the proposal: ${messageOf(error)}`)
    }
    await load(false)
  }

  const confirmClear = async () => {
    setActionError(null)
    try {
      await clearDecided(server)
    } catch (error) {
      if (routeIfSignedOut(error, server.id)) return
      setActionError(`Could not clear the decided proposals: ${messageOf(error)}`)
    }
    await load(false)
  }

  const copy = emptyCopy(tab)
  const deletion = deleting ? deleteCopy(deleting) : null

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <NavBar
        title="Inbox"
        subtitle={serverCount > 1 ? <NavBarSubtitleText>{server.machine}</NavBarSubtitleText> : undefined}
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
        }
      />
      {proposals === null ? (
        loadError ? (
          <LoadErrorState message={loadError} onRetry={() => void load(true)} bottomInset={insets.bottom} />
        ) : (
          <StateView loading title="Loading the inbox" bottomInset={insets.bottom} />
        )
      ) : (
        <>
          <Segmented
            value={tab}
            onChange={setTab}
            segments={[
              { id: 'all', label: 'All' },
              { id: 'waiting', label: 'Waiting', count: counts.waiting },
              { id: 'decided', label: 'Decided', count: counts.decided }
            ]}
          />
          {loadError ? <Text style={styles.error}>{`Could not refresh: ${loadError}`}</Text> : null}
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          {sections.length === 0 ? (
            <StateView title={copy.title} message={copy.message} bottomInset={insets.bottom} />
          ) : (
            <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
              {sections.map((section) => (
                <View key={section.key}>
                  <View style={styles.heading}>
                    <Text style={styles.headingTitle} accessibilityRole="header">
                      {section.title}
                      <Text style={styles.headingCount}>{`  ${section.proposals.length}`}</Text>
                    </Text>
                    {section.key === 'decided' ? (
                      <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setClearing(true)}>
                        <Text style={styles.headingLink}>Clear</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {section.proposals.map((proposal) => (
                    <View key={proposal.id} style={styles.item}>
                      <StepCard step={proposal} onDecide={decide(proposal)} machines={machines} agents={agents} />
                      <Pressable
                        style={({ pressed }) => [styles.delete, pressed && styles.pressed]}
                        onPress={() => setDeleting(proposal)}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel="Delete this proposal"
                      >
                        <Trash2 size={14} color={colors.textMuted} strokeWidth={2} />
                        <Text style={styles.deleteText}>Delete</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              ))}
            </ScrollView>
          )}
        </>
      )}
      <ConfirmModal
        visible={deleting !== null}
        title={deletion?.title ?? ''}
        message={deletion?.message}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmModal
        visible={clearing}
        title="Clear the decided proposals?"
        message="Waiting proposals stay."
        confirmLabel="Clear"
        destructive
        onConfirm={() => void confirmClear()}
        onCancel={() => setClearing(false)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  heading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    marginTop: 18,
    marginBottom: 8
  },
  headingTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  headingCount: { fontWeight: '500', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  headingLink: { fontSize: 14, fontWeight: '500', color: colors.accentBlue },
  item: { marginBottom: spacing.md },
  delete: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 36,
    paddingHorizontal: spacing.sm
  },
  deleteText: { fontSize: 13, fontWeight: '500', color: colors.textMuted },
  pressed: { opacity: feedback.pressedOpacity },
  error: { marginHorizontal: spacing.lg, marginTop: spacing.sm, fontSize: 13, color: colors.statusRed }
}))
