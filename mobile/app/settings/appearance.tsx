import { SettingsFooter, SettingsScreen } from '@/settings/SettingsScreen'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { SectionHeader } from '@/ui/SectionHeader'
import { setAppearancePreference, useAppearancePreference, type AppearancePreference } from '@/ui/theme'

const CHOICES: { id: AppearancePreference; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

export default function Appearance() {
  const preference = useAppearancePreference()
  return (
    <SettingsScreen title="Appearance">
      <SectionHeader title="Theme" first />
      <ListGroup>
        {CHOICES.map(({ id, label }) => (
          <ListRow
            key={id}
            title={label}
            selected={preference === id}
            onPress={() => {
              setAppearancePreference(id).catch((error) => console.error('Could not save the appearance', error))
            }}
          />
        ))}
      </ListGroup>
      <SettingsFooter>System follows your phone's light or dark setting.</SettingsFooter>
    </SettingsScreen>
  )
}
