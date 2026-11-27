import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { ChevronsUpDown } from 'lucide-react-native'
import type { DiffLine } from '../changes/api'
import { colors, feedback, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { buildRows, clip, diffContentWidth, diffGutter, layoutOf, LINE_HEIGHT, moreLabel, type DiffGutter, type DiffRow } from './model'

export type DiffListProps = {
  lines: DiffLine[]
  next?: number
  total?: number
  binary?: boolean
  cut?: boolean
  tooLarge?: boolean
  notes?: string[]
  loadingMore?: boolean
  onMore?: () => void
  header?: ReactNode
  style?: StyleProp<ViewStyle>
}

type RowProps = { row: DiffRow; gutter: DiffGutter; width: number; onCopy: (text: string) => void }

const Row = memo(function Row({ row, gutter, width, onCopy }: RowProps) {
  useColorScheme()
  if (row.kind === 'fold') {
    return (
      <View style={[styles.fold, { width }]}>
        <View style={[styles.foldGutter, { width: gutter.total }]}>
          <ChevronsUpDown size={14} color={colors.diffFoldText} />
        </View>
        <Text style={styles.foldText} numberOfLines={1}>
          {row.text}
        </Text>
      </View>
    )
  }
  const added = row.k === 'add'
  const removed = row.k === 'del'
  const ground = added ? styles.addedRow : removed ? styles.deletedRow : null
  const numberGround = added ? styles.addedGutter : removed ? styles.deletedGutter : null
  const sign = added ? '+' : removed ? '-' : ' '
  return (
    <Pressable style={[styles.line, ground, { width }]} onLongPress={() => onCopy(row.t)} delayLongPress={350} accessibilityLabel={`${sign} ${row.t}`}>
      <Text style={[styles.number, numberGround, { width: gutter.old }]} numberOfLines={1}>{row.o ?? ''}</Text>
      <Text style={[styles.number, numberGround, { width: gutter.new }]} numberOfLines={1}>{row.n ?? ''}</Text>
      <Text style={[styles.sign, added && styles.addedSign, removed && styles.deletedSign, { width: gutter.sign }]}>{sign}</Text>
      <Text style={styles.code} numberOfLines={1}>
        {clip(row.t)}
      </Text>
    </Pressable>
  )
})

export function DiffList({ lines, next, total, binary = false, cut = false, tooLarge = false, notes = [], loadingMore = false, onMore, header, style }: DiffListProps) {
  useColorScheme()
  const [viewport, setViewport] = useState(0)
  const rows = useMemo(() => buildRows(lines), [lines])
  const layout = useMemo(() => layoutOf(rows), [rows])
  const gutter = useMemo(() => diffGutter(rows), [rows])
  const width = useMemo(() => diffContentWidth(rows, gutter, viewport), [rows, gutter, viewport])
  const more = next !== undefined && total !== undefined ? moreLabel(next, total) : null

  const copy = useCallback((text: string) => {
    Clipboard.setStringAsync(text).catch((e) => console.error('Could not copy the line', e))
  }, [])
  const onLayout = useCallback((event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout.width), [])

  const banner = tooLarge
    ? 'The diff is too large to show here.'
    : binary
      ? 'Binary file. There is no text to compare.'
      : rows.length === 0
        ? 'No lines changed.'
        : null
  const messages = [...notes, ...(cut && !tooLarge ? ['The diff was cut here because it is very large.'] : [])]

  return (
    <View style={[styles.root, style]} onLayout={onLayout}>
      {header}
      {messages.map((message) => (
        <Text key={message} style={styles.note}>
          {message}
        </Text>
      ))}
      {banner ? <Text style={styles.empty}>{banner}</Text> : null}
      {rows.length > 0 && viewport > 0 ? (
        <ScrollView horizontal style={styles.sideways} contentContainerStyle={{ width }} showsHorizontalScrollIndicator>
          <FlatList
            data={rows}
            keyExtractor={(row) => String(row.key)}
            renderItem={({ item }) => <Row row={item} gutter={gutter} width={width} onCopy={copy} />}
            getItemLayout={(_, index) => ({ length: layout.heights[index], offset: layout.offsets[index], index })}
            initialNumToRender={40}
            maxToRenderPerBatch={60}
            windowSize={9}
            removeClippedSubviews
          />
        </ScrollView>
      ) : null}
      {more && onMore ? (
        <Pressable style={({ pressed }) => [styles.more, pressed && styles.morePressed, loadingMore && styles.moreBusy]} onPress={onMore} disabled={loadingMore} accessibilityRole="button">
          {loadingMore ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
          <Text style={styles.moreText}>{more}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  root: { flex: 1, backgroundColor: colors.editorSurface },
  sideways: { flex: 1 },
  note: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textSecondary, fontSize: typography.metaSize, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  empty: { padding: spacing.lg, color: colors.textMuted, fontSize: typography.bodySize, textAlign: 'center' },
  line: { height: LINE_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  addedRow: { backgroundColor: colors.diffAddedBg },
  deletedRow: { backgroundColor: colors.diffDeletedBg },
  number: { height: LINE_HEIGHT, lineHeight: LINE_HEIGHT, paddingHorizontal: 6, textAlign: 'right', color: colors.diffLineNumber, fontFamily: typography.monoFamily, fontSize: typography.metaSize },
  addedGutter: { backgroundColor: colors.diffAddedGutter },
  deletedGutter: { backgroundColor: colors.diffDeletedGutter },
  sign: { textAlign: 'center', color: colors.textMuted, fontFamily: typography.monoFamily, fontSize: typography.metaSize },
  addedSign: { color: colors.diffAddedSign },
  deletedSign: { color: colors.diffDeletedSign },
  code: { flex: 1, color: colors.textPrimary, fontFamily: typography.monoFamily, fontSize: typography.metaSize, lineHeight: LINE_HEIGHT },
  fold: { height: 32, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.diffFoldBg },
  foldGutter: { height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.diffFoldGutter },
  foldText: { flex: 1, paddingHorizontal: spacing.sm, color: colors.diffFoldText, fontFamily: typography.monoFamily, fontSize: typography.metaSize },
  more: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle, backgroundColor: colors.bgPanel },
  morePressed: { opacity: feedback.pressedOpacity },
  moreBusy: { opacity: feedback.disabledOpacity },
  moreText: { color: colors.accentBlue, fontSize: 13, fontWeight: '600' }
}))
