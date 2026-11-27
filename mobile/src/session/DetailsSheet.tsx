import { ExternalLink } from 'lucide-react-native'
import { Linking, View } from 'react-native'
import type { ServerSession } from '@/state/views'
import { BottomDrawer } from '@/ui/BottomDrawer'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { SheetHeader } from '@/ui/SheetHeader'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { detailRows } from './chrome'

type Props = {
  visible: boolean
  session: ServerSession | undefined
  serverAddress: string
  onOpenFailed: (error: unknown) => void
  onClose: () => void
}

export function DetailsSheet({ visible, session, serverAddress, onOpenFailed, onClose }: Props) {
  useColorScheme()
  const rows = session ? detailRows(session, serverAddress) : []
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <SheetHeader title="Session details" onClose={onClose} />
      <View style={styles.body}>
        <ListGroup>
          {rows.map((row) => {
            const url = row.url
            return (
              <ListRow
                key={row.key}
                title={row.value}
                wrapTitle
                subtitle={row.label}
                subtitleMono={false}
                accessibilityLabel={`${row.label}, ${row.value}`}
                accessory={url ? <ExternalLink size={16} color={colors.textSecondary} strokeWidth={2} /> : undefined}
                onPress={url ? () => Linking.openURL(url).catch(onOpenFailed) : undefined}
              />
            )
          })}
        </ListGroup>
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }
}))
