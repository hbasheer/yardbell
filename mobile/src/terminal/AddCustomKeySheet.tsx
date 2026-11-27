import { useState } from 'react'
import { Pressable, Switch, Text, TextInput, View } from 'react-native'
import { BottomDrawer } from '@/ui/BottomDrawer'
import { SheetHeader } from '@/ui/SheetHeader'
import { colors } from '@/ui/theme'
import { buildCustomKey, type CustomKey } from './customKeys'
import { dockStyles as styles } from './dockStyles'

type Kind = 'text' | 'ctrl'

export function AddCustomKeySheet({
  visible,
  onAdd,
  onClose
}: {
  visible: boolean
  onAdd: (key: CustomKey) => Promise<void>
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<Kind>('text')
  const [value, setValue] = useState('')
  const [enter, setEnter] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setLabel('')
    setKind('text')
    setValue('')
    setEnter(true)
    setError(null)
  }

  const save = () => {
    const built = buildCustomKey(
      kind === 'text' ? { label, kind, text: value, enter } : { label, kind, letter: value },
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    )
    if ('error' in built) {
      setError(built.error)
      return
    }
    setSaving(true)
    onAdd(built)
      .then(onClose)
      .catch((failure) => setError(failure instanceof Error ? failure.message : 'Could not save the key.'))
      .finally(() => setSaving(false))
  }

  const field = (props: { value: string; onChangeText: (text: string) => void; placeholder: string; label: string; maxLength?: number }) => (
    <TextInput
      {...props}
      accessibilityLabel={props.label}
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.accentBlue}
      autoCapitalize="none"
      autoCorrect={false}
      style={styles.sheetInput}
    />
  )

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={reset}
    >
      <SheetHeader
        title="Add key"
        leading={{ label: 'Cancel', onPress: onClose }}
        trailing={{ label: 'Add', onPress: save, busy: saving }}
      />
      <View style={styles.sheetBody}>
        <View>
          <Text style={styles.sheetLabel}>Label</Text>
          {field({ value: label, onChangeText: setLabel, placeholder: 'deploy', label: 'Label', maxLength: 12 })}
        </View>
        <View>
          <Text style={styles.sheetLabel}>Sends</Text>
          <View style={styles.segmented}>
            {(['text', 'ctrl'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => {
                  setKind(option)
                  setValue('')
                  setError(null)
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: kind === option }}
                style={[styles.segment, kind === option && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, kind === option && styles.segmentTextOn]}>
                  {option === 'text' ? 'Text' : 'Ctrl + letter'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        {kind === 'text'
          ? field({ value, onChangeText: setValue, placeholder: 'make ship', label: 'Text to send' })
          : field({ value, onChangeText: (text) => setValue(text.slice(-1)), placeholder: 'K', label: 'Letter', maxLength: 1 })}
        {kind === 'text' ? (
          <View style={styles.switchRow}>
            <Text style={styles.switchText}>Press Enter after the text</Text>
            <Switch
              value={enter}
              onValueChange={setEnter}
              trackColor={{ true: colors.accentBlue, false: colors.translucentFill }}
              accessibilityLabel="Press Enter after the text"
            />
          </View>
        ) : null}
        {error ? <Text style={styles.sheetError}>{error}</Text> : null}
      </View>
    </BottomDrawer>
  )
}
