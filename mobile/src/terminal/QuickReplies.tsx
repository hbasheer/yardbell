import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text } from 'react-native'
import { useTheme } from '@/theme/useTheme'
import { repliesFor, type AgentInfo, type Reply } from './replies'

// A pressed key changes the screen, and until the server has read it again the old choices could
// answer the next question by mistake, so they stay hidden for a while.
const SETTLE_MS = 6000

export function QuickReplies({
  info,
  onKeys,
  onCancel
}: {
  info: AgentInfo | undefined
  onKeys: (keys: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const [settling, setSettling] = useState<{ screen: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  useEffect(() => {
    if (settling && info?.screen && info.screen !== settling.screen) setSettling(null)
  }, [info?.screen, settling])

  if (!info || settling) return null
  const replies = repliesFor(info)
  if (replies.length === 0) return null

  const press = (reply: Reply) => {
    if (reply.keys === null) onCancel()
    else onKeys(reply.keys)
    setSettling({ screen: info.screen ?? '' })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSettling(null), SETTLE_MS)
  }

  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, backgroundColor: theme.background }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 8, paddingTop: 6 }}
    >
      {replies.map((reply) => (
        <Pressable
          key={reply.word}
          accessibilityRole="button"
          onPress={() => press(reply)}
          style={({ pressed }) => ({
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: reply.primary ? theme.foreground : theme.border,
            backgroundColor: reply.primary ? theme.foreground : pressed ? theme.accent : theme.muted
          })}
        >
          <Text numberOfLines={1} style={{ color: reply.primary ? theme.background : theme.foreground, fontSize: 15 }}>
            {reply.word}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}
