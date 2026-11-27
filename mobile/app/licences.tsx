import { Text, View } from 'react-native'
import { notices } from '@/about/notices'
import { SettingsScreen } from '@/settings/SettingsScreen'
import { SectionHeader } from '@/ui/SectionHeader'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '@/ui/theme'

const sections = notices
  .split(/\n(?=## )/)
  .map((block) => {
    const [heading, ...rest] = block.split('\n')
    return { title: heading.replace(/^#+\s*/, ''), body: rest.join('\n').replace(/^```.*\n?/gm, '').replace(/`/g, '').replace(/^### /gm, '').trim() }
  })
  .filter((section) => section.title !== 'Third-party notices' || section.body)

export default function Licences() {
  useColorScheme()
  return (
    <SettingsScreen title="Licences">
      {sections.map((section, index) => (
        <View key={section.title}>
          <SectionHeader title={section.title} first={index === 0} />
          <View style={styles.card}>
            <Text selectable style={styles.text}>
              {section.body}
            </Text>
          </View>
        </View>
      ))}
    </SettingsScreen>
  )
}

const styles = themedStyleSheet(() => ({
  card: { alignSelf: 'stretch', padding: spacing.lg, borderRadius: radii.surface, backgroundColor: colors.bgPanel },
  text: { fontSize: 12, lineHeight: 17, color: colors.textSecondary, fontFamily: typography.monoFamily }
}))
