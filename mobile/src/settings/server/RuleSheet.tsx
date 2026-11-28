import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Segmented } from '../../inbox/Segmented'
import { BottomDrawer } from '../../ui/BottomDrawer'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { PageField } from '../../ui/PageField'
import { SheetHeader } from '../../ui/SheetHeader'
import { colors, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import type { DispatchRule } from '../serverApi'
import { cleanRule, isPlaced, newRule, RULE_STEPS, RULE_THEN, ruleProblem, stepLabel, withStep } from './dispatchModel'

type Props = {
  visible: boolean
  rule: DispatchRule | null
  machines: string[]
  busy: boolean
  onSave: (before: DispatchRule | null, after: DispatchRule) => void
  onDelete: (rule: DispatchRule) => void
  onClose: () => void
}

type Picking = 'step' | 'machine' | null

export function RuleSheet({ visible, rule, machines, busy, onSave, onDelete, onClose }: Props) {
  useColorScheme()
  const [draft, setDraft] = useState<DispatchRule>(rule ?? newRule())
  const [before, setBefore] = useState<DispatchRule | null>(rule)
  const [picking, setPicking] = useState<Picking>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    setDraft(rule ?? newRule())
    setBefore(rule)
    setPicking(null)
    setProblem(null)
  }, [visible, rule])

  const save = () => {
    const after = cleanRule(draft)
    const found = ruleProblem(after, machines)
    setProblem(found)
    if (!found) onSave(before, after)
  }

  const placed = isPlaced(draft.action)
  const title = picking === 'step' ? 'Step' : picking === 'machine' ? 'Machine' : before ? 'Edit rule' : 'Add rule'

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <SheetHeader
        title={title}
        onBack={picking ? { label: 'Back', onPress: () => setPicking(null) } : undefined}
        trailing={picking ? undefined : { label: 'Save', onPress: save, disabled: busy, busy }}
        onClose={picking ? undefined : onClose}
      />
      {picking === 'step' ? (
        <ListGroup>
          {RULE_STEPS.map(([id, label]) => (
            <ListRow
              key={id}
              title={label}
              selected={id === draft.action}
              onPress={() => {
                setDraft(withStep(draft, id))
                setPicking(null)
              }}
            />
          ))}
        </ListGroup>
      ) : picking === 'machine' ? (
        <ListGroup>
          {['any', ...machines].map((name) => (
            <ListRow
              key={name}
              title={name === 'any' ? 'Any machine' : name}
              selected={name === draft.machine}
              onPress={() => {
                setDraft({ ...draft, machine: name })
                setPicking(null)
              }}
            />
          ))}
        </ListGroup>
      ) : (
        <View style={styles.body}>
          <Text style={styles.label}>When Dispatch wants to</Text>
          <ListGroup>
            <ListRow key="step" title={stepLabel(draft.action)} navigates onPress={() => setPicking('step')} accessibilityLabel={`Step, ${stepLabel(draft.action)}`} />
          </ListGroup>
          {placed ? (
            <>
              <Text style={styles.label}>On</Text>
              <ListGroup>
                <ListRow
                  key="machine"
                  title={draft.machine === 'any' ? 'Any machine' : draft.machine}
                  navigates
                  onPress={() => setPicking('machine')}
                  accessibilityLabel={`Machine, ${draft.machine}`}
                />
              </ListGroup>
              <Text style={styles.label}>In</Text>
              <PageField
                value={draft.folder}
                onChangeText={(folder) => setDraft({ ...draft, folder })}
                placeholder="any folder"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel="Folder"
                style={styles.mono}
              />
            </>
          ) : null}
          <Text style={styles.label}>Then</Text>
          <View style={styles.segmented}>
            <Segmented<string> segments={RULE_THEN} value={draft.approval} onChange={(approval) => setDraft({ ...draft, approval })} />
          </View>
          {problem ? (
            <Text style={styles.problem} accessibilityRole="alert">
              {problem}
            </Text>
          ) : null}
          {before ? (
            <ListGroup style={styles.delete}>
              <ListRow key="delete" title="Delete rule" destructive disabled={busy} onPress={() => onDelete(before)} />
            </ListGroup>
          ) : null}
        </View>
      )}
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  body: { gap: spacing.sm, paddingBottom: spacing.md },
  label: { fontSize: 13, color: colors.textSecondary, paddingHorizontal: spacing.xs, paddingTop: spacing.sm },
  mono: { fontFamily: typography.monoFamily, fontSize: 14 },
  problem: { fontSize: 13, color: colors.statusRed, paddingHorizontal: spacing.xs },
  segmented: { marginHorizontal: -spacing.lg, marginTop: -spacing.sm },
  delete: { marginTop: spacing.md }
}))
