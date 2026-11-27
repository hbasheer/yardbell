import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputSelectionChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, ChevronDown, Image as ImageIcon, FileText, Plus, ShieldAlert, ShieldCheck, ShieldX, Square, type LucideIcon } from 'lucide-react-native'
import type { PairedServer } from '../../servers/store'
import { stateQuery } from '../../state/useServerState'
import { ActionSheet } from '../../ui/ActionSheet'
import { bottomBarPadding } from '../../ui/bottomInset'
import { triggerError, triggerSelection } from '../../ui/haptics'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { useKeyboardHeight } from '../../ui/useKeyboardHeight'
import { getDispatchSettings, listPrompts, setDispatchSettings } from '../api'
import { AttachmentError, MAX_FILES, checkAttachments, prepareAttachments, type PickedFile } from '../attachments'
import { deviceFiles } from '../files'
import type { AskAttachment, Backend, SavedPrompt, TaskMark } from '../types'
import { AttachmentStrip } from './AttachmentStrip'
import { asyncDrafts, draftKey, restoreText, saveDraft, switchDraft } from './drafts'
import { MentionMenu } from './MentionMenu'
import { ModelSheet } from './ModelSheet'
import { APPROVALS, approvalOf, currentModel, modelChange, modelsFor, type ApprovalMode } from './models'
import { applyToken, findTrigger, nameItems, pickedTask, taskItems, type MenuItem } from './triggers'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  COMPOSER_CONTROL_SIZE,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_TEXT_SIZE,
  MESSAGE_MAX_HEIGHT,
  MESSAGE_MIN_HEIGHT
} from './sizes'

export const BUSY_TEXT = 'Dispatch is still working on the last message. Stop it or wait, then send.'
const DRAFT_DELAY_MS = 400
const PLACEHOLDER = 'Ask Dispatch anything. @ names a machine, session or folder, / inserts a saved prompt'

export type SendPayload = { text: string; attachments: AskAttachment[]; task?: TaskMark }

export type ComposerProps = {
  server: PairedServer
  conversationId: string | null
  busy: boolean
  backend?: Backend
  onSend: (payload: SendPayload) => Promise<void>
  onStop: () => void
  micSlot?: ReactNode
  seed?: { text?: string; files?: PickedFile[]; error?: string }
  fill?: { text: string; at: number }
}

const APPROVAL_ICON: Record<ApprovalMode, LucideIcon> = { prompt: ShieldCheck, allow: ShieldAlert, deny: ShieldX }

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback)

export function Composer({ server, conversationId, busy, backend, onSend, onStop, micSlot, seed, fill }: ComposerProps) {
  useColorScheme()
  const queryClient = useQueryClient()
  const keyboardHeight = useKeyboardHeight().height
  const safeBottom = useSafeAreaInsets().bottom
  const key = draftKey(server.id, conversationId)

  const [draft, setDraft] = useState({ key, text: seed?.text ?? '' })
  const text = draft.key === key ? draft.text : ''
  const owned = useRef(draft)
  const keyRef = useRef(key)
  keyRef.current = key
  const setText = useCallback((next: string | ((now: string) => string)) => {
    const now = owned.current.key === keyRef.current ? owned.current.text : ''
    owned.current = { key: keyRef.current, text: typeof next === 'function' ? next(now) : next }
    setDraft(owned.current)
  }, [])
  const [selection, setSelection] = useState({ start: (seed?.text ?? '').length, end: (seed?.text ?? '').length })
  const [files, setFiles] = useState<PickedFile[]>(seed?.files ?? [])
  const [error, setError] = useState<string | null>(seed?.error ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const [menuHidden, setMenuHidden] = useState(false)
  const [picked, setPicked] = useState<SavedPrompt[]>([])
  const [sheet, setSheet] = useState<'attach' | 'model' | 'approval' | null>(null)
  const [checking, setChecking] = useState(false)
  const [sending, setSending] = useState(false)
  const [inputHeight, setInputHeight] = useState(MESSAGE_MIN_HEIGHT)
  const loaded = useRef(false)
  const sendingRef = useRef(false)
  const seeded = useRef(seed?.text !== undefined)
  const first = useRef(true)

  useEffect(() => {
    const previous = loaded.current ? owned.current : null
    loaded.current = false
    if (first.current) first.current = false
    else {
      setFiles([])
      setPicked([])
      setError(null)
      setNotice(null)
    }
    let live = true
    switchDraft(asyncDrafts, previous, key).then((saved) => {
      if (!live) return
      loaded.current = true
      if (seeded.current) {
        seeded.current = false
        return
      }
      if (owned.current.key === key && owned.current.text) return
      owned.current = { key, text: saved }
      setDraft(owned.current)
      setSelection({ start: saved.length, end: saved.length })
    })
    return () => {
      live = false
    }
  }, [key])

  useEffect(
    () => () => {
      if (loaded.current && !sendingRef.current) saveDraft(owned.current.key, owned.current.text)
    },
    []
  )

  useEffect(() => {
    if (!loaded.current || (sending && !text)) return
    const timer = setTimeout(() => saveDraft(key, text), DRAFT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [key, text, sending])

  const fillAt = fill?.at
  const fillText = fill?.text
  useEffect(() => {
    if (fillAt === undefined || fillText === undefined) return
    setText(fillText)
    setSelection({ start: fillText.length, end: fillText.length })
    setMenuHidden(true)
  }, [fillAt, fillText, setText])

  const trigger = useMemo(() => (menuHidden || selection.start !== selection.end ? null : findTrigger(text, selection.start)), [menuHidden, selection, text])

  const state = useQuery({ ...stateQuery(server), staleTime: 15_000, enabled: trigger?.kind === 'names' })
  const prompts = useQuery({
    queryKey: ['dispatch', 'prompts', server.id],
    queryFn: () => listPrompts(server),
    staleTime: 15_000,
    enabled: trigger?.kind === 'tasks'
  })
  const settings = useQuery({ queryKey: ['dispatch', 'settings', server.id], queryFn: () => getDispatchSettings(server), staleTime: 15_000 })
  const dispatch = settings.data?.dispatch

  const items = useMemo(() => {
    if (!trigger) return []
    if (trigger.kind === 'tasks') return taskItems(prompts.data ?? [], trigger.query)
    return state.data ? nameItems(state.data, trigger.query) : []
  }, [trigger, prompts.data, state.data])
  const menuLoading = trigger?.kind === 'tasks' ? prompts.isLoading : state.isLoading

  const save = useMutation({
    mutationFn: (change: Parameters<typeof setDispatchSettings>[1]) => setDispatchSettings(server, change),
    onMutate: (change) => {
      queryClient.setQueryData(['dispatch', 'settings', server.id], { dispatch: { ...dispatch, ...change } })
    },
    onError: (e) => {
      triggerError()
      setNotice(messageOf(e, 'Could not save the setting'))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['dispatch', 'settings', server.id] })
  })

  const pick = useCallback(
    (item: MenuItem) => {
      if (!trigger) return
      const next = applyToken(text, trigger, item.token)
      setText(next.text)
      setSelection({ start: next.cursor, end: next.cursor })
      if (item.kind === 'task') {
        const prompt = prompts.data?.find((p) => p.name === item.label)
        if (prompt) setPicked((list) => [...list.filter((p) => p.name !== prompt.name), prompt])
      }
      triggerSelection()
    },
    [trigger, text, prompts.data]
  )

  const addFiles = useCallback(
    async (incoming: PickedFile[]) => {
      if (!incoming.length) return
      const next = [...files, ...incoming]
      setChecking(true)
      setError(null)
      try {
        await checkAttachments(next, backend, deviceFiles)
        setFiles(next)
      } catch (e) {
        triggerError()
        setError(e instanceof AttachmentError ? e.message : messageOf(e, 'Could not read that file'))
      } finally {
        setChecking(false)
      }
    },
    [files, backend]
  )

  const pickPhotos = async () => {
    const room = Math.max(1, MAX_FILES - files.length)
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: room, quality: 1, exif: false })
    if (result.canceled) return
    await addFiles(result.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `photo-${Date.now()}-${i}.jpg`, size: a.fileSize })))
  }

  const pickDocuments = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf', 'text/*'], copyToCacheDirectory: true, multiple: true })
    if (result.canceled) return
    await addFiles(result.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size })))
  }

  const empty = !text.trim() && files.length === 0

  const send = async () => {
    if (busy) {
      setNotice(BUSY_TEXT)
      return
    }
    if (empty || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setNotice(null)
    setError(null)
    const sent = { text, files, picked }
    let cleared = false
    try {
      const attachments = await prepareAttachments(files, backend, deviceFiles)
      cleared = true
      setText('')
      setFiles([])
      setPicked([])
      await onSend({ text: text.trim(), attachments, task: pickedTask(text, picked) })
      saveDraft(key, '')
    } catch (e) {
      triggerError()
      if (cleared) {
        setText((now) => restoreText(sent.text, now))
        setFiles((now) => (now.length ? now : sent.files))
        setPicked(sent.picked)
        setSelection({ start: sent.text.length, end: sent.text.length })
      }
      setError(messageOf(e, 'Could not send the message'))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const onSelectionChange = (event: TextInputSelectionChangeEvent) => setSelection(event.nativeEvent.selection)

  const runsOn: Backend = dispatch?.runs_on === 'codex' ? 'codex' : 'claude'
  const models = modelsFor(runsOn)
  const modelId = currentModel(dispatch)
  const modelLabel = models.find((m) => m.id === modelId)?.label ?? (modelId || 'Default')
  const approval = approvalOf(dispatch)
  const approvalLabel = APPROVALS.find((a) => a.id === approval)?.label ?? 'Ask first'
  const ApprovalIcon = APPROVAL_ICON[approval]
  const agentLabel = runsOn === 'codex' ? 'Codex' : 'Claude Code'
  const keyboardUp = keyboardHeight > 0
  const canSend = !empty && !checking

  return (
    <View style={[styles.wrap, { marginBottom: keyboardHeight, paddingBottom: keyboardUp ? spacing.sm : bottomBarPadding(safeBottom) }]}>
      {trigger ? <MentionMenu kind={trigger.kind} items={items} loading={menuLoading} onPick={pick} /> : null}
      <View style={styles.box}>
        <AttachmentStrip files={files} error={error} onRemove={(index) => setFiles((list) => list.filter((_, at) => at !== index))} />
        <TextInput
          value={text}
          onChangeText={(next) => {
            setText(next)
            setMenuHidden(false)
            if (notice === BUSY_TEXT) setNotice(null)
          }}
          selection={selection}
          onSelectionChange={onSelectionChange}
          onFocus={() => setMenuHidden(false)}
          onBlur={() => setMenuHidden(true)}
          multiline
          placeholder={PLACEHOLDER}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Message Dispatch"
          style={[styles.input, { height: inputHeight }]}
          onContentSizeChange={(event) => setInputHeight(Math.min(MESSAGE_MAX_HEIGHT, Math.max(MESSAGE_MIN_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height))))}
          scrollEnabled
        />
        <View style={styles.actions}>
          <RoundButton label="Attach files" onPress={() => setSheet('attach')} disabled={checking}>
            {checking ? <ActivityIndicator size="small" color={colors.textSecondary} /> : <Plus size={19} color={colors.textPrimary} strokeWidth={2.2} />}
          </RoundButton>
          {micSlot}
          <View style={styles.pills}>
            <Pill label={`Model: ${modelLabel}`} onPress={() => setSheet('model')}>
              <Text style={styles.pillText} numberOfLines={1}>
                {modelLabel}
              </Text>
              <ChevronDown size={13} color={colors.textMuted} />
            </Pill>
            <Pill label={`Approval: ${approvalLabel}`} onPress={() => setSheet('approval')}>
              <ApprovalIcon size={14} color={colors.textSecondary} />
              <Text style={styles.pillText} numberOfLines={1}>
                {approvalLabel}
              </Text>
            </Pill>
          </View>
          {busy ? (
            <RoundButton label="Stop" onPress={onStop} solid>
              <Square size={14} color={colors.bgBase} fill={colors.bgBase} />
            </RoundButton>
          ) : (
            <RoundButton label="Send" onPress={send} solid={canSend} disabled={!canSend && !sending} dim={!canSend}>
              {sending ? <ActivityIndicator size="small" color={colors.bgBase} /> : <ArrowUp size={19} color={canSend ? colors.bgBase : colors.textMuted} strokeWidth={2.4} />}
            </RoundButton>
          )}
        </View>
      </View>
      {notice ? (
        <Text style={styles.notice} accessibilityRole="alert">
          {notice}
        </Text>
      ) : null}

      <ActionSheet
        visible={sheet === 'attach'}
        title="Attach"
        message={`Images, PDFs and text files, up to ${MAX_FILES} per message.`}
        actions={[
          { label: 'Photos', icon: ImageIcon, onPress: () => void pickPhotos(), closeBeforePress: true },
          { label: 'Files', icon: FileText, onPress: () => void pickDocuments(), closeBeforePress: true }
        ]}
        onClose={() => setSheet(null)}
      />
      <ActionSheet
        visible={sheet === 'approval'}
        title="When Dispatch wants to act"
        message="A setting of this server. It applies from the next message."
        actions={APPROVALS.map((a) => ({
          label: a.label,
          hint: a.detail,
          icon: APPROVAL_ICON[a.id],
          checked: a.id === approval,
          onPress: () => save.mutate({ approval: a.id })
        }))}
        onClose={() => setSheet(null)}
      />
      <ModelSheet
        visible={sheet === 'model'}
        models={models}
        current={modelId}
        agentLabel={agentLabel}
        onPick={(id) => save.mutate(modelChange(dispatch, id))}
        onClose={() => setSheet(null)}
      />
    </View>
  )
}

function RoundButton({ label, onPress, children, solid = false, dim = false, disabled = false }: { label: string; onPress: () => void; children: ReactNode; solid?: boolean; dim?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.round, solid ? styles.roundSolid : null, dim ? styles.roundDim : null, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  )
}

function Pill({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
      {children}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  wrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  box: {
    padding: spacing.md,
    borderRadius: radii.floating,
    borderWidth: 1,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  },
  input: {
    width: '100%',
    minHeight: MESSAGE_MIN_HEIGHT,
    maxHeight: MESSAGE_MAX_HEIGHT,
    fontSize: COMPOSER_TEXT_SIZE,
    lineHeight: COMPOSER_LINE_HEIGHT,
    color: colors.textPrimary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    textAlignVertical: 'top',
    outlineWidth: 0
  },
  actions: { marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pills: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs },
  pill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: COMPOSER_CONTROL_SIZE,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.composerControl
  },
  pillText: { flexShrink: 1, color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  round: {
    width: COMPOSER_CONTROL_SIZE,
    height: COMPOSER_CONTROL_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.composerControl
  },
  roundSolid: { backgroundColor: colors.surfaceBright },
  roundDim: { backgroundColor: colors.composerControl },
  pressed: { opacity: feedback.pressedOpacity },
  notice: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: spacing.sm, paddingHorizontal: spacing.sm }
}))

