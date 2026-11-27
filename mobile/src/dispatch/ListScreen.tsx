import { useRouter } from 'expo-router'
import { Ellipsis, Inbox, MessagesSquare, Plus, Search, Server, Trash2 } from 'lucide-react-native'
import { useRef, useState } from 'react'
import { RefreshControl, ScrollView, Text, View, type HostInstance } from 'react-native'
import { routeIfSignedOut } from '@/api/signedOut'
import { ServerError } from '@/api/client'
import { HeaderIconButton, HomeHeader } from '@/home/HomeHeader'
import { HomeSectionHeading } from '@/home/HomeSectionHeading'
import { inboxHref } from '@/inbox/model'
import type { PairedServer } from '@/servers/store'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { LIST_LEADING_INSET, ListGroup } from '@/ui/ListGroup'
import { PullDownMenu } from '@/ui/PullDownMenu'
import { SearchField } from '@/ui/SearchField'
import { SwipeCell } from '@/ui/SwipeCell'
import { LoadErrorState, NoMatchState, StateView } from '@/ui/StateView'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { clearConversations, deleteConversation } from './api'
import { ChatRow } from './ChatRow'
import {
  BUSY_DELETE,
  clearedMessage,
  dispatchHref,
  filterRows,
  groupByServer,
  newChatHref,
  promptsHref,
  type ConversationRow
} from './listModel'

type Props = {
  servers: readonly PairedServer[]
  rows: ConversationRow[]
  ready: boolean
  errors: { serverId: string; machine: string; message: string }[]
  refresh: () => Promise<void>
  bottomPad: number
}

type Notice = { tone: 'error' | 'info'; text: string }
type Picker = { title: string; run: (server: PairedServer) => void }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function ListScreen({ servers, rows, ready, errors, refresh, bottomPad }: Props) {
  useColorScheme()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [deleting, setDeleting] = useState<ConversationRow | null>(null)
  const [clearing, setClearing] = useState<PairedServer | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const menuRef = useRef<HostInstance>(null)

  const many = servers.length > 1
  const shown = filterRows(rows, query)
  const groups = many ? groupByServer(shown) : []
  const serverOf = (id: string) => servers.find((server) => server.id === id)

  const onServer = (title: string, run: (server: PairedServer) => void) => {
    if (servers.length === 1) run(servers[0])
    else if (many) setPicker({ title, run })
  }

  const open = (row: ConversationRow) => router.push(dispatchHref(row.serverId, row.id) as never)

  const toggleSearch = () => {
    if (searching) setQuery('')
    setSearching(!searching)
  }

  const confirmDelete = async () => {
    const target = deleting
    setDeleting(null)
    const server = target && serverOf(target.serverId)
    if (!target || !server) return
    setNotice(null)
    try {
      await deleteConversation(server, target.id)
    } catch (error) {
      if (routeIfSignedOut(error, server.id)) return
      const text =
        error instanceof ServerError && error.status === 409
          ? BUSY_DELETE
          : `Could not delete the chat: ${messageOf(error)}`
      setNotice({ tone: 'error', text })
    }
    await refresh()
  }

  const confirmClear = async () => {
    const server = clearing
    setClearing(null)
    if (!server) return
    setNotice(null)
    try {
      const { kept } = await clearConversations(server)
      setNotice({ tone: 'info', text: clearedMessage(kept) })
    } catch (error) {
      if (routeIfSignedOut(error, server.id)) return
      setNotice({ tone: 'error', text: `Could not clear the chats: ${messageOf(error)}` })
    }
    await refresh()
  }

  const pull = async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }

  const menu: ActionSheetAction[] = [
    { label: 'New chat', icon: Plus, onPress: () => onServer('Which server for the new chat?', (s) => router.push(newChatHref(s.id) as never)) },
    {
      label: 'Saved prompts',
      icon: MessagesSquare,
      onPress: () => onServer('Which server for saved prompts?', (s) => router.push(promptsHref(s.id) as never))
    },
    { label: 'Inbox', icon: Inbox, onPress: () => onServer('Which server for the inbox?', (s) => router.push(inboxHref(s.id) as never)) },
    {
      label: 'Clear all',
      icon: Trash2,
      destructive: true,
      onPress: () => onServer('Which server to clear?', setClearing)
    }
  ]

  const renderRow = (row: ConversationRow) => (
    <SwipeCell
      key={`${row.serverId}:${row.id}`}
      trailing={{
        label: 'Delete',
        accessibilityLabel: `Delete ${row.title || 'this chat'}`,
        icon: Trash2,
        background: colors.statusRed,
        foreground: colors.onStatusRed,
        onPress: () => setDeleting(row)
      }}
    >
      {(guard) => (
        <View style={styles.rowSurface}>
          <ChatRow row={row} onPress={guard(() => open(row))} />
        </View>
      )}
    </SwipeCell>
  )

  const allFailed = errors.length === servers.length && rows.length === 0
  let body
  if (!ready && errors.length < servers.length) body = <StateView loading title="Loading chats" />
  else if (allFailed)
    body = <LoadErrorState message={errors[0]?.message ?? 'Could not load the chats.'} onRetry={() => void refresh()} />
  else if (rows.length === 0)
    body = (
      <StateView
        icon={MessagesSquare}
        title="No chats yet"
        message="Ask Dispatch to start a session, check on one or run a review."
        action={{ label: 'New chat', onPress: () => onServer('Which server for the new chat?', (s) => router.push(newChatHref(s.id) as never)) }}
      />
    )
  else if (shown.length === 0)
    body = <NoMatchState message={`No chat matches "${query.trim()}".`} onClear={() => setQuery('')} />
  else
    body = (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void pull()}
            tintColor={colors.textSecondary}
            colors={[colors.textSecondary]}
            progressBackgroundColor={colors.bgRaised}
          />
        }
      >
        {many ? (
          groups.map((group, index) => (
            <View key={group.serverId}>
              <HomeSectionHeading title={group.machine} count={group.rows.length} first={index === 0} />
              <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
                {group.rows.map(renderRow)}
              </ListGroup>
            </View>
          ))
        ) : (
          <View style={styles.flat}>
            <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
              {shown.map(renderRow)}
            </ListGroup>
          </View>
        )}
      </ScrollView>
    )

  return (
    <View style={styles.fill}>
      <HomeHeader title="Dispatch">
        <HeaderIconButton icon={Search} label="Search chats" onPress={toggleSearch} active={searching} />
        <HeaderIconButton
          icon={Plus}
          label="New chat"
          onPress={() => onServer('Which server for the new chat?', (s) => router.push(newChatHref(s.id) as never))}
        />
        <HeaderIconButton icon={Ellipsis} label="More" onPress={() => setMenuOpen(true)} active={menuOpen} anchorRef={menuRef} />
      </HomeHeader>
      {searching ? (
        <View style={styles.search}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search chats" autoFocus onClear={() => setQuery('')} />
        </View>
      ) : null}
      {notice ? <Text style={[styles.notice, notice.tone === 'error' && styles.error]}>{notice.text}</Text> : null}
      {errors.length > 0 && !allFailed ? (
        <Text style={[styles.notice, styles.error]}>
          {errors.map((error) => `Could not refresh ${error.machine}: ${error.message}`).join(' ')}
        </Text>
      ) : null}
      {body}
      <PullDownMenu visible={menuOpen} anchorRef={menuRef} groups={[menu]} onClose={() => setMenuOpen(false)} />
      <ActionSheet
        visible={picker !== null}
        title={picker?.title}
        actions={servers.map((server) => ({
          label: server.machine,
          icon: Server,
          onPress: () => picker?.run(server)
        }))}
        onClose={() => setPicker(null)}
      />
      <ConfirmModal
        visible={deleting !== null}
        title="Delete this chat?"
        message={deleting?.title}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmModal
        visible={clearing !== null}
        title={many && clearing ? `Clear all chats on ${clearing.machine}?` : 'Clear all chats?'}
        message="Chats that are still working stay."
        confirmLabel="Clear all"
        destructive
        onConfirm={() => void confirmClear()}
        onCancel={() => setClearing(null)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  flat: { marginTop: spacing.xs },
  rowSurface: { backgroundColor: colors.bgPanel },
  search: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  notice: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, fontSize: 13, color: colors.textSecondary },
  error: { color: colors.statusRed }
}))
