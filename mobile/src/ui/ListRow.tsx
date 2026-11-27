import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, ChevronRight } from 'lucide-react-native'
import { LIST_LEADING_SLOT, LIST_ROW_PADDING } from './ListGroup'
import { triggerSelection } from './haptics'
import { colors, feedback, spacing, themedStyleSheet, typography, useColorScheme } from './theme'

type ListRowProps = {
  title: string
  wrapTitle?: boolean
  subtitle?: string
  subtitleMono?: boolean
  subtitleColor?: string
  subtitleNote?: { text: string; color: string }
  marker?: string
  titlePrefix?: string
  subtitleLines?: number
  subtitleIcon?: ReactNode
  detail?: ReactNode
  leading?: ReactNode
  value?: string
  valueIcon?: ReactNode
  accessory?: ReactNode
  navigates?: boolean
  selected?: boolean
  checked?: boolean
  destructive?: boolean
  accent?: boolean
  strong?: boolean
  onPress?: () => void
  onLongPress?: () => void
  disabled?: boolean
  busy?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'button' | 'link' | 'radio' | 'checkbox' | 'switch'
  testID?: string
}

export function ListRow({
  title,
  wrapTitle = false,
  subtitle,
  subtitleMono = false,
  subtitleColor,
  subtitleNote,
  marker,
  titlePrefix,
  subtitleLines = 2,
  subtitleIcon,
  detail,
  leading,
  value,
  valueIcon,
  accessory,
  navigates = false,
  selected,
  checked,
  destructive = false,
  accent = false,
  strong = false,
  onPress,
  onLongPress,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityRole,
  testID
}: ListRowProps) {
  useColorScheme()
  const inertState = { disabled: disabled || busy, ...(busy && { busy }) }
  const rowStyle = [styles.row, subtitle !== undefined && styles.rowTwoLine, disabled && styles.disabled]
  const main = (
    <View style={styles.main}>
      <Text
        style={[
          styles.title,
          subtitle !== undefined && styles.titleEmphasis,
          strong && styles.titleStrong,
          destructive && styles.titleDestructive,
          accent && styles.titleAccent
        ]}
        numberOfLines={wrapTitle ? undefined : 1}
      >
        {titlePrefix !== undefined ? <Text style={styles.titlePrefix}>{`${titlePrefix} `}</Text> : null}
        {title}
      </Text>
      {subtitle !== undefined ? (
        <WithIcon icon={subtitleIcon}>
          <Text
            style={[
              styles.subtitle,
              subtitleMono && styles.subtitleMono,
              subtitleColor !== undefined && { color: subtitleColor }
            ]}
            numberOfLines={subtitleLines}
          >
            {subtitle}
            {subtitleNote ? <Text style={{ color: subtitleNote.color }}>{` · ${subtitleNote.text}`}</Text> : null}
          </Text>
        </WithIcon>
      ) : null}
      {detail}
    </View>
  )
  const content = (
    <>
      {leading !== undefined ? <View style={styles.leading}>{leading}</View> : null}
      {marker !== undefined ? (
        <View style={styles.marked}>
          <Text style={[styles.title, styles.marker]} numberOfLines={1}>
            {marker}
          </Text>
          {main}
        </View>
      ) : (
        main
      )}
      {value !== undefined ? (
        <WithIcon icon={valueIcon} shrink>
          <Text style={styles.value} numberOfLines={1}>
            {value}
          </Text>
        </WithIcon>
      ) : null}
      {accessory}
      {selected ? <Check size={17} color={colors.textPrimary} strokeWidth={2.4} /> : null}
      {selected === false ? <View style={styles.checkSpace} /> : null}
      {navigates ? <ChevronRight size={15} color={colors.textMuted} strokeWidth={2.2} /> : null}
    </>
  )
  if (onPress === undefined) {
    return (
      <View style={rowStyle} testID={testID}>
        {content}
      </View>
    )
  }
  return (
    <Pressable
      onPress={() => {
        if (selected === false) triggerSelection()
        onPress()
      }}
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? 400 : undefined}
      disabled={inertState.disabled}
      accessibilityRole={accessibilityRole ?? (selected === undefined ? 'button' : 'radio')}
      accessibilityLabel={accessibilityLabel ?? (value ? `${title}, ${value}` : title)}
      accessibilityState={
        selected === undefined
          ? { ...inertState, ...(checked !== undefined && { checked }) }
          : { ...inertState, checked: selected, selected }
      }
      testID={testID}
      style={({ pressed }) => [...rowStyle, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

function WithIcon({ icon, shrink = false, children }: { icon: ReactNode; shrink?: boolean; children: ReactNode }) {
  if (icon === undefined || icon === null) return <>{children}</>
  return <View style={[styles.withIcon, shrink && styles.shrink]}>{icon}{children}</View>
}

const styles = themedStyleSheet(() => ({
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.sm
  },
  rowTwoLine: { minHeight: 60 },
  pressed: { backgroundColor: colors.translucentFill },
  disabled: { opacity: feedback.disabledOpacity },
  leading: { minWidth: LIST_LEADING_SLOT, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  marked: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start' },
  marker: { minWidth: 48, paddingRight: spacing.sm, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  title: { fontSize: 15, color: colors.textPrimary },
  titleEmphasis: { fontWeight: '500' },
  titlePrefix: { color: colors.textMuted, fontVariant: ['tabular-nums'] },
  titleStrong: { fontWeight: '700' },
  titleDestructive: { color: colors.statusRed },
  titleAccent: { color: colors.accentBlue },
  subtitle: { fontSize: 13, color: colors.textSecondary, flexShrink: 1 },
  subtitleMono: { fontFamily: typography.monoFamily },
  value: { fontSize: 15, color: colors.textSecondary, flexShrink: 1, maxWidth: 180 },
  checkSpace: { width: 17 },
  withIcon: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 },
  shrink: { flexShrink: 1 }
}))
