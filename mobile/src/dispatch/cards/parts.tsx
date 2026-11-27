import { useState, type ComponentType, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, Clock } from 'lucide-react-native'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import type { Badge as BadgeValue, Tone } from './model'
import { isLongText } from './model'

type IconProps = { size?: number; color?: string; strokeWidth?: number }

export function toneColor(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return colors.statusGreen
    case 'warn':
      return colors.statusAmber
    case 'error':
      return colors.statusRed
    default:
      return colors.textMuted
  }
}

export function CardFrame({ children, accent }: { children: ReactNode; accent?: Tone }) {
  useColorScheme()
  return <View style={[styles.card, accent === 'warn' && { borderColor: colors.statusAmber }, accent === 'error' && { borderColor: colors.statusRed }]}>{children}</View>
}

export function CardHead({
  icon: Icon,
  title,
  where,
  badge,
  tint,
  whereLines = 1
}: {
  icon: ComponentType<IconProps>
  title: string
  where?: string
  badge?: BadgeValue
  tint?: Tone
  whereLines?: number
}) {
  useColorScheme()
  return (
    <View style={styles.head}>
      <View style={styles.tile}>
        <Icon size={16} color={tint ? toneColor(tint) : colors.textSecondary} strokeWidth={2} />
      </View>
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {where ? (
          <Text style={styles.where} numberOfLines={whereLines}>
            {where}
          </Text>
        ) : null}
      </View>
      {badge ? <Pill badge={badge} /> : null}
    </View>
  )
}

export function Pill({ badge }: { badge: BadgeValue }) {
  useColorScheme()
  return (
    <View style={[styles.badge, { borderColor: toneColor(badge.tone) }]}>
      <Text style={[styles.badgeText, { color: toneColor(badge.tone) }]} numberOfLines={1}>
        {badge.label}
      </Text>
    </View>
  )
}

export function CardButton({
  label,
  onPress,
  icon: Icon,
  primary = false,
  picked = false,
  grow = false,
  disabled = false,
  busy = false
}: {
  label: string
  onPress: () => void
  icon?: ComponentType<IconProps>
  primary?: boolean
  picked?: boolean
  grow?: boolean
  disabled?: boolean
  busy?: boolean
}) {
  useColorScheme()
  const tint = primary ? colors.bgBase : colors.textPrimary
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy, selected: picked }}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.outline,
        picked && styles.picked,
        grow && styles.grow,
        (pressed || busy) && styles.pressed,
        disabled && !busy && !picked && styles.disabled
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={tint} /> : Icon ? <Icon size={16} color={tint} strokeWidth={2.2} /> : null}
      <Text style={[styles.buttonText, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

export function Buttons({ children }: { children: ReactNode }) {
  return <View style={styles.buttons}>{children}</View>
}

export function NoteLine({ text, tone = 'muted', icon = false }: { text: string; tone?: Tone; icon?: boolean }) {
  useColorScheme()
  if (!text) return null
  return (
    <View style={styles.noteRow} accessibilityRole={tone === 'error' ? 'alert' : undefined}>
      {icon ? <Clock size={14} color={toneColor(tone)} strokeWidth={2} /> : null}
      <Text style={[styles.note, { color: tone === 'muted' ? colors.textMuted : toneColor(tone) }]}>{text}</Text>
    </View>
  )
}

export function ClampedText({ text, chars = 220, mono = false }: { text: string; chars?: number; mono?: boolean }) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const long = isLongText(text, chars)
  return (
    <View>
      <Text style={[styles.text, mono && styles.mono]} numberOfLines={long && !open ? 4 : undefined} selectable>
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

export function MonoBox({ text, maxHeight = 256 }: { text: string; maxHeight?: number }) {
  useColorScheme()
  return (
    <View style={styles.box}>
      <ScrollView style={{ maxHeight }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
          <Text style={styles.boxText} selectable>
            {text}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  )
}

export function Fold({ summary, children, mono = false }: { summary: string; children: ReactNode; mono?: boolean }) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.foldHead}>
        <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} style={open ? undefined : styles.closed} />
        <Text style={[styles.foldText, mono && styles.mono]} numberOfLines={1}>
          {summary}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  )
}


const styles = themedStyleSheet(() => ({
  card: {
    borderRadius: radii.floating,
    borderWidth: 1,
    borderColor: colors.floatingCardBorder,
    backgroundColor: colors.composerSurface,
    overflow: 'hidden',
    padding: spacing.md,
    gap: spacing.sm
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  tile: { width: 32, height: 32, borderRadius: radii.tile, backgroundColor: colors.bgRaised, alignItems: 'center', justifyContent: 'center' },
  titles: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', lineHeight: 21, color: colors.textPrimary },
  where: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  badge: { maxWidth: 124, borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 1,
    maxWidth: '100%'
  },
  primary: { backgroundColor: colors.textPrimary },
  outline: { borderWidth: 1, borderColor: colors.choiceBorder },
  picked: { borderColor: colors.statusGreen, borderWidth: 2 },
  grow: { flexGrow: 1, flexBasis: 0, minWidth: 110 },
  buttonText: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  note: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  text: { fontSize: 14, lineHeight: 20, color: colors.textPrimary },
  mono: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18 },
  more: { alignSelf: 'flex-start', paddingTop: spacing.xs },
  moreText: { fontSize: 13, fontWeight: '600', color: colors.accentBlue },
  box: {
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  boxText: { fontFamily: typography.monoFamily, fontSize: 12, lineHeight: 18, color: colors.textPrimary },
  foldHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  foldText: { flexShrink: 1, fontSize: 13, color: colors.textSecondary },
  closed: { transform: [{ rotate: '-90deg' }] }
}))
