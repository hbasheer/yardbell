import { Check, Plus } from 'lucide-react-native'
import { View } from 'react-native'
import { STATE_WORD } from '@/home/AgentRow'
import { previewParts } from '@/home/presentation'
import { sessionTitle } from '@/machine/WorkspaceRow'
import { statusOf, type ServerSession } from '@/state/views'
import { AgentGlyph } from '@/ui/AgentGlyph'
import { BottomDrawer } from '@/ui/BottomDrawer'
import { ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { NavBarButton } from '@/ui/NavBarButton'
import { SectionHeader } from '@/ui/SectionHeader'
import { SheetHeader } from '@/ui/SheetHeader'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { tabSections } from './chrome'

type Props = {
  visible: boolean
  sessions: ServerSession[]
  current: string
  newDisabled: boolean
  onSwitch: (session: ServerSession) => void
  onNew: () => void
  onClose: () => void
}

export function TabsSheet({ visible, sessions, current, newDisabled, onSwitch, onNew, onClose }: Props) {
  useColorScheme()
  const sections = tabSections(sessions)
  const title = sessions.length === 1 ? '1 tab' : `${sessions.length} tabs`
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <SheetHeader
        title={title}
        onClose={onClose}
        trailingButtons={<NavBarButton icon={Plus} accessibilityLabel="New session" disabled={newDisabled} onPress={onNew} />}
      />
      <View style={styles.body}>
        {sections.map((section, index) => (
          <View key={section.group}>
            {sections.length > 1 ? <SectionHeader title={section.title} first={index === 0} /> : null}
            <ListGroup>
              {section.sessions.map((session) => {
                const isCurrent = session.tmux === current
                const rest = previewParts(session)
                return (
                  <ListRow
                    key={session.id}
                    title={sessionTitle(session)}
                    subtitle={[STATE_WORD[statusOf(session)], rest].filter(Boolean).join(' · ')}
                    accessibilityLabel={`${sessionTitle(session)}, ${STATE_WORD[statusOf(session)]}${isCurrent ? ', current' : ''}`}
                    leading={<AgentGlyph activity={session.activity} stopped={session.stopped} />}
                    accessory={isCurrent ? <Check size={17} color={colors.accentBlue} strokeWidth={2.4} /> : undefined}
                    onPress={() => {
                      if (!isCurrent) onSwitch(session)
                      onClose()
                    }}
                  />
                )
              })}
            </ListGroup>
          </View>
        ))}
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }
}))
