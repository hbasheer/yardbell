import { Minus, Plus } from 'lucide-react-native'
import { Text, View } from 'react-native'
import { TEXT_SIZES } from '@/session/chrome'
import { SettingsFooter, SettingsScreen } from '@/settings/SettingsScreen'
import { FONT_FAMILIES, useTerminalPrefs } from '@/terminal/terminalPrefs'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { NavBarButton } from '@/ui/NavBarButton'
import { SectionHeader } from '@/ui/SectionHeader'
import { palettes, radii, spacing, themedStyleSheet, typography, useColorScheme } from '@/ui/theme'

export default function TerminalSettings() {
  useColorScheme()
  const { fontFamily, fontSize, setFontFamily, setFontSize } = useTerminalPrefs()
  const index = Math.max(0, TEXT_SIZES.indexOf(fontSize as (typeof TEXT_SIZES)[number]))
  const step = (delta: number) => setFontSize(TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, index + delta))])

  return (
    <SettingsScreen title="Terminal">
      <View style={styles.preview}>
        <Text style={[styles.previewText, { fontSize }]} numberOfLines={2}>
          {'$ claude --resume\nReady when you are.'}
        </Text>
      </View>
      <SectionHeader title="Font" />
      <ListGroup>
        {FONT_FAMILIES.map(({ id, label }) => (
          <ListRow key={id} title={label} selected={fontFamily === id} onPress={() => setFontFamily(id)} />
        ))}
      </ListGroup>
      <SectionHeader title="Size" />
      <ListGroup>
        <ListRow
          key="size"
          title="Text size"
          value={String(fontSize)}
          accessory={
            <View style={styles.stepper}>
              <NavBarButton icon={Minus} accessibilityLabel="Smaller text" disabled={index === 0} onPress={() => step(-1)} />
              <NavBarButton icon={Plus} accessibilityLabel="Larger text" disabled={index === TEXT_SIZES.length - 1} onPress={() => step(1)} />
            </View>
          }
        />
      </ListGroup>
      <SettingsFooter>The terminal uses these choices on every session. The preview above shows the size in the system monospace font.</SettingsFooter>
    </SettingsScreen>
  )
}

const styles = themedStyleSheet(() => ({
  preview: {
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: palettes.dark.bgBase,
    borderWidth: 1,
    borderColor: palettes.dark.borderSubtle,
    minHeight: 72
  },
  previewText: { fontFamily: typography.monoFamily, color: palettes.dark.textPrimary },
  stepper: { flexDirection: 'row', gap: spacing.sm }
}))
