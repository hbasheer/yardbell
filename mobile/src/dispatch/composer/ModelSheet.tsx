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
  title?: string
  searchLabel?: string
  allowCustom?: boolean
  note?: string
  onPick: (id: string) => void
  onClose: () => void
}

const COMPOSER_NOTE = 'The change applies from the next message. It is a setting of this server, the same one the web page uses.'

export function ModelSheet({ visible, models, current, agentLabel, title = 'Model', searchLabel = 'models', allowCustom = false, note = COMPOSER_NOTE, onPick, onClose }: Props) {
  useColorScheme()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterModels(models, query), [models, query])
  const typed = query.trim()
  const custom = allowCustom && typed && !models.some((m) => m.id === typed)
  const choose = (id: string) => {
    onPick(id)
    onClose()
  }
  return (
    <BottomDrawer visible={visible} onClose={onClose} onAfterClose={() => setQuery('')}>
      <SheetHeader title={title} subtitle={agentLabel} onClose={onClose} />
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={allowCustom ? 'Search or type a model' : `Search ${searchLabel}`}
        accessibilityLabel={`Search ${searchLabel}`}
        style={styles.search}
      />
      {shown.length || custom ? (
        <ListGroup>
          {shown.map((model) => (
            <ListRow key={model.id || 'default'} title={model.label} subtitle={model.description} selected={model.id === current} onPress={() => choose(model.id)} />
          ))}
          {custom ? <ListRow key="custom" title={`Use ${typed}`} accent onPress={() => choose(typed)} /> : null}
        </ListGroup>
      ) : (
        <Text style={styles.note}>Nothing matches.</Text>
      )}
      <View style={styles.footer}>
        <Text style={styles.note}>{note}</Text>
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  search: { marginBottom: spacing.md },
  footer: { marginTop: spacing.md },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.xs }
}))
