import { Text } from 'react-native'
import { statusOf, type ServerSession, type SessionStatus } from '@/state/views'
import { previewParts } from './presentation'
import { AgentGlyph } from '@/ui/AgentGlyph'
import { ListRow } from '@/ui/ListRow'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export const STATE_WORD: Record<SessionStatus, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped'
}

export function stateColor(status: SessionStatus): string {
  if (status === 'needs-you') return colors.agentQuestionText
  if (status === 'stopped') return colors.statusRed
  return colors.textSecondary
}

export function AgentRow({ session, onOpen }: { session: ServerSession; onOpen: (session: ServerSession) => void }) {
  useColorScheme()
  const status = statusOf(session)
  const openable = session.attachable && Boolean(session.tmux)
  const rest = previewParts(session)
  const title = session.folder || session.tmux || session.id
  return (
    <ListRow
      title={title}
      accessibilityLabel={`${title}, ${STATE_WORD[status]}`}
      leading={<AgentGlyph activity={session.activity} stopped={session.stopped} />}
      disabled={!openable}
      onPress={() => onOpen(session)}
      detail={
        <>
          <Text style={styles.preview} numberOfLines={2} ellipsizeMode="tail">
            <Text style={[styles.word, { color: stateColor(status) }]}>{STATE_WORD[status]}</Text>
            {rest ? ` · ${rest}` : ''}
          </Text>
          <Text style={styles.footer} numberOfLines={1}>
            {[session.agent, session.machine].filter(Boolean).join(' · ')}
          </Text>
        </>
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  preview: { fontSize: 14, lineHeight: 19, color: colors.textSecondary },
  word: { fontWeight: '600' },
  footer: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xxs }
}))
