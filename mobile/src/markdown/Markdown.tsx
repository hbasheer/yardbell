import { memo, useMemo, useState, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy } from 'lucide-react-native'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { parseMarkdown, type Align, type Inline, type MarkdownBlock } from './tree'

export type MarkdownProps = { text: string; streaming?: boolean }

export const Markdown = memo(function Markdown({ text, streaming = false }: MarkdownProps) {
  useColorScheme()
  const blocks = useMemo(() => parseMarkdown(text, streaming), [text, streaming])
  if (blocks.length === 0) return null
  return (
    <View style={styles.root}>
      {blocks.map((block, at) => (
        <BlockView key={at} block={block} />
      ))}
    </View>
  )
})

function BlockView({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <Text style={styles.paragraph} selectable>
          <Spans nodes={block.children} />
        </Text>
      )
    case 'heading':
      return (
        <Text style={[styles.heading, block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : null]} accessibilityRole="header" selectable>
          <Spans nodes={block.children} />
        </Text>
      )
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, at) => (
            <View key={at} style={styles.item}>
              <Text style={styles.marker}>{block.ordered ? `${block.start + at}.` : '•'}</Text>
              <View style={styles.itemBody}>
                {item.map((child, index) => (
                  <BlockView key={index} block={child} />
                ))}
              </View>
            </View>
          ))}
        </View>
      )
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} />
    case 'quote':
      return (
        <View style={styles.quote}>
          {block.children.map((child, at) => (
            <BlockView key={at} block={child} />
          ))}
        </View>
      )
    case 'table':
      return <Table head={block.head} rows={block.rows} align={block.align} />
    case 'hr':
      return <View style={styles.rule} />
  }
}

function Spans({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, at) => {
        switch (node.kind) {
          case 'text':
            return node.text
          case 'code':
            return (
              <Text key={at} style={styles.inlineCode}>
                {node.text}
              </Text>
            )
          case 'strong':
            return (
              <Text key={at} style={styles.strong}>
                <Spans nodes={node.children} />
              </Text>
            )
          case 'em':
            return (
              <Text key={at} style={styles.em}>
                <Spans nodes={node.children} />
              </Text>
            )
          case 'del':
            return (
              <Text key={at} style={styles.del}>
                <Spans nodes={node.children} />
              </Text>
            )
          case 'link':
            return (
              <Text key={at} style={styles.link} onPress={() => void Linking.openURL(node.href).catch(() => {})} accessibilityRole="link">
                <Spans nodes={node.children} />
              </Text>
            )
          case 'break':
            return '\n'
        }
      })}
    </>
  )
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await Clipboard.setStringAsync(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <View style={styles.code}>
      <View style={styles.codeHead}>
        <Text style={styles.codeLang} numberOfLines={1}>
          {lang}
        </Text>
        <Pressable onPress={() => void copy()} hitSlop={8} accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : 'Copy code'} style={styles.copy}>
          {copied ? <Check size={14} color={colors.statusGreen} strokeWidth={2.4} /> : <Copy size={14} color={colors.textMuted} strokeWidth={2} />}
          <Text style={[styles.copyText, copied && { color: colors.statusGreen }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text style={styles.codeText} selectable>
          {text}
        </Text>
      </ScrollView>
    </View>
  )
}

function Table({ head, rows, align }: { head: Inline[][]; rows: Inline[][][]; align: Align[] }) {
  const cell = (nodes: Inline[], column: number, header: boolean, last: boolean) => (
    <View key={column} style={[styles.cell, header && styles.headCell, last && styles.lastCell]}>
      <Text style={[styles.cellText, header && styles.strong, { textAlign: align[column] ?? 'left' }]} selectable>
        <Spans nodes={nodes} />
      </Text>
    </View>
  )
  return (
    <View style={styles.table}>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.row}>{head.map((nodes, column) => cell(nodes, column, true, column === head.length - 1))}</View>
          {rows.map((row, at) => (
            <View key={at} style={[styles.row, styles.bodyRow]}>
              {row.map((nodes, column) => cell(nodes, column, false, column === row.length - 1))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  root: { gap: spacing.md, minWidth: 0 },
  paragraph: { fontSize: 16, lineHeight: 24, color: colors.textPrimary },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: colors.textPrimary, marginTop: spacing.xs },
  h1: { fontSize: 20, lineHeight: 28 },
  h2: { fontSize: 18, lineHeight: 26 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: colors.textSecondary },
  link: { color: colors.accentBlue, textDecorationLine: 'underline' },
  inlineCode: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary
  },
  list: { gap: spacing.sm },
  item: { flexDirection: 'row', gap: spacing.sm },
  marker: { fontSize: 16, lineHeight: 24, color: colors.textMuted, minWidth: 18, textAlign: 'right' },
  itemBody: { flex: 1, minWidth: 0, gap: spacing.sm },
  quote: {
    gap: spacing.sm,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle
  },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle, marginVertical: spacing.xs },
  code: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: 6,
    minHeight: 30,
    gap: spacing.sm
  },
  codeLang: { flexShrink: 1, fontSize: 12, color: colors.textMuted, fontFamily: typography.monoFamily },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 24 },
  copyText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  codeScroll: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: 10 },
  codeText: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18, color: colors.textPrimary },
  table: {
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  row: { flexDirection: 'row' },
  bodyRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  cell: {
    width: 150,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.borderSubtle
  },
  lastCell: { borderRightWidth: 0 },
  headCell: { backgroundColor: colors.bgRaised },
  cellText: { fontSize: 14, lineHeight: 20, color: colors.textPrimary }
}))
