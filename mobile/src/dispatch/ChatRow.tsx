import { Text } from 'react-native'
import { AgentGlyph } from '@/ui/AgentGlyph'
import { ListRow } from '@/ui/ListRow'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { chatState, footerOf, stateWord, type ChatState, type ConversationRow } from './listModel'

const GLYPH: Record<ChatState, 'blocked' | 'active' | 'idle'> = { waiting: 'blocked', working: 'active', idle: 'idle' }

export function ChatRow({
  row,
  machine,
  onPress
}: {
  row: ConversationRow
  machine?: string
  onPress: () => void
}) {
  useColorScheme()
  const { word, rest, state } = stateWord(row)
  const footer = [footerOf(row), machine].filter(Boolean).join(' · ')
  return (
    <ListRow
      title={row.title || 'Untitled chat'}
      accessibilityLabel={`${row.title || 'Untitled chat'}, ${word}${rest ? `, ${rest}` : ''}`}
      leading={<AgentGlyph activity={GLYPH[chatState(row)]} />}
      onPress={onPress}
      detail={
        <>
          <Text style={styles.preview} numberOfLines={1}>
            <Text style={[styles.word, state === 'waiting' && styles.waiting, state === 'idle' && styles.muted]}>{word}</Text>
            {rest ? ` · ${rest}` : ''}
          </Text>
          {footer ? (
            <Text style={styles.footer} numberOfLines={1}>
              {footer}
            </Text>
          ) : null}
        </>
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  preview: { fontSize: 14, lineHeight: 19, color: colors.textSecondary },
  word: { fontWeight: '600' },
  waiting: { color: colors.agentQuestionText },
  muted: { fontWeight: '400', color: colors.textSecondary },
  footer: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xxs }
}))
