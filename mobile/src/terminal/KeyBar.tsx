import { Pressable, ScrollView, Text } from 'react-native'
import { useTheme } from '@/theme/useTheme'
import type { KeyName, Mods } from './keys'

type Mod = keyof Mods
type BarKey = { label: string; a11y: string } & ({ key: KeyName } | { mod: Mod })

const KEYS: BarKey[] = [
  { label: 'Esc', a11y: 'Escape', key: 'esc' },
  { label: 'Tab', a11y: 'Tab', key: 'tab' },
  { label: 'Ctrl', a11y: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', a11y: 'Alt', mod: 'alt' },
  { label: '←', a11y: 'Arrow left', key: 'left' },
  { label: '↓', a11y: 'Arrow down', key: 'down' },
  { label: '↑', a11y: 'Arrow up', key: 'up' },
  { label: '→', a11y: 'Arrow right', key: 'right' },
  { label: 'Home', a11y: 'Home', key: 'home' },
  { label: 'End', a11y: 'End', key: 'end' },
  { label: 'PgUp', a11y: 'Page up', key: 'pgup' },
  { label: 'PgDn', a11y: 'Page down', key: 'pgdn' }
]

export function KeyBar({
  mods,
  onToggle,
  onKey
}: {
  mods: Mods
  onToggle: (mod: Mod) => void
  onKey: (key: KeyName) => void
}) {
  const theme = useTheme()
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.background }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}
    >
      {KEYS.map((k) => {
        const armed = 'mod' in k && mods[k.mod]
        return (
          <Pressable
            key={k.label}
            accessibilityRole="button"
            accessibilityLabel={k.a11y}
            accessibilityState={'mod' in k ? { selected: armed } : undefined}
            onPress={() => ('mod' in k ? onToggle(k.mod) : onKey(k.key))}
            style={({ pressed }) => ({
              minWidth: 44,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              alignItems: 'center',
              backgroundColor: armed ? theme.foreground : pressed ? theme.accent : theme.muted
            })}
          >
            <Text style={{ color: armed ? theme.background : theme.foreground, fontSize: 15 }}>{k.label}</Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}
