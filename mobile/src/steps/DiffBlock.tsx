import { ScrollView, Text, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import type { DiffRow } from './model'

const SIGN: Record<DiffRow['op'], string> = { add: '+', del: '-', same: ' ', gap: ' ' }

export function DiffBlock({ rows, label }: { rows: DiffRow[]; label: string }) {
  useColorScheme()
  return (
    <View style={styles.frame} accessibilityLabel={label} accessibilityRole="summary">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled contentContainerStyle={styles.scrollGrow}>
        <View style={styles.rows}>
          {rows.map((row, at) => (
            <View key={at} style={[styles.row, row.op === 'add' && styles.added, row.op === 'del' && styles.deleted, row.op === 'gap' && styles.gap]}>
              <Text
                style={[styles.sign, row.op === 'add' && styles.addedSign, row.op === 'del' && styles.deletedSign]}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                {SIGN[row.op]}
              </Text>
              <Text style={[styles.line, row.op === 'gap' && styles.gapText]} accessibilityLabel={`${row.op === 'add' ? 'added' : row.op === 'del' ? 'removed' : ''} ${row.text}`.trim()}>
                {row.text === '' ? ' ' : row.text}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  frame: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  scrollGrow: { flexGrow: 1 },
  rows: { flexGrow: 1, minWidth: '100%', paddingVertical: spacing.xs },
  row: { flexDirection: 'row', paddingRight: spacing.md },
  added: { backgroundColor: colors.diffAddedBg },
  deleted: { backgroundColor: colors.diffDeletedBg },
  gap: { backgroundColor: colors.diffFoldBg },
  sign: { width: 22, textAlign: 'center', fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18, color: colors.diffLineNumber },
  addedSign: { color: colors.diffAddedSign },
  deletedSign: { color: colors.diffDeletedSign },
  line: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18, color: colors.textPrimary },
  gapText: { color: colors.diffFoldText }
}))
