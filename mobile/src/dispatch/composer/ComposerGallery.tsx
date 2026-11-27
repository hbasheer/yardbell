import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { useServers } from '../../settings/useServers'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { Composer } from './Composer'

export type ComposerGroup = 'empty' | 'typing' | 'busy' | 'mention' | 'task' | 'files' | 'unreadable'

export const COMPOSER_GROUPS: ComposerGroup[] = ['empty', 'typing', 'busy', 'mention', 'task', 'files', 'unreadable']

const sendLater = () => new Promise<void>((resolve) => setTimeout(resolve, 600))
const sendFails = () => Promise.reject(new Error('Dispatch could not be reached. Your message is still here.'))

const MULTILINE = 'Start a session on hp for the webhook fix.\nUse the branch fix-webhook-dedup and keep the change small.\nWhen the specs pass, push it and open a pull request, then tell me which files changed and why the old handler counted a repeated delivery twice.\n\nAlso check the proposal count.'

const FILES = [
  { uri: 'file:///a/screenshot-checkout.png', name: 'screenshot-checkout.png', size: 412_000 },
  { uri: 'file:///a/a-report-with-a-very-long-name-that-has-to-be-cut-somewhere.pdf', name: 'a-report-with-a-very-long-name-that-has-to-be-cut-somewhere.pdf', size: 3_400_000 },
  { uri: 'file:///a/notes.txt', name: 'notes.txt', size: 1_800 }
]

export function ComposerGallery({ group }: { group: ComposerGroup }) {
  useColorScheme()
  const servers = useServers()
  const server = servers?.[0]
  if (!server) return <Text style={styles.title}>Pair a server to see the composer</Text>
  const common = { server, onStop: () => {}, onSend: sendLater }
  const Slot = ({ title, children }: { title: string; children: ReactNode }) => (
    <View style={styles.group}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.slot}>{children}</View>
    </View>
  )
  if (group === 'empty') {
    return (
      <Slot title="Composer: empty, new chat (placeholder, attach, model, approval, Send disabled)">
        <Composer {...common} conversationId={null} busy={false} />
      </Slot>
    )
  }
  if (group === 'typing') {
    return (
      <Slot title="Composer: typing several lines (grows to 7 lines, then scrolls), Send ready">
        <Composer {...common} conversationId="gallery-typing" busy={false} seed={{ text: MULTILINE }} />
      </Slot>
    )
  }
  if (group === 'busy') {
    return (
      <>
        <Slot title="Composer: busy, Send becomes Stop (tap Stop; the busy line shows when Send is refused)">
          <Composer {...common} conversationId="gallery-busy" busy seed={{ text: 'And then run the specs again.' }} />
        </Slot>
        <Slot title="Composer: send fails, the text and files come back with the reason">
          <Composer {...common} onSend={sendFails} conversationId="gallery-fail" busy={false} seed={{ text: 'Stop yardbell-3 and start it again on mac-pro.' }} />
        </Slot>
      </>
    )
  }
  if (group === 'unreadable') {
    return (
      <Slot title="Composer: tap Send, the attachment cannot be read: the text stays once, the file stays, the reason shows">
          <Composer {...common} conversationId="gallery-unreadable" busy={false} seed={{ text: 'Summarise this file.', files: [{ uri: 'file:///missing/report.txt', name: 'report.txt', size: 1200 }] }} />
        </Slot>
    )
  }
  if (group === 'mention') {
    return (
      <Slot title="Composer: @ menu open (machines, sessions, folders)">
        <Composer {...common} conversationId="gallery-mention" busy={false} seed={{ text: 'Ask @y' }} />
      </Slot>
    )
  }
  if (group === 'task') {
    return (
      <Slot title="Composer: / menu open (saved prompts)">
        <Composer {...common} conversationId="gallery-task" busy={false} seed={{ text: '/' }} />
      </Slot>
    )
  }
  return (
    <Slot title="Composer: attachments with long names, and the pre-check error (remove one with the x)">
      <Composer
        {...common}
        conversationId="gallery-files"
        busy={false}
        seed={{ text: 'Summarise these.', files: FILES, error: 'big-scan.png is over 5 MB' }}
      />
    </Slot>
  )
}

const styles = themedStyleSheet(() => ({
  group: { marginBottom: spacing.xl },
  title: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: spacing.sm, paddingHorizontal: spacing.lg },
  slot: { backgroundColor: colors.bgBase }
}))
