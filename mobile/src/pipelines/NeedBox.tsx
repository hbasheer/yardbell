import { useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import type { Definition, Run } from './model'
import { Button } from './parts'
import { needBox, parseLimit } from './screenModel'

export type NeedAction = 'answer' | 'retry' | 'accept-tool' | 'pass' | 'fail' | 'token-limit'

type Props = {
  run: Run
  d: Definition
  busy: string | null
  act: (action: NeedAction, value?: string | number) => Promise<boolean>
  onDrop: () => void
}

export function NeedBox({ run, d, busy, act, onDrop }: Props) {
  useColorScheme()
  const [text, setText] = useState('')
  const [raise, setRaise] = useState('')
  const box = needBox(run, d)
  const inert = busy !== null
  const limit = parseLimit(raise)

  const send = async () => {
    if (await act('answer', text)) setText('')
  }
  const raiseLimit = async () => {
    if (limit !== null && (await act('token-limit', limit))) setRaise('')
  }

  return (
    <View style={styles.box} accessibilityLabel="This run needs you">
      <Text style={styles.reason}>
        <Text style={styles.strong}>{box.title}</Text>
        {box.reason ? ` · ${box.reason}` : ''}
      </Text>
      {box.questions.length ? (
        <View style={styles.questions}>
          {box.questions.map((q, at) => (
            <Text key={at} style={styles.question}>{`${at + 1}. ${q}`}</Text>
          ))}
        </View>
      ) : null}
      {box.help ? <Text style={styles.help}>{box.help}</Text> : null}
      {box.raise ? (
        <View style={styles.raise}>
          <Text style={styles.label}>New limit for this run</Text>
          <View style={styles.raiseRow}>
            <TextInput
              value={raise}
              onChangeText={setRaise}
              placeholder={box.raise.placeholder}
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              accessibilityLabel="New limit for this run"
              style={[styles.input, styles.limit]}
            />
            <Button label="Raise the limit" busy={busy === 'token-limit'} disabled={inert || limit === null} onPress={() => void raiseLimit()} />
          </View>
        </View>
      ) : null}
      {box.screen ? (
        <ScrollView horizontal style={styles.screen} contentContainerStyle={styles.screenContent}>
          <ScrollView nestedScrollEnabled style={styles.screenInner}>
            <Text style={styles.mono} selectable>
              {box.screen}
            </Text>
          </ScrollView>
        </ScrollView>
      ) : null}
      {box.commandNote ? <Text style={styles.help}>{box.commandNote}</Text> : null}
      {box.answerable ? (
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Your answer"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Your answer"
          multiline
          style={[styles.input, styles.answer]}
        />
      ) : null}
      <View style={styles.buttons}>
        {box.answerable ? (
          <Button label="Send answer" variant="primary" busy={busy === 'answer'} disabled={inert || !text.trim()} onPress={() => void send()} />
        ) : null}
        <Button
          label={box.primary.label}
          variant={box.primary.action === 'accept-tool' ? 'primary' : 'outline'}
          busy={busy === box.primary.action}
          disabled={inert}
          onPress={() => void act(box.primary.action)}
        />
        {box.pass ? <Button label="Continue on pass" busy={busy === 'pass'} disabled={inert} onPress={() => void act('pass')} /> : null}
        {box.fail ? <Button label="Continue on fail" busy={busy === 'fail'} disabled={inert} onPress={() => void act('fail')} /> : null}
        <Button label="Drop" variant="destructive" busy={busy === 'drop'} disabled={inert} onPress={onDrop} />
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  box: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.statusAmber,
    backgroundColor: colors.agentQuestionTint
  },
  reason: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textPrimary },
  strong: { fontWeight: '700' },
  questions: { gap: spacing.xs },
  question: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textPrimary },
  help: { fontSize: typography.metaSize, lineHeight: 17, color: colors.textSecondary },
  label: { fontSize: typography.metaSize, color: colors.textSecondary },
  raise: { gap: spacing.xs },
  raiseRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  limit: { flex: 1, minHeight: 40 },
  answer: { minHeight: 80, maxHeight: 180, textAlignVertical: 'top' },
  screen: { maxHeight: 200, borderRadius: radii.tile, backgroundColor: colors.bgRaised },
  screenContent: { padding: spacing.sm },
  screenInner: { maxHeight: 184 },
  mono: { fontFamily: typography.monoFamily, fontSize: 11, lineHeight: 15, color: colors.textPrimary },
  buttons: { gap: spacing.sm, marginTop: spacing.xs }
}))
