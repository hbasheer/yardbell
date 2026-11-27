import { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { BottomDrawer } from '../../ui/BottomDrawer'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { SearchField } from '../../ui/SearchField'
import { SheetHeader } from '../../ui/SheetHeader'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { filterModels, type ModelChoice } from './models'

type Props = {
  visible: boolean
  models: ModelChoice[]
  current: string
  agentLabel: string
  onPick: (id: string) => void
  onClose: () => void
}

export function ModelSheet({ visible, models, current, agentLabel, onPick, onClose }: Props) {
  useColorScheme()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterModels(models, query), [models, query])
  return (
    <BottomDrawer visible={visible} onClose={onClose} onAfterClose={() => setQuery('')}>
      <SheetHeader title="Model" subtitle={agentLabel} onClose={onClose} />
      <SearchField value={query} onChangeText={setQuery} placeholder="Search models" accessibilityLabel="Search models" style={styles.search} />
      {shown.length ? (
        <ListGroup>
          {shown.map((model) => (
            <ListRow
              key={model.id}
              title={model.label}
              subtitle={model.description}
              selected={model.id === current}
              onPress={() => {
                onPick(model.id)
                onClose()
              }}
            />
          ))}
        </ListGroup>
      ) : (
        <Text style={styles.note}>No model matches</Text>
      )}
      <View style={styles.footer}>
        <Text style={styles.note}>The change applies from the next message. It is a setting of this server, the same one the web page uses.</Text>
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  search: { marginBottom: spacing.md },
  footer: { marginTop: spacing.md },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.xs }
}))
