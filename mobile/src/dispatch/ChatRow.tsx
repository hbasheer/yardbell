import { Workflow } from 'lucide-react-native'
import { Text, View } from 'react-native'
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
      accessibilityLabel={`${row.title || 'Untitled chat'}, ${word}${rest ? `, ${rest}` : ''}${row.pipeline ? ', a pipeline run' : ''}`}
      leading={<AgentGlyph activity={GLYPH[chatState(row)]} />}
      onPress={onPress}
      detail={
        <>
          <Text style={styles.preview} numberOfLines={1}>
            <Text style={[styles.word, state === 'waiting' && styles.waiting, state === 'idle' && styles.muted]}>{word}</Text>
            {rest ? ` · ${rest}` : ''}
          </Text>
          {footer || row.pipeline ? (
            <View style={styles.footerRow}>
              {row.pipeline ? <Workflow size={12} color={colors.textMuted} strokeWidth={2} accessibilityLabel="A pipeline run" /> : null}
              <Text style={styles.footer} numberOfLines={1}>
                {footer || 'Pipeline run'}
              </Text>
            </View>
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
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xxs },
  footer: { flexShrink: 1, fontSize: 12, color: colors.textMuted }
}))
