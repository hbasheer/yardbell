import { ChevronRight, Clock, FileText, MessageSquare, Zap } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { stepTitle, whereLine } from '../steps/model'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { elapsed, introFooter, userCaption, type TrackedRow, type TrackedTone } from './chatModel'
import type { ActionEvent, RunsOn, SavedPrompt, StoredAttachment, UserEvent } from './types'

type Source = { uri: string; headers: { Authorization: string } }

export function UserBubble({ event, source }: { event: UserEvent; source: (file: string) => Source | null }) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const caption = userCaption(event)
  return (
    <View style={styles.userRow}>
      {caption ? (
        <Text style={styles.caption} numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
      {event.improve ? (
        <Pressable
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.bubble, pressed && styles.pressed]}
        >
          <View style={styles.foldHead}>
            <ChevronRight size={14} color={colors.textMuted} style={open ? styles.turned : undefined} />
            <Text style={styles.foldText}>What Dispatch was asked</Text>
          </View>
          {open ? (
            <Text style={styles.userText} selectable>
              {event.text}
            </Text>
          ) : null}
        </Pressable>
      ) : event.text ? (
        <View style={styles.bubble}>
          <Text style={styles.userText} selectable>
            {event.text}
          </Text>
        </View>
      ) : null}
      {event.attachments?.length ? (
        <View style={styles.files}>
          {event.attachments.map((file, at) => (
            <SentFile key={`${file.file}:${at}`} file={file} source={file.file ? source(file.file) : null} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function SentFile({ file, source }: { file: StoredAttachment; source: Source | null }) {
  return (
    <View style={styles.file} accessibilityLabel={file.name}>
      {file.kind === 'image' && source ? (
        <Image source={source} style={styles.thumb} resizeMode="cover" />
      ) : (
        <FileText size={16} color={colors.textMuted} style={styles.fileIcon} />
      )}
      <Text style={styles.fileName} numberOfLines={1}>
        {file.name}
      </Text>
    </View>
  )
}

export function PendingRow({ step, shown, onShow }: { step: ActionEvent; shown: boolean; onShow: () => void }) {
  useColorScheme()
  return (
    <Pressable
      onPress={onShow}
      disabled={shown}
      accessibilityRole="button"
      accessibilityLabel={`${stepTitle(step)}, waiting for you`}
      accessibilityHint={shown ? undefined : 'Shows this step in the card above the message box'}
      style={({ pressed }) => [styles.pendingRow, pressed && styles.pressed]}
    >
      <Clock size={16} color={colors.statusAmber} strokeWidth={2} />
      <View style={styles.pendingText}>
        <Text style={styles.pendingTitle} numberOfLines={1}>
          {stepTitle(step)}
        </Text>
        <Text style={styles.pendingLine} numberOfLines={1}>
          {shown ? 'Waiting for you below' : `Waiting for you · ${whereLine(step) || 'tap to show it below'}`}
        </Text>
      </View>
    </Pressable>
  )
}

export function WorkingLine({ since }: { since: number | null }) {
  useColorScheme()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <View style={styles.working} accessibilityRole="progressbar" accessibilityLabel="Dispatch is working">
      <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />
      <Text style={styles.workingText}>Working</Text>
      {since !== null ? <Text style={styles.workingTime}>{elapsed(now - since)}</Text> : null}
    </View>
  )
}

export function Intro({ prompts, runsOn, onPick }: { prompts: SavedPrompt[]; runsOn: RunsOn | null | undefined; onPick: (text: string) => void }) {
  useColorScheme()
  return (
    <ScrollView contentContainerStyle={styles.intro} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
      <View style={styles.introHead}>
        <View style={styles.introTile}>
          <MessageSquare size={20} color={colors.textMuted} strokeWidth={2} />
        </View>
        <Text style={styles.introTitle} accessibilityRole="header">
          What should your agents work on?
        </Text>
        <Text style={styles.introText}>
          Describe a task in plain words. Dispatch finds the machine with the repository and the most room, and proposes each step for you to approve.
        </Text>
      </View>
      {prompts.length > 0 ? (
        <View style={styles.starters}>
          <Text style={styles.startersHint}>Start from a saved prompt. It goes in the box below for you to change before sending.</Text>
          {prompts.map((prompt) => (
            <Pressable
              key={prompt.name}
              onPress={() => onPick(prompt.text)}
              accessibilityRole="button"
              accessibilityLabel={`Start from ${prompt.name}`}
              style={({ pressed }) => [styles.starter, pressed && styles.starterPressed]}
            >
              <View style={styles.starterHead}>
                <Zap size={14} color={colors.textMuted} strokeWidth={2} />
                <Text style={styles.starterName} numberOfLines={1}>
                  {prompt.name}
                </Text>
              </View>
              <Text style={styles.starterText} numberOfLines={2}>
                {prompt.text}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={styles.introFooter}>{introFooter(runsOn)}</Text>
    </ScrollView>
  )
}

const toneOf = (tone: TrackedTone) => {
  switch (tone) {
    case 'blocked':
      return colors.statusAmber
    case 'active':
      return colors.statusGreen
    case 'stopped':
      return colors.statusRed
    case 'idle':
      return colors.textMuted
    default:
      return colors.borderSubtle
  }
}

export function SessionsStrip({ rows, onOpen }: { rows: TrackedRow[]; onOpen: (machine: string, name: string) => void }) {
  useColorScheme()
  if (!rows.length) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.stripContent}>
      <Text style={styles.stripLabel}>Sessions</Text>
      {rows.map((row) => (
        <Pressable
          key={`${row.machine}/${row.name}`}
          onPress={() => onOpen(row.machine, row.name)}
          disabled={!row.live}
          accessibilityRole="button"
          accessibilityLabel={`${row.name} on ${row.machine}, ${row.word}`}
          style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
        >
          <View style={[styles.dot, { backgroundColor: toneOf(row.tone) }]} />
          <Text style={styles.chipName} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.chipMeta} numberOfLines={1}>
            {`${row.machine} · ${row.word}`}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  pressed: { opacity: feedback.pressedOpacity },
  userRow: { alignItems: 'flex-end', gap: spacing.xs },
  caption: { fontSize: 11.5, color: colors.textMuted, maxWidth: '88%', textAlign: 'right' },
  bubble: {
    maxWidth: '88%',
    backgroundColor: colors.chatUserSurface,
    borderWidth: 1,
    borderColor: colors.chatUserBorder,
    borderRadius: radii.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  userText: { fontSize: 16, lineHeight: 22, color: colors.textPrimary },
  foldHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  foldText: { fontSize: 14, color: colors.textMuted },
  turned: { transform: [{ rotate: '90deg' }] },
  files: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm, maxWidth: '88%' },
  file: {
    height: 48,
    maxWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: 10,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  thumb: { width: 48, height: 48, backgroundColor: colors.bgRaised },
  fileIcon: { marginLeft: 10 },
  fileName: { flexShrink: 1, fontSize: 13, color: colors.textPrimary },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  pendingText: { flex: 1, minWidth: 0 },
  pendingTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  pendingLine: { fontSize: 13, lineHeight: 18, color: colors.statusAmber },
  working: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 26 },
  spinner: { transform: [{ scale: 0.75 }] },
  workingText: { fontSize: typography.bodySize, color: colors.textMuted },
  workingTime: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  intro: { paddingHorizontal: spacing.lg, paddingTop: 48, paddingBottom: spacing.xl, gap: spacing.xl },
  introHead: { alignItems: 'center', gap: spacing.sm },
  introTile: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs
  },
  introTitle: { fontSize: 20, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' },
  introText: { fontSize: 14, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
  starters: { gap: spacing.sm },
  startersHint: { fontSize: 12, fontWeight: '500', color: colors.textMuted },
  starter: {
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  starterPressed: { backgroundColor: colors.bgRaised },
  starterHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  starterName: { flexShrink: 1, fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  starterText: { fontSize: 12.5, lineHeight: 17, color: colors.textMuted },
  introFooter: { fontSize: 11.5, lineHeight: 16, color: colors.textMuted, textAlign: 'center' },
  strip: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  stripContent: { alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: 6 },
  stripLabel: { fontSize: 12, fontWeight: '500', color: colors.textMuted },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, maxWidth: 260 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipName: { flexShrink: 1, fontSize: 12, fontWeight: '500', color: colors.textPrimary },
  chipMeta: { flexShrink: 1, fontSize: 12, color: colors.textMuted }
}))
