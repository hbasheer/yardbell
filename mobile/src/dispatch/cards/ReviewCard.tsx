import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native'
import { Check, ChevronDown, ChevronRight, ScanLine, Search } from 'lucide-react-native'
import type { PairedServer } from '../../servers/store'
import { evidenceSource, isAlreadyDecided, reviewCommit, type ReviewDecision } from '../api'
import { EvidenceViewer, type EvidenceImage } from '../review/EvidenceViewer'
import { fileWord, placeLink, scanFileCount, shotSize, shotsOf, standingLines, standingOf } from '../review/model'
import type { Finding, ReviewEvent, ReviewShot, ReviewTarget } from '../types'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { clock } from '../../steps/model'
import { decidedWords, findingGroups, isScan, pickedOf, reviewHead, settleAction, toastWords, type FindingGroup } from './model'
import { Buttons, CardButton, CardFrame, CardHead, ClampedText, NoteLine, toneColor } from './parts'

export type ReviewView = { server: PairedServer; conversation: string; card: number }

export type ReviewCardProps = {
  event: ReviewEvent
  view?: ReviewView
  onSettle: (body: ReviewDecision) => Promise<void>
  loadTargets?: () => Promise<ReviewTarget[]>
}

const NEW_SESSION = ''

export function ReviewCard({ event, view, onSettle, loadTargets }: ReviewCardProps) {
  useColorScheme()
  const router = useRouter()
  const [viewing, setViewing] = useState<EvidenceImage | null>(null)
  const scan = isScan(event)
  const findings = event.findings ?? []
  const outcome = event.outcome
  const head = reviewHead(event)
  const [chosen, setChosen] = useState<number[] | undefined>(undefined)
  const [lowOpen, setLowOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [already, setAlready] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const [targets, setTargets] = useState<ReviewTarget[] | null>(scan && !outcome && findings.length && loadTargets ? null : [])
  const [target, setTarget] = useState(NEW_SESSION)
  const picked = pickedOf(event, chosen)
  const groups = useMemo(() => findingGroups(findings), [findings])
  const onlyLow = groups.every((g) => g.severity === 'low')

  useEffect(() => {
    if (!scan || outcome || !findings.length || !loadTargets) return
    let live = true
    loadTargets()
      .then((list) => {
        if (!live) return
        setTargets(list)
        setTarget(list.some((s) => s.name === event.of?.name) ? (event.of?.name as string) : (list[0]?.name ?? NEW_SESSION))
      })
      .catch(() => live && setTargets([]))
    return () => {
      live = false
    }
  }, [scan, outcome, findings.length, loadTargets, event.of?.name])

  function toggle(index: number) {
    setChosen((current) => {
      const base = current ?? pickedOf(event, undefined)
      return base.includes(index) ? base.filter((i) => i !== index) : [...base, index]
    })
  }

  async function settle(body: ReviewDecision, words: string) {
    setBusy(true)
    setError(null)
    try {
      await onSettle(body)
      setSaid(words)
    } catch (caught) {
      if (isAlreadyDecided(caught)) setAlready(true)
      else setError(caught instanceof Error && caught.message ? caught.message : 'It could not be sent. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const action = settleAction(event, picked, scan ? target : '')
  const list = targets ?? []

  return (
    <CardFrame accent={outcome ? undefined : head.badge.tone === 'warn' ? 'warn' : undefined}>
      <CardHead icon={scan ? ScanLine : Search} title={head.title} where={head.where} badge={head.badge} whereLines={2} />
      {event.summary ? <ClampedText text={event.summary} chars={240} /> : null}
      {view ? <CommitStanding event={event} view={view} /> : null}
      {groups.length === 0 ? <Text style={styles.none}>{scan ? 'No issues found.' : 'No problems found.'}</Text> : null}
      {groups.map((group) => (
        <Group key={group.severity || 'other'} group={group} picked={picked} decided={Boolean(outcome)} busy={busy} folds={group.severity === 'low' && !onlyLow} open={!(group.severity === 'low' && !onlyLow) || lowOpen || group.items.some(({ index }) => picked.includes(index))} onOpen={() => setLowOpen(!lowOpen)} onToggle={toggle} event={event} view={view} onShot={setViewing} />
      ))}
      {view ? <PanelRow event={event} view={view} scan={scan} onOpen={(href) => router.push(href as never)} /> : null}
      {outcome ? (
        <Text style={styles.trail}>{decidedWords(event, outcome)}</Text>
      ) : (
        <>
          <Text style={styles.trail}>Finished {clock(event.at)}</Text>
          {already ? <NoteLine text="Already decided" icon /> : null}
          {error ? <NoteLine text={error} tone="error" /> : null}
          {said ? <NoteLine text={said} tone="ok" /> : null}
          {scan && findings.length && !already ? (
            <View style={styles.targets}>
              <Text style={styles.targetsLabel}>Send the findings to</Text>
              {targets === null ? (
                <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />
              ) : (
                <View style={styles.chips}>
                  {list.map((session) => (
                    <TargetChip key={session.name} label={session.name} selected={target === session.name} disabled={busy} onPress={() => setTarget(session.name)} />
                  ))}
                  <TargetChip label="A new session" selected={target === NEW_SESSION} disabled={busy} onPress={() => setTarget(NEW_SESSION)} />
                </View>
              )}
            </View>
          ) : null}
          {!already ? (
            <Buttons>
              <CardButton label="Dismiss" disabled={busy} onPress={() => void settle({ decision: 'dismiss' }, 'Dismissed.')} />
              {findings.length ? (
                <CardButton label={action.label} primary grow busy={busy} disabled={busy || picked.length === 0 || targets === null} onPress={() => void settle(action.body, toastWords(event, picked, action))} />
              ) : null}
            </Buttons>
          ) : null}
        </>
      )}
      <EvidenceViewer image={viewing} onClose={() => setViewing(null)} />
    </CardFrame>
  )
}

function CommitStanding({ event, view }: { event: ReviewEvent; view: ReviewView }) {
  useColorScheme()
  const pin = event.of?.pin
  const check = Boolean(pin && !pin.error)
  const query = useQuery({
    queryKey: ['review-commit', view.server.id, view.conversation, view.card],
    queryFn: () => reviewCommit(view.server, view.conversation, view.card),
    enabled: check,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    meta: { serverId: view.server.id }
  })
  const failure = query.error ? (query.error instanceof Error ? query.error.message : String(query.error)) : undefined
  const lines = standingLines(event, standingOf(query.data, failure))
  if (!lines.length) return null
  return (
    <View style={styles.standing}>
      {lines.map((line) => (
        <Text key={line.text} style={[styles.standingText, line.warn && styles.standingWarn]}>
          {line.text}
        </Text>
      ))}
    </View>
  )
}

function PanelRow({ event, view, scan, onOpen }: { event: ReviewEvent; view: ReviewView; scan: boolean; onOpen: (href: string) => void }) {
  const count = scan ? scanFileCount(event.findings) : 0
  if (scan && count === 0) return null
  const href = `/dispatch/${encodeURIComponent(view.server.id)}/review/${encodeURIComponent(view.conversation)}/${view.card}?panel=${scan ? 'files' : 'changes'}`
  return (
    <Pressable onPress={() => onOpen(href)} accessibilityRole="button" style={({ pressed }) => [styles.panelRow, pressed && styles.pressed]}>
      <Text style={styles.panelTitle}>{scan ? 'Files' : 'Changes'}</Text>
      {scan ? <Text style={styles.panelCount}>{fileWord(count)}</Text> : null}
      <View style={styles.spacer} />
      <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
    </Pressable>
  )
}

function Group({
  group,
  picked,
  decided,
  busy,
  folds,
  open,
  onOpen,
  onToggle,
  event,
  view,
  onShot
}: {
  group: FindingGroup
  picked: number[]
  decided: boolean
  busy: boolean
  folds: boolean
  open: boolean
  onOpen: () => void
  onToggle: (index: number) => void
  event: ReviewEvent
  view?: ReviewView
  onShot: (image: EvidenceImage) => void
}) {
  const tone = group.severity === 'high' ? 'error' : group.severity === 'medium' ? 'warn' : 'muted'
  const word = `${group.label} · ${group.items.length}`
  return (
    <View style={styles.group}>
      {folds ? (
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.groupHead}>
          <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} style={open ? undefined : styles.closed} />
          <View style={[styles.sev, { backgroundColor: toneColor(tone) }]} />
          <Text style={styles.groupText}>{word}</Text>
        </Pressable>
      ) : (
        <View style={styles.groupHead}>
          <View style={[styles.sev, { backgroundColor: toneColor(tone) }]} />
          <Text style={styles.groupText}>{word}</Text>
        </View>
      )}
      {open
        ? group.items.map(({ finding, index }) => (
            <FindingRow key={index} finding={finding} index={index} event={event} view={view} onShot={onShot} checked={picked.includes(index)} decided={decided} disabled={busy} onPress={() => onToggle(index)} />
          ))
        : null}
    </View>
  )
}

type FindingRowProps = {
  finding: Finding
  index: number
  event: ReviewEvent
  view?: ReviewView
  onShot: (image: EvidenceImage) => void
  checked: boolean
  decided: boolean
  disabled: boolean
  onPress: () => void
}

function FindingRow({ finding, index, event, view, onShot, checked, decided, disabled, onPress }: FindingRowProps) {
  const router = useRouter()
  const href = view ? placeLink(event, view.server.id, finding) : null
  const { kept, lost } = shotsOf(event, index)
  return (
    <Pressable
      onPress={onPress}
      disabled={decided || disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: decided || disabled }}
      style={({ pressed }) => [styles.finding, pressed && styles.pressed, decided && !checked && styles.leftOut]}
    >
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Check size={13} color={colors.bgBase} strokeWidth={3} /> : null}</View>
      <View style={styles.findingBody}>
        <Text style={styles.findingText}>{finding.text}</Text>
        {finding.place ? (
          href ? (
            <Text style={[styles.place, styles.placeLink]} numberOfLines={2} suppressHighlighting onPress={() => router.push(href as never)} accessibilityRole="link" accessibilityHint="Opens the file at this line">
              {finding.place}
            </Text>
          ) : (
            <Text style={styles.place} numberOfLines={2}>
              {finding.place}
            </Text>
          )
        ) : null}
        {view && kept.length ? (
          <View style={styles.shots}>
            {kept.map((shot) => (
              <Shot key={shot.file} shot={shot} view={view} onOpen={onShot} />
            ))}
          </View>
        ) : null}
        {lost.map((shot) => (
          <Text key={shot.name} style={styles.shotError}>{`${shot.name} was not attached: ${shot.error ?? 'it could not be read'}.`}</Text>
        ))}
      </View>
    </Pressable>
  )
}

function Shot({ shot, view, onOpen }: { shot: ReviewShot; view: ReviewView; onOpen: (image: EvidenceImage) => void }) {
  const source = useMemo(() => evidenceSource(view.server, view.conversation, view.card, shot.file as string), [view, shot.file])
  return (
    <Pressable
      onPress={() => onOpen({ name: shot.name, size: shotSize(shot), width: shot.width ?? 0, height: shot.height ?? 0, source })}
      accessibilityRole="button"
      accessibilityLabel={`Open the screenshot ${shot.name} full size`}
      style={({ pressed }) => [styles.shot, pressed && styles.pressed]}
    >
      <Image source={source} style={styles.shotImage} resizeMode="cover" accessibilityIgnoresInvertColors />
    </Pressable>
  )
}

function TargetChip({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  none: { fontSize: 14, color: colors.textSecondary },
  trail: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  group: { gap: 2 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  groupText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  sev: { width: 8, height: 8, borderRadius: 4 },
  closed: { transform: [{ rotate: '-90deg' }] },
  finding: { flexDirection: 'row', gap: 10, minHeight: 44, paddingVertical: 6, alignItems: 'flex-start' },
  leftOut: { opacity: 0.5 },
  box: {
    marginTop: 1,
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.choiceBorder,
    alignItems: 'center',
    justifyContent: 'center'
  },
  boxOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  findingBody: { flex: 1, minWidth: 0, gap: 2 },
  findingText: { fontSize: 14, lineHeight: 20, color: colors.textPrimary },
  place: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 17, color: colors.textMuted },
  placeLink: { color: colors.accentBlue, textDecorationLine: 'underline' },
  shots: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
  shot: { width: 120, height: 76, borderRadius: radii.mark, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgPanel, overflow: 'hidden' },
  shotImage: { width: '100%', height: '100%' },
  shotError: { fontSize: 12, lineHeight: 17, color: colors.statusRed },
  standing: { gap: spacing.xs },
  standingText: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  standingWarn: { color: colors.statusAmber, fontWeight: '600' },
  panelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  panelTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  panelCount: { fontSize: 13, color: colors.textMuted },
  spacer: { flex: 1 },
  targets: { gap: spacing.xs },
  targetsLabel: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  spinner: { alignSelf: 'flex-start' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  chipOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  chipText: { fontSize: 14, color: colors.textPrimary },
  chipTextOn: { color: colors.bgBase, fontWeight: '600' },
  pressed: { opacity: 0.7 }
}))
