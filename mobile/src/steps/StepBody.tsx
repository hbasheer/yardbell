import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { DiffBlock } from './DiffBlock'
import { isLong, type Block } from './model'

export function StepBody({ blocks }: { blocks: Block[] }) {
  useColorScheme()
  if (blocks.length === 0) return null
  return (
    <View style={styles.body}>
      {blocks.map((block, at) => (
        <BlockView key={at} block={block} />
      ))}
    </View>
  )
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'label':
      return <Text style={styles.label}>{block.text}</Text>
    case 'text':
      return <Text style={[styles.text, block.muted && styles.muted, block.warn && styles.warn]}>{block.text}</Text>
    case 'long':
      return <LongText text={block.text} />
    case 'mono':
      return <Text style={[styles.text, styles.mono]}>{block.text}</Text>
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, at) => (
            <View key={at} style={styles.item}>
              <Text style={styles.bullet}>{at + 1}.</Text>
              <Text style={[styles.text, styles.itemText]}>{item}</Text>
            </View>
          ))}
        </View>
      )
    case 'diff':
      return <DiffBlock rows={block.rows} label="Changes" />
    case 'nochange':
      return <Text style={[styles.text, styles.muted]}>Nothing changes from what is saved now.</Text>
    case 'code':
      return <CodeBox text={block.text} />
    case 'fold':
      return <Fold summary={block.summary} text={block.text} />
  }
}

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = isLong(text)
  return (
    <View>
      <Text style={styles.text} numberOfLines={long && !open ? 6 : undefined}>
        {text}
      </Text>
      {long ? (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" hitSlop={8} style={styles.more}>
          <Text style={styles.moreText}>{open ? 'Show less' : 'Show all'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function CodeBox({ text }: { text: string }) {
  return (
    <View style={styles.code}>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText}>{text}</Text>
      </ScrollView>
    </View>
  )
}

function Fold({ summary, text }: { summary: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.foldHead}>
        <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} style={open ? undefined : styles.closed} />
        <Text style={styles.foldText} numberOfLines={1}>
          {summary}
        </Text>
      </Pressable>
      {open ? <CodeBox text={text} /> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  body: { gap: spacing.sm },
  label: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  text: { fontSize: 14, lineHeight: 20, color: colors.textPrimary },
  muted: { color: colors.textSecondary },
  warn: { color: colors.statusAmber },
  mono: { fontFamily: typography.monoFamily, fontSize: 13, lineHeight: 19 },
  list: { gap: spacing.xs },
  item: { flexDirection: 'row', gap: spacing.sm },
  bullet: { fontSize: 13, lineHeight: 20, color: colors.textMuted, minWidth: 18 },
  itemText: { flex: 1, fontFamily: typography.monoFamily, fontSize: 13 },
  more: { alignSelf: 'flex-start', paddingTop: spacing.xs },
  moreText: { fontSize: 13, fontWeight: '600', color: colors.accentBlue },
  code: {
    marginTop: spacing.xs,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  codeText: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18, color: colors.textPrimary },
  foldHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  foldText: { flexShrink: 1, fontSize: 13, color: colors.textSecondary },
  closed: { transform: [{ rotate: '-90deg' }] }
}))
