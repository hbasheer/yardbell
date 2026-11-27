import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, themedStyleSheet, typography } from '@/ui/theme'

export const KEY_HEIGHT = 32
export const KEY_ROW_HEIGHT = 46
const KEY_GAP = spacing.sm
const SMART_GROUP_INSET = spacing.xs

export const KEY_HIT_SLOP = {
  top: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2,
  bottom: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2,
  left: KEY_GAP / 2,
  right: KEY_GAP / 2
} as const

const key = {
  height: KEY_HEIGHT,
  minWidth: 34,
  paddingHorizontal: 9,
  borderRadius: radii.control,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5
} as const

export const dockStyles = themedStyleSheet(() => ({
  keyRow: {
    height: KEY_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: KEY_GAP,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  keyScroll: { flex: 1, minWidth: 0 },
  keyScrollContent: { alignItems: 'center', gap: KEY_GAP, paddingVertical: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2 },
  key: { ...key, backgroundColor: colors.bgRaised },
  customKey: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.composerBorder },
  keyText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: typography.monoFamily
  },
  keyPressed: { opacity: feedback.pressedOpacity },
  keyLatch: { borderWidth: 1, borderColor: 'transparent' },
  keyLatched: { borderColor: colors.textPrimary },
  keyLocked: { backgroundColor: colors.textPrimary },
  keyTextLocked: { color: colors.bgBase },
  smartGroup: {
    height: KEY_HEIGHT + SMART_GROUP_INSET * 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SMART_GROUP_INSET,
    paddingLeft: spacing.sm,
    paddingRight: SMART_GROUP_INSET,
    borderRadius: radii.control + SMART_GROUP_INSET,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  },
  smartDivider: { width: StyleSheet.hairlineWidth, height: KEY_HEIGHT - spacing.sm, backgroundColor: colors.translucentFill },
  smartKeyStack: { alignItems: 'center' },
  smartKeyWord: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' },
  smartKeyCombo: { color: colors.textSecondary, fontSize: 10, fontFamily: typography.monoFamily },
  smartKeyPrimary: { backgroundColor: colors.surfaceBright },
  smartKeyPrimaryText: { color: colors.bgBase },
  disabled: { opacity: feedback.disabledOpacity },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  liveField: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.composerSurface
  },
  liveFieldFocused: { borderColor: colors.accentBlue },
  liveStack: { flex: 1, minWidth: 0, justifyContent: 'center', paddingVertical: spacing.xs },
  liveLabel: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  liveText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: typography.monoFamily,
    paddingVertical: 0,
    paddingHorizontal: 0,
    marginTop: 1,
    includeFontPadding: false,
    textAlignVertical: 'center',
    minHeight: 22
  },
  roundButton: {
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.composerControl
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm
  },
  statusText: { flex: 1, color: colors.textSecondary, fontSize: typography.metaSize },
  statusError: { color: colors.statusRed },
  sheetBody: { gap: spacing.md, paddingBottom: spacing.lg },
  sheetLabel: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600', marginBottom: spacing.xs },
  sheetInput: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.sheetGroup,
    color: colors.textPrimary,
    fontSize: 16
  },
  segmented: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup
  },
  segmentOn: { backgroundColor: colors.textPrimary },
  segmentText: { color: colors.textSecondary, fontSize: typography.bodySize, fontWeight: '600' },
  segmentTextOn: { color: colors.bgBase },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  switchText: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize },
  sheetError: { color: colors.statusRed, fontSize: typography.bodySize }
}))
