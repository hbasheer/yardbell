import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from './theme'

export const LIST_ROW_PADDING = spacing.lg
export const LIST_LEADING_SLOT = 24
export const LIST_LEADING_INSET = LIST_ROW_PADDING + LIST_LEADING_SLOT + spacing.md

type ListGroupProps = {
  children: ReactNode
  separatorInset?: number
  surface?: 'sheet' | 'page'
  style?: StyleProp<ViewStyle>
}

export function ListGroup({ children, separatorInset = LIST_ROW_PADDING, surface = 'sheet', style }: ListGroupProps) {
  useColorScheme()
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={[styles.group, surface === 'page' && styles.pageGroup, style]}>
      {rows.map((row, index) => (
        <Fragment key={String(row.key)}>
          {index > 0 ? <View style={[styles.separator, { marginLeft: separatorInset }]} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  group: { borderRadius: radii.surface, backgroundColor: colors.sheetGroup, overflow: 'hidden' },
  pageGroup: { backgroundColor: colors.bgPanel },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle }
}))
