import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { ChevronLeft, Plus, RotateCcw, Search, Settings2, Trash2, Zap } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { routeIfSignedOut } from '@/api/signedOut'
import type { PairedServer } from '@/servers/store'
import { BottomDrawer } from '@/ui/BottomDrawer'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { LIST_LEADING_INSET, ListGroup } from '@/ui/ListGroup'
import { ListRow } from '@/ui/ListRow'
import { NavBar, NavBarSubtitleText } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { PageField } from '@/ui/PageField'
import { SearchField } from '@/ui/SearchField'
import { SheetHeader } from '@/ui/SheetHeader'
import { LoadErrorState, NoMatchState, StateView } from '@/ui/StateView'
import { SwipeCell } from '@/ui/SwipeCell'
import { colors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'
import { deletePrompt, listPrompts, restorePrompts, savePrompt } from '../api'
import type { SavedPrompt } from '../types'
import { historyHref } from './history'
import {
  canSave,
  clampName,
  clash,
  deleteNote,
  emptyForm,
  filterPrompts,
  formOf,
  hasHiddenDefaults,
  NAME_LIMIT,
  runHref,
  savedMessage,
  versionLine,
  type PromptForm
} from './model'

type Notice = { tone: 'error' | 'info'; text: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function PromptsScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const queryClient = useQueryClient()
  const key = ['dispatch', 'prompts', server.id]
  const query = useQuery({ queryKey: key, queryFn: () => listPrompts(server) })
  const prompts = query.data
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [form, setForm] = useState<PromptForm>(emptyForm())
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SavedPrompt | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const adopt = (list: SavedPrompt[]) => queryClient.setQueryData(key, list)

  const fail = (error: unknown, prefix: string) => {
    if (routeIfSignedOut(error, server.id)) return
    setNotice({ tone: 'error', text: `${prefix}: ${messageOf(error)}` })
  }

  const openForm = (next: PromptForm) => {
    setForm(next)
    setFormError(null)
    setEditing(true)
  }

  const save = async () => {
    if (saving || !canSave(form)) return
    const taken = clash(prompts ?? [], form)
    if (taken) {
      setFormError(taken)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      adopt(await savePrompt(server, { name: form.name, text: form.text, replacing: form.editing }))
      setNotice({ tone: 'info', text: savedMessage(form.name) })
      setEditing(false)
    } catch (error) {
      if (!routeIfSignedOut(error, server.id)) setFormError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    const target = deleting
    setDeleting(null)
    if (!target) return
    setNotice(null)
    try {
      adopt(await deletePrompt(server, target.name))
    } catch (error) {
      fail(error, 'Could not delete the saved prompt')
    }
  }

  const confirmRestore = async () => {
    setRestoring(false)
    setNotice(null)
    try {
      adopt(await restorePrompts(server))
      setNotice({ tone: 'info', text: 'Default prompts restored.' })
    } catch (error) {
      fail(error, 'Could not restore the default prompts')
    }
  }

  const pull = async () => {
    setRefreshing(true)
    await query.refetch()
    setRefreshing(false)
  }

  const openHistory = () => {
    const name = form.editing
    if (!name) return
    setEditing(false)
    router.push(historyHref(server.id, name) as never)
  }

  const run = (prompt: SavedPrompt) => router.push(runHref(server.id, prompt.name) as never)

  const toggleSearch = () => {
    if (searching) setSearch('')
    setSearching(!searching)
  }

  const shown = filterPrompts(prompts ?? [], search)
  const renderRow = (prompt: SavedPrompt) => (
    <SwipeCell
      key={prompt.name}
      trailing={{
        label: 'Delete',
        accessibilityLabel: `Delete ${prompt.name}`,
        icon: Trash2,
        background: colors.statusRed,
        foreground: colors.onStatusRed,
        onPress: () => setDeleting(prompt)
      }}
    >
      {(guard) => (
        <View style={[styles.rowSurface, styles.rowLine]}>
          <View style={styles.fill}>
            <ListRow
              title={prompt.name}
              subtitle={prompt.text}
              leading={<Zap size={18} color={colors.textMuted} strokeWidth={2} />}
              onPress={guard(() => run(prompt))}
              accessibilityLabel={`Run ${prompt.name}`}
            />
          </View>
          <Pressable
            onPress={guard(() => openForm(formOf(prompt)))}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${prompt.name}`}
            style={styles.edit}
          >
            <Settings2 size={18} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>
        </View>
      )}
    </SwipeCell>
  )

  let body
  if (query.isPending) body = <StateView loading title="Loading saved prompts" />
  else if (!prompts) body = <LoadErrorState message={messageOf(query.error)} onRetry={() => void query.refetch()} />
  else if (!filterPrompts(prompts, '').length && !hasHiddenDefaults(prompts))
    body = (
      <StateView
        icon={Zap}
        title="No saved prompts yet"
        message="Save a request you make often. Tap it later to run it as a new chat."
        action={{ label: 'New prompt', onPress: () => openForm(emptyForm()) }}
      />
    )
  else
    body = (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
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
        {shown.length > 0 ? (
          <ListGroup surface="page" separatorInset={LIST_LEADING_INSET}>
            {shown.map(renderRow)}
          </ListGroup>
        ) : filterPrompts(prompts, '').length === 0 ? (
          <Text style={styles.hint}>No saved prompts yet.</Text>
        ) : (
          <NoMatchState message={`No saved prompt matches "${search.trim()}".`} onClear={() => setSearch('')} />
        )}
        {hasHiddenDefaults(prompts) ? (
          <Pressable onPress={() => setRestoring(true)} accessibilityRole="button" style={styles.restore}>
            <RotateCcw size={15} color={colors.textSecondary} strokeWidth={2.1} />
            <Text style={styles.restoreText}>Restore default prompts</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    )

  return (
    <View style={[styles.fill, { backgroundColor: colors.bgBase, paddingTop: insets.top }]}>
      <NavBar
        title="Saved prompts"
        subtitle={serverCount > 1 ? <NavBarSubtitleText>{server.machine}</NavBarSubtitleText> : undefined}
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />}
        trailing={
          <View style={styles.actions}>
            <NavBarButton icon={Search} accessibilityLabel="Search saved prompts" active={searching} onPress={toggleSearch} />
            <NavBarButton icon={Plus} accessibilityLabel="New prompt" onPress={() => openForm(emptyForm())} />
          </View>
        }
      />
      {searching ? (
        <View style={styles.search}>
          <SearchField value={search} onChangeText={setSearch} placeholder="Search saved prompts" autoFocus onClear={() => setSearch('')} />
        </View>
      ) : null}
      {notice ? <Text style={[styles.notice, notice.tone === 'error' && styles.error]}>{notice.text}</Text> : null}
      {body}
      <BottomDrawer visible={editing} onClose={() => !saving && setEditing(false)}>
        <SheetHeader
          title={form.editing ? 'Edit saved prompt' : 'New saved prompt'}
          leading={{ label: 'Cancel', onPress: () => setEditing(false), disabled: saving }}
          trailing={{ label: 'Save', onPress: () => void save(), disabled: !canSave(form), busy: saving }}
        />
        <View style={styles.form}>
          <Text style={styles.label}>Name</Text>
          <PageField
            value={form.name}
            onChangeText={(name) => setForm({ ...form, name: clampName(name) })}
            maxLength={NAME_LIMIT}
            placeholder="Fix a bug"
            autoCapitalize="sentences"
            editable={!saving}
            accessibilityLabel="Name"
            style={styles.field}
          />
          <Text style={[styles.counter, form.name.length > NAME_LIMIT && styles.error]}>
            {form.name.length} of {NAME_LIMIT}
          </Text>
          <Text style={styles.label}>What to ask Dispatch</Text>
          <PageField
            value={form.text}
            onChangeText={(text) => setForm({ ...form, text })}
            multiline
            textAlignVertical="top"
            placeholder="Describe the task in plain words"
            editable={!saving}
            accessibilityLabel="What to ask Dispatch"
            style={styles.textBox}
          />
          {formVersion(prompts, form) ? (
            <View style={styles.versionRow}>
              <Text style={styles.version}>{formVersion(prompts, form)}</Text>
              <Pressable onPress={openHistory} disabled={saving} hitSlop={8} accessibilityRole="link" accessibilityLabel={`History of ${form.name}`}>
                <Text style={styles.historyLink}>History</Text>
              </Pressable>
            </View>
          ) : null}
          {formError ? <Text style={styles.formError}>{formError}</Text> : null}
        </View>
      </BottomDrawer>
      <ConfirmModal
        visible={deleting !== null}
        title={deleting ? `Delete the saved prompt "${deleting.name}"?` : 'Delete the saved prompt?'}
        message={deleting ? deleteNote(deleting) : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmModal
        visible={restoring}
        title="Restore default prompts?"
        message="Defaults you deleted come back, and defaults you changed return to their original text. Prompts you made yourself stay."
        confirmLabel="Restore"
        onConfirm={() => void confirmRestore()}
        onCancel={() => setRestoring(false)}
      />
    </View>
  )
}

function formVersion(prompts: SavedPrompt[] | undefined, form: PromptForm) {
  const current = form.editing ? prompts?.find((prompt) => prompt.name === form.editing) : undefined
  return current ? versionLine(current) : null
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  actions: { flexDirection: 'row', alignItems: 'center' },
  rowSurface: { backgroundColor: colors.bgPanel },
  rowLine: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.sm },
  search: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  notice: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, fontSize: 13, color: colors.textSecondary },
  error: { color: colors.statusRed },
  hint: { paddingVertical: spacing.xl, textAlign: 'center', fontSize: 13, color: colors.textMuted },
  edit: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radii.control },
  restore: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  restoreText: { fontSize: 14, fontWeight: '500', color: colors.textSecondary },
  form: { paddingBottom: spacing.lg, gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginTop: spacing.sm },
  counter: { alignSelf: 'flex-end', fontSize: 11, color: colors.textMuted },
  field: { backgroundColor: colors.sheetGroup },
  textBox: { backgroundColor: colors.sheetGroup, minHeight: 140, maxHeight: 220, paddingTop: spacing.md },
  versionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  version: { fontSize: 12, color: colors.textMuted },
  historyLink: { fontSize: 12, fontWeight: '600', color: colors.accentBlue, textDecorationLine: 'underline' },
  formError: { fontSize: 13, color: colors.statusRed, marginTop: spacing.sm }
}))
