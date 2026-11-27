import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { STATE_WORD, stateColor } from '@/home/AgentRow'
import { prBadge, statusOf, type PrState, type ServerSession } from '@/state/views'
import { AgentGlyph } from '@/ui/AgentGlyph'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '@/ui/theme'

export const ROW_SEPARATOR_INSET = 2 + spacing.lg + 20 + spacing.sm

const PR_ICON = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed
} as const

function prColor(state: PrState): string {
  if (state === 'open') return colors.statusGreen
  if (state === 'merged') return colors.statusPurple
  if (state === 'closed') return colors.statusRed
  return colors.textMuted
}

export function sessionTitle(session: ServerSession): string {
  return session.folder || session.tmux || session.id
}

export function WorkspaceRow({
  session,
  onOpen,
  onMenu
}: {
  session: ServerSession
  onOpen: (session: ServerSession) => void
  onMenu: (session: ServerSession) => void
}) {
  useColorScheme()
  const status = statusOf(session)
  const pr = prBadge(session.pull)
  const PrIcon = pr ? PR_ICON[pr.state] : null
  const title = sessionTitle(session)
  const branch = session.branch && session.branch !== '-' ? session.branch : null
  const ticket = session.ticket && session.ticket !== '-' ? session.ticket : null
  const stoppedReason = status === 'stopped' && session.stopped ? ` · ${session.stopped}` : ''

  return (
    <Pressable
      onPress={() => onOpen(session)}
      onLongPress={() => onMenu(session)}
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${STATE_WORD[status]}`}
      accessibilityHint="Long press for more actions"
      style={({ pressed }) => [styles.row, status === 'stopped' && styles.dimmed, pressed && styles.pressed]}
    >
      <View style={styles.indicator}>
        <AgentGlyph activity={session.activity} stopped={session.stopped} />
      </View>
      <View style={styles.main}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          {pr && PrIcon ? (
            <View style={styles.badge} accessibilityLabel={`Pull request ${pr.label}, ${pr.state}`}>
              <PrIcon size={10} color={prColor(pr.state)} strokeWidth={2.2} />
              <Text style={[styles.badgeText, { color: prColor(pr.state) }]}>{pr.label}</Text>
            </View>
          ) : null}
          {ticket ? (
            <View style={styles.badge}>
              <Text style={[styles.badgeText, { color: colors.textSecondary }]} numberOfLines={1}>
                {ticket}
              </Text>
            </View>
          ) : null}
        </View>
        {branch ? (
          <Text style={styles.branch} numberOfLines={1} ellipsizeMode="middle">
            {branch}
          </Text>
        ) : null}
        <Text style={styles.agent} numberOfLines={1}>
          {session.agent ? `${session.agent} · ` : ''}
          <Text style={{ color: stateColor(status), fontWeight: '600' }}>{STATE_WORD[status]}</Text>
          {stoppedReason}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  pressed: { backgroundColor: colors.bgRaised },
  dimmed: { opacity: 0.6 },
  indicator: { width: 20, paddingTop: 6, marginRight: spacing.sm },
  main: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontSize: 14, lineHeight: 19, fontWeight: '600', color: colors.textPrimary },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  badgeText: { fontSize: 10, fontWeight: '600', fontVariant: ['tabular-nums'] },
  branch: { marginTop: 2, fontSize: 11, color: colors.textMuted, fontFamily: typography.monoFamily },
  agent: { marginTop: 3, fontSize: 11, color: colors.textMuted }
}))
