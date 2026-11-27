import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy } from 'lucide-react-native'
import { Markdown } from '../markdown'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { clampLine, clip, codeWidth, lineCountWord, LINE_HEIGHT, splitLines, textGutter } from './model'

export type TextViewerProps = {
  text: string
  line?: number | null
  markdown?: boolean
  binary?: boolean
  tooLarge?: boolean
  cut?: boolean
  notes?: string[]
  style?: StyleProp<ViewStyle>
}

type RowProps = { index: number; text: string; gutter: number; width: number; marked: boolean; onCopy: (text: string) => void }

const Row = memo(function Row({ index, text, gutter, width, marked, onCopy }: RowProps) {
  useColorScheme()
  return (
    <Pressable style={[styles.line, marked && styles.marked, { width }]} onLongPress={() => onCopy(text)} delayLongPress={350} accessibilityLabel={`Line ${index + 1}: ${text}`}>
      <Text style={[styles.number, { width: gutter }]} numberOfLines={1}>{index + 1}</Text>
      <Text style={styles.code} numberOfLines={1}>
        {clip(text)}
      </Text>
    </Pressable>
  )
})

export function TextViewer({ text, line = null, markdown = false, binary = false, tooLarge = false, cut = false, notes = [], style }: TextViewerProps) {
  useColorScheme()
  const [viewport, setViewport] = useState(0)
  const [preview, setPreview] = useState(markdown)
  const [copied, setCopied] = useState(false)
  const list = useRef<FlatList<string>>(null)
  const lines = useMemo(() => splitLines(text), [text])
  const gutter = textGutter(lines.length)
  const width = useMemo(() => Math.max(viewport, gutter + codeWidth(lines)), [lines, gutter, viewport])
  const marked = line === null ? null : clampLine(line, lines.length)

  useEffect(() => setPreview(markdown), [markdown])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => {
    if (marked === null || viewport === 0 || preview) return
    const timer = setTimeout(() => list.current?.scrollToIndex({ index: marked - 1, viewPosition: 0.3, animated: false }), 0)
    return () => clearTimeout(timer)
  }, [marked, viewport, preview, lines])

  const copy = useCallback((value: string) => {
    Clipboard.setStringAsync(value)
      .then(() => setCopied(true))
      .catch((e) => console.error('Could not copy the text', e))
  }, [])
  const onLayout = useCallback((event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout.width), [])

  const banner = tooLarge ? 'This file is too large to show here.' : binary ? 'Binary file. There is no text to show.' : lines.length === 0 ? 'This file is empty.' : null
  const messages = [...notes, ...(cut && !tooLarge ? ['The file was cut here because it is very large.'] : [])]
  const shown = banner === null

  return (
    <View style={[styles.root, style]} onLayout={onLayout}>
      {shown ? (
        <View style={styles.bar}>
          <Text style={styles.count}>{lineCountWord(lines.length)}</Text>
          <View style={styles.barEnd}>
            {markdown ? (
              <View style={styles.toggle}>
                {(['Source', 'Preview'] as const).map((label) => {
                  const active = (label === 'Preview') === preview
                  return (
                    <Pressable key={label} style={[styles.toggleItem, active && styles.toggleActive]} onPress={() => setPreview(label === 'Preview')} accessibilityRole="button" accessibilityState={{ selected: active }}>
                      <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{label}</Text>
                    </Pressable>
                  )
                })}
              </View>
            ) : null}
            <Pressable style={({ pressed }) => [styles.copy, pressed && styles.pressed]} onPress={() => copy(text)} accessibilityRole="button" accessibilityLabel="Copy the whole file">
              {copied ? <Check size={14} color={colors.statusGreen} /> : <Copy size={14} color={colors.textSecondary} />}
              <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {messages.map((message) => (
        <Text key={message} style={styles.note}>
          {message}
        </Text>
      ))}
      {banner ? <Text style={styles.empty}>{banner}</Text> : null}
      {shown && preview ? (
        <ScrollView style={styles.preview} contentContainerStyle={styles.previewBody}>
          <Markdown text={text} />
        </ScrollView>
      ) : null}
      {shown && !preview && viewport > 0 ? (
        <ScrollView horizontal style={styles.sideways} contentContainerStyle={{ width }} showsHorizontalScrollIndicator>
          <FlatList
            ref={list}
            data={lines}
            keyExtractor={(_, index) => String(index)}
            renderItem={({ item, index }) => <Row index={index} text={item} gutter={gutter} width={width} marked={marked === index + 1} onCopy={copy} />}
            getItemLayout={(_, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index, index })}
            initialNumToRender={40}
            maxToRenderPerBatch={60}
            windowSize={9}
            removeClippedSubviews
          />
        </ScrollView>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  root: { flex: 1, backgroundColor: colors.editorSurface },
  bar: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  count: { color: colors.textMuted, fontSize: typography.metaSize },
  barEnd: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  toggle: { flexDirection: 'row', backgroundColor: colors.bgRaised, borderRadius: radii.tile, padding: 2 },
  toggleItem: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radii.mark },
  toggleActive: { backgroundColor: colors.bgBase },
  toggleText: { color: colors.textMuted, fontSize: typography.metaSize, fontWeight: '600' },
  toggleTextActive: { color: colors.textPrimary },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: spacing.xs },
  copyText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  pressed: { opacity: feedback.pressedOpacity },
  note: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textSecondary, fontSize: typography.metaSize, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  empty: { padding: spacing.lg, color: colors.textMuted, fontSize: typography.bodySize, textAlign: 'center' },
  sideways: { flex: 1 },
  preview: { flex: 1 },
  previewBody: { padding: spacing.lg },
  line: { height: LINE_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  marked: { backgroundColor: colors.codeLineHighlight },
  number: { height: LINE_HEIGHT, lineHeight: LINE_HEIGHT, paddingHorizontal: spacing.sm, textAlign: 'right', color: colors.diffLineNumber, fontFamily: typography.monoFamily, fontSize: typography.metaSize },
  code: { flex: 1, color: colors.textPrimary, fontFamily: typography.monoFamily, fontSize: typography.metaSize, lineHeight: LINE_HEIGHT }
}))
