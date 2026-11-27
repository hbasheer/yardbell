import { Pressable, ScrollView, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { PageField } from '../ui/PageField'
import { SheetHeader } from '../ui/SheetHeader'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { DiffBlock } from './DiffBlock'
import { MEMORY_LIMIT, type Draft } from './model'

export type EditForm = 'session' | 'review' | 'text' | 'task' | 'entry'

export type AgentChoice = { name: string; label: string }

type Props = {
  form: EditForm
  title: string
  approveLabel: string
  draft: Draft
  was?: string
  error: string | null
  busy: boolean
  machines?: string[]
  agents?: AgentChoice[]
  onChange: (key: string, value: string | boolean) => void
  onCancel: () => void
  onSave: () => void
}

const str = (draft: Draft, key: string) => (typeof draft[key] === 'string' ? (draft[key] as string) : '')

export function StepEditor({ form, title, approveLabel, draft, was, error, busy, machines, agents, onChange, onCancel, onSave }: Props) {
  useColorScheme()
  const onFolder = draft.path === undefined || Boolean(draft.folder)
  return (
    <>
      <SheetHeader
        title={title}
        leading={{ label: 'Cancel', onPress: onCancel, disabled: busy }}
        trailing={{ label: approveLabel, onPress: onSave, busy }}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
        {form === 'session' ? (
          <>
            {machines && machines.length > 0 ? (
              <Choices label="Machine" value={str(draft, 'machine')} options={machines.map((name) => ({ name, label: name }))} onPick={(value) => onChange('machine', value)} />
            ) : (
              <Field label="Machine" value={str(draft, 'machine')} onChange={(value) => onChange('machine', value)} />
            )}
            <AgentField draft={draft} agents={agents} onChange={onChange} />
            {onFolder ? (
              <Field label="Folder" value={str(draft, 'folder')} onChange={(value) => onChange('folder', value)} />
            ) : (
              <Field label="Path" value={str(draft, 'path')} onChange={(value) => onChange('path', value)} />
            )}
            <Field label="Branch" placeholder="Keep the current branch" value={str(draft, 'branch')} onChange={(value) => onChange('branch', value)} />
            <Pressable
              onPress={() => onChange('new_branch', !draft.new_branch)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: Boolean(draft.new_branch) }}
              style={styles.check}
            >
              <View style={[styles.box, Boolean(draft.new_branch) && styles.boxOn]}>
                {draft.new_branch ? <Check size={14} color={colors.bgBase} strokeWidth={3} /> : null}
              </View>
              <Text style={styles.checkLabel}>Create the branch</Text>
            </Pressable>
            {draft.new_branch ? <Field label="From" placeholder="main" value={str(draft, 'base')} onChange={(value) => onChange('base', value)} /> : null}
            <Field label="Task" multiline lines={6} value={str(draft, 'prompt')} onChange={(value) => onChange('prompt', value)} />
          </>
        ) : null}
        {form === 'review' ? (
          <>
            <AgentField draft={draft} agents={agents} onChange={onChange} />
            <Field label="Instructions for the reviewer" multiline lines={9} value={str(draft, 'prompt')} onChange={(value) => onChange('prompt', value)} />
          </>
        ) : null}
        {form === 'text' ? <Field label="Text" multiline lines={4} value={str(draft, 'text')} onChange={(value) => onChange('text', value)} /> : null}
        {form === 'task' ? <Field label="Task text" multiline lines={8} value={str(draft, 'text')} onChange={(value) => onChange('text', value)} /> : null}
        {form === 'entry' ? (
          <>
            {was ? <DiffBlock rows={[{ op: 'del', text: was }]} label="The memory it replaces" /> : null}
            <Field
              label={was ? 'Becomes' : 'Entry'}
              multiline
              lines={4}
              maxLength={MEMORY_LIMIT}
              value={str(draft, 'entry')}
              onChange={(value) => onChange('entry', value)}
            />
            <Text style={styles.count}>
              {str(draft, 'entry').length} of {MEMORY_LIMIT}
            </Text>
          </>
        ) : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </>
  )
}

function AgentField({ draft, agents, onChange }: { draft: Draft; agents?: AgentChoice[]; onChange: Props['onChange'] }) {
  if (agents && agents.length > 0) {
    return <Choices label="Agent" value={str(draft, 'agent')} options={[{ name: '', label: 'Default agent' }, ...agents]} onPick={(value) => onChange('agent', value)} />
  }
  return <Field label="Agent" placeholder="Default agent" value={str(draft, 'agent')} onChange={(value) => onChange('agent', value)} />
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  lines = 1,
  maxLength
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  multiline?: boolean
  lines?: number
  maxLength?: number
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <PageField
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
        style={multiline ? [styles.multiline, { minHeight: 22 * lines + 24 }] : undefined}
      />
    </View>
  )
}

function Choices({ label, value, options, onPick }: { label: string; value: string; options: AgentChoice[]; onPick: (value: string) => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chips}>
        {options.map((option) => {
          const on = option.name === value
          return (
            <Pressable
              key={option.name}
              onPress={() => onPick(option.name)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  form: { gap: spacing.md, paddingBottom: spacing.lg },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  multiline: { paddingVertical: spacing.md, textAlignVertical: 'top', lineHeight: 22 },
  count: { alignSelf: 'flex-end', fontSize: 12, color: colors.textMuted },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 36 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.inputBorder, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  checkLabel: { fontSize: 15, color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { maxWidth: '100%', paddingHorizontal: 14, minHeight: 38, justifyContent: 'center', borderRadius: radii.pill, backgroundColor: colors.bgRaised },
  chipOn: { backgroundColor: colors.textPrimary },
  chipText: { fontSize: 14, color: colors.textPrimary, fontFamily: typography.monoFamily },
  chipTextOn: { color: colors.bgBase, fontWeight: '600' },
  error: { fontSize: 13, color: colors.statusRed }
}))
