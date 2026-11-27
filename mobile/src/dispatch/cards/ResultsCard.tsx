import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ClipboardList, Search, SquareTerminal } from 'lucide-react-native'
import type { ResultChild, ResultsEvent } from '../types'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { resultBadge, resultsHead, resultsTrail, type LiveLookup } from './model'
import { Buttons, CardButton, CardFrame, CardHead, ClampedText, Fold, MonoBox, NoteLine, Pill } from './parts'

export type ResultsCardProps = {
  event: ResultsEvent
  live?: LiveLookup
  onReview: (child: number) => Promise<void>
  onOpen?: (machine: string, name: string) => void
}

export function ResultsCard({ event, live, onReview, onOpen }: ResultsCardProps) {
  useColorScheme()
  const head = resultsHead(event)
  return (
    <CardFrame accent={head.timedOut ? 'warn' : undefined}>
      <CardHead icon={ClipboardList} title={head.title} where={head.summary} badge={head.badge} whereLines={2} />
      <View style={styles.children}>
        {event.children.map((child, at) => (
          <Row key={at} child={child} index={at} live={live} onReview={onReview} onOpen={onOpen} />
        ))}
      </View>
      <Text style={styles.trail}>{resultsTrail(event)}</Text>
    </CardFrame>
  )
}

function Row({ child, index, live, onReview, onOpen }: { child: ResultChild; index: number; live?: LiveLookup; onReview: (child: number) => Promise<void>; onOpen?: (machine: string, name: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const badge = resultBadge(child)
  const result = child.result
  const running = Boolean(child.started && child.name && child.machine && child.state !== 'ended' && (live ? live(child.machine, child.name) !== null : true))

  async function review() {
    setBusy(true)
    setError(null)
    try {
      await onReview(index)
      setSaid(`A review of ${child.branch || child.name} waits below for you to start it.`)
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : 'The review could not be requested. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.child}>
      <View style={styles.childHead}>
        <View style={styles.childId}>
          <Text style={styles.childLabel} numberOfLines={2}>
            {child.label}
          </Text>
          <Text style={styles.childWhere} numberOfLines={2}>
            {child.started ? `${child.name} on ${child.machine}${child.branch ? ` · ${child.branch}` : ''}` : (child.note ?? '').replace(/^./, (c) => c.toUpperCase())}
          </Text>
        </View>
        <Pill badge={badge} />
      </View>
      {result?.summary ? <ClampedText text={result.summary} /> : null}
      {result?.details?.length ? (
        <View style={styles.details}>
          {result.details.map((detail, at) => (
            <View key={at} style={styles.detail}>
              <Text style={styles.bullet}>{'•'}</Text>
              <Text style={styles.detailText}>{detail}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {child.started && !result ? (
        <Fold summary={child.screen ? 'No result block. Where its screen ended' : 'No result block, and no screen to show'}>
          {child.screen ? <MonoBox text={child.screen} /> : null}
        </Fold>
      ) : null}
      {said ? <NoteLine text={said} tone="ok" /> : null}
      {error ? <NoteLine text={error} tone="error" /> : null}
      {child.started ? (
        <Buttons>
          {running && onOpen && child.machine && child.name ? <CardButton label="Open" icon={SquareTerminal} onPress={() => onOpen(child.machine as string, child.name as string)} /> : null}
          <CardButton label="Review branch" icon={Search} busy={busy} disabled={busy} onPress={() => void review()} />
        </Buttons>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  children: { gap: spacing.sm },
  child: { gap: spacing.xs, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  childHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  childId: { flex: 1, minWidth: 0 },
  childLabel: { fontSize: 15, fontWeight: '600', lineHeight: 20, color: colors.textPrimary },
  childWhere: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  details: { gap: 4 },
  detail: { flexDirection: 'row', gap: spacing.sm },
  bullet: { fontSize: 14, lineHeight: 20, color: colors.textMuted },
  detailText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: colors.textPrimary },
  trail: { fontSize: 12, lineHeight: 17, color: colors.textMuted }
}))
