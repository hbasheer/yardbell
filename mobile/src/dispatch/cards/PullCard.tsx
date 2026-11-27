import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { GitPullRequest, Send, SquareTerminal } from 'lucide-react-native'
import { isAlreadyDecided } from '../api'
import type { ActionEvent, PullEvent } from '../types'
import { colors, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { conflictLine, firstError, limitLine, noteSaid, pullKind, pullNoun, pullRef, pullTitle, sentNote } from './model'
import { Buttons, CardButton, CardFrame, CardHead, ClampedText, Fold, MonoBox, NoteLine } from './parts'

export type PullCardProps = {
  event: PullEvent
  step?: ActionEvent | null
  onSend: () => Promise<void>
  onOpen?: (machine: string, name: string) => void
}

const openUrl = (url: string) => void Linking.openURL(url).catch(() => {})

export function PullCard({ event, step, onSend, onOpen }: PullCardProps) {
  useColorScheme()
  const [sending, setSending] = useState(false)
  const [already, setAlready] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const badge = pullKind(event)
  const title = pullTitle(event)
  const sent = sentNote(event, step, sending)
  const canSend = !sent || sent.again

  async function send() {
    setSending(true)
    setError(null)
    try {
      await onSend()
    } catch (caught) {
      if (isAlreadyDecided(caught)) setAlready(true)
      else setError(caught instanceof Error && caught.message ? caught.message : 'It could not be sent. Try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <CardFrame accent={event.kind === 'ci' ? 'error' : 'warn'}>
      <CardHead
        icon={GitPullRequest}
        tint={event.kind === 'ci' ? 'error' : 'warn'}
        title={`${title.ref} ${title.text}`.trim()}
        where={`${event.name} on ${event.machine}${event.branch ? ` · ${event.branch}` : ''}`}
        badge={badge}
      />
      {event.pull?.url ? (
        <Pressable onPress={() => openUrl(event.pull?.url as string)} accessibilityRole="link" hitSlop={6} style={styles.link}>
          <Text style={styles.linkText} numberOfLines={1}>
            View {pullNoun(event.pull).toLowerCase()} {pullRef(event.pull)}
          </Text>
        </Pressable>
      ) : null}
      <Body event={event} />
      {already ? <NoteLine text="Already sent" icon /> : null}
      {error ? <NoteLine text={error} tone="error" /> : null}
      {sent?.text ? <NoteLine text={sent.text} tone={sent.tone} /> : null}
      <Buttons>
        {canSend && !already ? <CardButton label={sent?.again ? 'Send again' : 'Send to session'} icon={Send} primary busy={sending} disabled={sending || !event.name} onPress={() => void send()} /> : null}
        {onOpen ? <CardButton label="Open" icon={SquareTerminal} onPress={() => onOpen(event.machine, event.name)} /> : null}
      </Buttons>
      {event.instruction ? (
        <Fold summary="What it sends">
          <View style={styles.sends}>
            <ClampedText text={event.instruction} chars={300} />
          </View>
        </Fold>
      ) : null}
    </CardFrame>
  )
}

function Body({ event }: { event: PullEvent }) {
  if (event.kind === 'ci') {
    return (
      <View style={styles.list}>
        {(event.checks ?? []).map((check, at) => (
          <View key={at} style={styles.check}>
            {check.log ? (
              <Fold summary={check.name} mono>
                <MonoBox text={check.log} />
              </Fold>
            ) : (
              <Text style={styles.checkName} numberOfLines={1}>
                {check.name}
              </Text>
            )}
            {check.log ? (
              <Text style={styles.first} numberOfLines={1}>
                {firstError(check.log)}
              </Text>
            ) : null}
            {check.url ? (
              <Pressable onPress={() => openUrl(check.url as string)} accessibilityRole="link" hitSlop={6}>
                <Text style={styles.linkText}>View</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    )
  }
  if (event.kind === 'conflict') return <Text style={styles.line}>{conflictLine(event)}</Text>
  if (event.kind === 'limit') return <Text style={styles.line}>{limitLine(event)}</Text>
  return (
    <View style={styles.list}>
      {(event.notes ?? []).map((note, at) => (
        <View key={at} style={styles.note}>
          <Text style={styles.noteHead}>
            <Text style={styles.bold}>{note.author || 'A reviewer'}</Text> {noteSaid(note)}
          </Text>
          {note.body ? <ClampedText text={note.body} chars={240} /> : null}
          {note.url ? (
            <Pressable onPress={() => openUrl(note.url as string)} accessibilityRole="link" hitSlop={6} style={styles.link}>
              <Text style={styles.linkText}>View</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {event.more ? <Text style={styles.line}>{event.more} more on the {pullNoun(event.pull).toLowerCase()}.</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  link: { alignSelf: 'flex-start' },
  linkText: { fontSize: 13, fontWeight: '600', color: colors.accentBlue },
  list: { gap: spacing.sm },
  check: { gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle, paddingBottom: spacing.xs },
  checkName: { fontSize: 14, color: colors.textPrimary, minHeight: 28, paddingTop: 5 },
  first: { fontFamily: typography.monoFamily, fontSize: 12, color: colors.textMuted },
  line: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  note: { gap: 2 },
  noteHead: { fontSize: 13, color: colors.textMuted },
  bold: { fontWeight: '700', color: colors.textPrimary },
  sends: { paddingLeft: spacing.lg, paddingBottom: spacing.xs }
}))
