import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ScanLine, Search, SquareTerminal } from 'lucide-react-native'
import { isAlreadyDecided } from '../api'
import type { SessionEvent } from '../types'
import { ActionSheet } from '../../ui/ActionSheet'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { answeredLine, canReview, folderOf, optionLabel, SCAN_KINDS, screenView, sessionBadge } from './model'
import { Buttons, CardButton, CardFrame, CardHead, NoteLine } from './parts'

export type SessionCardProps = {
  event: SessionEvent
  onAnswer: (key: string) => Promise<void>
  onOpen?: (machine: string, name: string) => void
  onReview?: () => Promise<void>
  onScan?: (kind: 'dead_code' | 'test_gaps' | 'security') => Promise<void>
}

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback
}

export function SessionCard({ event, onAnswer, onOpen, onReview, onScan }: SessionCardProps) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [already, setAlready] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<'review' | 'scan' | null>(null)
  const [menu, setMenu] = useState(false)
  const [asked, setAsked] = useState('')
  const answered = Boolean(event.answer) || chosen !== null || asking !== null
  const pickedKey = event.answer?.key ?? chosen
  const screen = event.screen ? screenView(event.screen, open) : null
  const reviewable = canReview(event)
  const badge = already ? { label: 'Answered', tone: 'muted' as const } : sessionBadge(event)

  async function answer(key: string) {
    setAsking(key)
    setError(null)
    try {
      await onAnswer(key)
      setChosen(key)
    } catch (caught) {
      if (isAlreadyDecided(caught)) setAlready(true)
      else setError(errorText(caught, 'The answer could not be sent. Try again.'))
    } finally {
      setAsking(null)
    }
  }

  async function ask(kind: 'review' | 'scan', run: () => Promise<void>) {
    setWorking(kind)
    setError(null)
    try {
      await run()
      setAsked(kind === 'review' ? 'A review waits below for you to start it.' : 'A scan waits below for you to start it.')
    } catch (caught) {
      setError(errorText(caught, 'The request could not be sent. Try again.'))
    } finally {
      setWorking(null)
    }
  }

  return (
    <CardFrame accent={event.state === 'blocked' && !event.answer ? 'warn' : undefined}>
      <CardHead
        icon={SquareTerminal}
        tint={event.state === 'blocked' && !event.answer ? 'warn' : undefined}
        title={event.name}
        where={`on ${event.machine}${event.path ? ` · ${folderOf(event.path)}` : ''}`}
        badge={badge}
      />
      {screen ? (
        <View style={styles.screen}>
          {screen.long ? (
            <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8} style={styles.more}>
              <Text style={styles.moreText}>{open ? 'Show the end only' : `Show all ${screen.total} lines`}</Text>
            </Pressable>
          ) : null}
          <Text style={styles.screenText} selectable>
            {screen.text}
          </Text>
        </View>
      ) : null}
      {already ? <NoteLine text="Already answered" icon /> : null}
      {error ? <NoteLine text={error} tone="error" /> : null}
      {asked ? <NoteLine text={asked} /> : null}
      <Buttons>
        {(event.options ?? []).map((option) => (
          <CardButton
            key={option.key}
            label={optionLabel(option.label)}
            primary={option.key === '1' && !pickedKey}
            picked={pickedKey === option.key}
            busy={asking === option.key}
            disabled={answered || already}
            onPress={() => void answer(option.key)}
          />
        ))}
        {reviewable && onReview ? <CardButton label="Review branch" icon={Search} busy={working === 'review'} disabled={working !== null} onPress={() => void ask('review', onReview)} /> : null}
        {reviewable && event.path && onScan ? <CardButton label="Scan" icon={ScanLine} busy={working === 'scan'} disabled={working !== null} onPress={() => setMenu(true)} /> : null}
        {event.state !== 'ended' && onOpen ? <CardButton label="Open" icon={SquareTerminal} onPress={() => onOpen(event.machine, event.name)} /> : null}
      </Buttons>
      {event.answer ? <NoteLine text={answeredLine(event)} /> : null}
      {onScan ? (
        <ActionSheet
          visible={menu}
          title="Scan this folder"
          message="A scanner reads all of its code and changes nothing."
          actions={SCAN_KINDS.map((scan) => ({ label: scan.label, hint: scan.hint, icon: ScanLine, onPress: () => void ask('scan', () => onScan(scan.kind)) }))}
          onClose={() => setMenu(false)}
        />
      ) : null}
    </CardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  screen: {
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    padding: spacing.md,
    gap: spacing.xs
  },
  screenText: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18, color: colors.textPrimary },
  more: { alignSelf: 'flex-start' },
  moreText: { fontSize: 13, fontWeight: '600', color: colors.accentBlue }
}))
