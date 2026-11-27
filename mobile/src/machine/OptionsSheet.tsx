import { Switch, View } from 'react-native'
import { BottomDrawer } from '@/ui/BottomDrawer'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { SectionHeader } from '@/ui/SectionHeader'
import { SheetHeader } from '@/ui/SheetHeader'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { GROUP_LABELS, GROUP_ORDER, type MachineOptions } from './options'

type Props = {
  visible: boolean
  options: MachineOptions
  onChange: (next: MachineOptions) => void
  onClose: () => void
}

export function OptionsSheet({ visible, options, onChange, onClose }: Props) {
  useColorScheme()
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <SheetHeader title="Workspace options" onClose={onClose} />
      <View style={styles.body}>
        <SectionHeader title="Group by" first />
        <ListGroup>
          {GROUP_ORDER.map((group) => (
            <ListRow
              key={group}
              title={GROUP_LABELS[group]}
              selected={options.groupBy === group}
              onPress={() => onChange({ ...options, groupBy: group })}
            />
          ))}
        </ListGroup>
        <SectionHeader title="Show" />
        <ListGroup>
          <ListRow
            key="stopped"
            title="Stopped sessions"
            accessibilityRole="switch"
            checked={options.showStopped}
            accessory={
              <Switch
                value={options.showStopped}
                onValueChange={(showStopped) => onChange({ ...options, showStopped })}
                trackColor={{ true: colors.accentBlue }}
                accessibilityLabel="Stopped sessions"
              />
            }
            onPress={() => onChange({ ...options, showStopped: !options.showStopped })}
          />
        </ListGroup>
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }
}))
