import { Bot } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors } from '@/ui/theme'
import { dockStyles as styles, KEY_HIT_SLOP } from './dockStyles'
import { comboOf, repliesFor, type AgentInfo, type Reply } from './replies'

// A pressed key changes the screen, and until the server has read it again the old choices could
// answer the next question by mistake, so they stay hidden for a while.
const SETTLE_MS = 6000

export function SmartKeys({
  info,
  onKeys,
  onCancel
}: {
  info: AgentInfo | undefined
  onKeys: (keys: string) => void
  onCancel: () => void
}) {
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
    <>
      <View style={styles.smartGroup}>
        <Bot size={13} color={colors.textSecondary} strokeWidth={2} />
        {replies.map((reply) => {
          const combo = comboOf(reply.keys)
          return (
            <Pressable
              key={reply.word}
              style={({ pressed }) => [styles.key, reply.primary && styles.smartKeyPrimary, pressed && styles.keyPressed]}
              hitSlop={KEY_HIT_SLOP}
              onPress={() => press(reply)}
              accessibilityRole="button"
              accessibilityLabel={`${reply.word}, sends ${combo}`}
            >
              <View style={styles.smartKeyStack}>
                <Text numberOfLines={1} style={[styles.smartKeyWord, reply.primary && styles.smartKeyPrimaryText, { maxWidth: 160 }]}>
                  {reply.word}
                </Text>
                <Text style={[styles.smartKeyCombo, reply.primary && styles.smartKeyPrimaryText]}>{combo}</Text>
              </View>
            </Pressable>
          )
        })}
      </View>
      <View style={styles.smartDivider} />
    </>
  )
}
