// The message box follows Orca's chat composer (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor, type JSONContent, type NodeViewProps } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import {
  ArrowUp,
  AtSign,
  Bookmark,
  Check,
  ChevronDown,
  Ellipsis,
  FileText,
  Folder,
  Keyboard,
  Mic,
  Plus,
  ScanLine,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Slash,
  Square,
  SquareTerminal,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Hint } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { catalogFor, liveCatalog, type Listed } from '@/lib/agent-models'
import { cn } from '@/lib/class-names'
import type { YardbellState } from '@/lib/state'
import type { Legacy } from './legacy'
import { CLAUDE_MODELS, type RunsOn, type Task } from './model'

export type Attached = { file: File; kind: 'image' | 'pdf' | 'text'; url: string }
export type ComposerHandle = {
  insert: (text: string) => void
  fill: (text: string) => void
  focus: () => void
  restore: (text: string, files: Attached[]) => void
}

type Kind = 'machine' | 'session' | 'folder'
type Item = { group: string; kind: Kind | 'task'; label: string; detail: string; token: string; rank: number }

const SEND_KEY = 'yardbell.dispatch.send'
const DRAFTS_KEY = 'yardbell.dispatch.drafts'
const HISTORY_KEY = 'yardbell.dispatch.history'
const HISTORY_SIZE = 50
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'
// "/" and "@" open a menu only at the start of a word, so a path or an email address never does.
const TRIGGER = /(?:^|\s)(?:\/([^\s/]*)|@([^\s@]*))$/
const KIND_ICON: Record<string, LucideIcon> = { machine: Server, session: SquareTerminal, folder: Folder, task: Zap }
const APPROVAL: Record<string, { label: string; detail: string; icon: LucideIcon }> = {
  prompt: { label: 'Ask first', detail: 'Ask me to approve each step', icon: ShieldCheck },
  allow: { label: 'Go ahead', detail: 'Start, stop and type into sessions without asking', icon: ShieldAlert },
  deny: { label: 'Refuse', detail: 'Refuse each step, unless a rule allows it', icon: ShieldX }
}

function read<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) || 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}
const short = (p: string) => String(p ?? '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')

function rank(query: string, label: string, ...more: unknown[]) {
  const name = label.toLowerCase()
  if (!query || name.startsWith(query)) return 0
  if (name.split(/[\s/._-]+/).some((w) => w.startsWith(query))) return 1
  if (name.includes(query)) return 2
  return more.some((t) =>
    String(t ?? '')
      .toLowerCase()
      .includes(query)
  )
    ? 3
    : null
}

// Dispatch's tools find a session by its tmux name and a folder by its label, so those are what a
// pill sends, with the machine added when the same name is on more than one.
type FolderInfo = { label: string; machine: string; path: string; branch?: string }
function names(state: YardbellState, query: string): Item[] {
  const twice = (list: string[]) => new Set(list.filter((x, i) => list.indexOf(x) !== i))
  const sessions = state.sessions.filter((s) => s.tmux && !s.stale)
  const folders = ((state as { folders?: FolderInfo[] }).folders || []) as FolderInfo[]
  const sameSession = twice(sessions.map((s) => String(s.tmux)))
  const sameFolder = twice(folders.map((f) => f.label))
  const out: (Item | null)[] = [
    ...state.machines.map((m) => {
      const r = rank(query, m.name)
      return r === null ? null : { group: 'Machines', kind: 'machine' as const, label: m.name, detail: m.up ? 'up' : 'down', token: m.name, rank: r }
    }),
    ...sessions.map((s) => {
      const tmux = String(s.tmux)
      const r = rank(query, tmux, s.machine, s.folder, s.branch)
      return r === null
        ? null
        : {
            group: 'Sessions',
            kind: 'session' as const,
            label: tmux,
            detail: [`${s.agent} on ${s.machine}`, short(String(s.folder || '')), s.branch].filter(Boolean).join(' · '),
            token: sameSession.has(tmux) ? `${tmux} on ${s.machine}` : tmux,
            rank: r
          }
    }),
    ...folders.map((f) => {
      const outside = f.label.startsWith('/')
      const label = outside ? f.label.split('/').filter(Boolean).pop() || f.label : f.label
      const r = rank(query, label, f.machine, f.path)
      return r === null
        ? null
        : {
            group: 'Folders',
            kind: 'folder' as const,
            label,
            detail: [`on ${f.machine}`, f.branch, outside && short(f.path)].filter(Boolean).join(' · '),
            token: sameFolder.has(f.label) ? `${f.label} on ${f.machine}` : f.label,
            rank: r
          }
    })
  ]
  return (out.filter(Boolean) as Item[]).sort((a, b) => a.rank - b.rank).slice(0, 40)
}

function Pill({ icon: Icon, label, title, selected }: { icon: LucideIcon; label: string; title?: string; selected: boolean }) {
  return (
    <NodeViewWrapper
      as="span"
      title={title}
      data-selected={selected}
      className="mx-px inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary px-1.5 align-baseline text-xs leading-5 font-medium text-muted-foreground select-none data-[selected=true]:ring-1 data-[selected=true]:ring-ring [&_svg]:size-3 [&_svg]:shrink-0"
    >
      <Icon aria-hidden />
      <span className="truncate">{label}</span>
    </NodeViewWrapper>
  )
}

function NamePill({ node, selected }: NodeViewProps) {
  const { kind, label, token } = node.attrs as { kind: Kind; label: string; token: string }
  return <Pill icon={KIND_ICON[kind] || AtSign} label={label} title={`${kind[0].toUpperCase()}${kind.slice(1)}: ${token}`} selected={selected} />
}

function TaskPill({ node, selected }: NodeViewProps) {
  const { name, text } = node.attrs as { name: string; text: string }
  return <Pill icon={Zap} label={name} title={text} selected={selected} />
}

// A name picked under @: the pill shows it, and the message carries the name Dispatch's tools look up.
const NameNode = Node.create({
  name: 'dispatchName',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ kind: { default: 'session' }, label: { default: '' }, token: { default: '' } }),
  addNodeView: () => ReactNodeViewRenderer(NamePill),
  renderText: ({ node }) => node.attrs.token,
  parseHTML: () => [{ tag: 'span[data-dispatch-name]' }],
  renderHTML: ({ node }) => ['span', { 'data-dispatch-name': node.attrs.token }, node.attrs.label]
})

// A saved task picked under /: the pill shows its name, and the message carries its text.
const TaskNode = Node.create({
  name: 'dispatchTask',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ name: { default: '' }, text: { default: '' } }),
  addNodeView: () => ReactNodeViewRenderer(TaskPill),
  renderText: ({ node }) => node.attrs.text,
  parseHTML: () => [{ tag: 'span[data-dispatch-task]' }],
  renderHTML: ({ node }) => ['span', { 'data-dispatch-task': node.attrs.name }, node.attrs.name]
})

const docOf = (text: string): JSONContent => ({
  type: 'doc',
  content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }))
})
const textOf = (editor: Editor) => editor.getText({ blockSeparator: '\n' })

type Menu = { kind: 'names' | 'tasks'; query: string; from: number; to: number }

export const Composer = forwardRef<
  ComposerHandle,
  {
    conversation: string | null
    busy: boolean
    backend: string
    runsOn: RunsOn | null
    tasks: Task[]
    sent: string[]
    legacy: Legacy | null
    state: () => Promise<YardbellState | null>
    onSend: (text: string, files: Attached[]) => boolean
    onStop: () => void
    onSaveTask: (text: string) => void
    onScan: () => void
    onRunsOn: (change: Record<string, string>) => void
    onOpenSettings: (hash: string) => void
  }
>(function Composer(props, ref) {
  const { conversation, busy, backend, runsOn, tasks, legacy } = props
  const fileInput = useRef<HTMLInputElement>(null)
  const micRef = useRef<HTMLButtonElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const draftKey = conversation || ''
  const [files, setFiles] = useState<Attached[]>([])
  const [menu, setMenu] = useState<Menu | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [active, setActive] = useState(0)
  const [empty, setEmpty] = useState(true)
  const [mode, setMode] = useState<'enter' | 'mod'>(() => read(SEND_KEY, null) || (matchMedia('(pointer: coarse)').matches ? 'mod' : 'enter'))
  const [dragging, setDragging] = useState(false)
  const [voiceSetup, setVoiceSetup] = useState(false)
  const [codexModels, setCodexModels] = useState<string[] | null>(null)
  const [approval, setApproval] = useState<string | null>(null)
  const history = useRef<{ at: number; saved: JSONContent } | null>(null)
  const nameCache = useRef<{ at: number; state: YardbellState | null }>({ at: 0, state: null })
  const keys = useRef<(e: KeyboardEvent) => boolean>(() => false)
  const changed = useRef<(editor: Editor) => void>(() => {})
  const pasted = useRef<(files: File[]) => void>(() => {})

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        underline: false,
        trailingNode: false
      }),
      Placeholder.configure({ placeholder: 'Ask Dispatch anything. @ names a machine, session or folder, / inserts a saved prompt' }),
      NameNode,
      TaskNode
    ],
    editorProps: {
      attributes: {
        'aria-label': 'Message Dispatch',
        'aria-multiline': 'true',
        role: 'textbox',
        class: 'yb-prompt min-h-12 max-h-[calc(8lh+0.5rem)] w-full overflow-y-auto scrollbar-sleek bg-transparent px-2 py-1 text-sm whitespace-pre-wrap break-words outline-none'
      },
      handleKeyDown: (_view, event) => keys.current(event),
      handlePaste: (_view, event) => {
        const list = Array.from(event.clipboardData?.files || [])
        if (!list.length) return false
        pasted.current(list)
        return true
      },
      handleDrop: (_view, event) => {
        const list = Array.from((event as DragEvent).dataTransfer?.files || [])
        if (!list.length) return false
        pasted.current(list)
        return true
      }
    },
    onUpdate: ({ editor }) => changed.current(editor),
    onSelectionUpdate: ({ editor }) => changed.current(editor)
  })

  const saveDraft = (e: Editor) => {
    const drafts = read<Record<string, unknown>>(DRAFTS_KEY, {})
    if (e.isEmpty) delete drafts[draftKey]
    else drafts[draftKey] = e.getJSON()
    write(DRAFTS_KEY, Object.keys(drafts).length ? drafts : null)
  }

  useEffect(() => {
    if (!editor) return
    const saved = read<Record<string, unknown>>(DRAFTS_KEY, {})[draftKey]
    editor.commands.setContent(typeof saved === 'string' ? docOf(saved) : (saved as JSONContent) || '', { emitUpdate: false })
    setEmpty(editor.isEmpty)
    setFiles([])
    setMenu(null)
    history.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, editor])

  // Dictation is the old pages' own, so it records, transcribes and stops the same way.
  useEffect(() => {
    if (!legacy || !micRef.current || !pillRef.current || !runsOn?.voice_input) return
    legacy.voice.dictation({
      button: micRef.current,
      pill: pillRef.current,
      insert: (said: string) => insertText(said),
      toast: (m: string) => toast.error(m),
      mode: () => runsOn?.voice_mode || 'auto'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacy, Boolean(runsOn?.voice_input)])

  const insertText = (add: string) => {
    if (!editor || !add) return
    const { $from } = editor.state.selection
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const gap = before && !/\s$/.test(before) && !/^\s/.test(add) ? ' ' : ''
    editor.chain().focus().insertContent({ type: 'text', text: `${gap}${add}` }).run()
  }

  useImperativeHandle(ref, () => ({
    insert: insertText,
    fill: (t) => {
      editor?.chain().setContent(docOf(t)).focus('end').run()
    },
    focus: () => editor?.commands.focus('end'),
    restore: (t, f) => {
      editor?.commands.setContent(docOf(t))
      setFiles(f)
    }
  }))

  const findMenu = async (e: Editor) => {
    const { selection } = e.state
    if (!selection.empty) return setMenu(null)
    const { $from } = selection
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const m = TRIGGER.exec(before)
    if (!m) return setMenu(null)
    const query = (m[1] ?? m[2] ?? '').toLowerCase()
    const kind = m[1] !== undefined ? 'tasks' : 'names'
    const next = { kind, query, from: selection.from - query.length - 1, to: selection.from } as Menu
    setMenu((old) => {
      if (!old || old.kind !== next.kind || old.query !== next.query) setActive(0)
      return next
    })
    if (kind === 'tasks') {
      setItems(
        tasks
          .map((t): Omit<Item, 'rank'> & { rank: number | null } => ({ group: 'Saved prompts', kind: 'task', label: t.name, detail: t.text, token: t.text, rank: rank(query, t.name, t.text) }))
          .filter((i): i is Item => i.rank !== null)
          .sort((a, b) => a.rank - b.rank)
      )
      return
    }
    if (Date.now() - nameCache.current.at > 15000) nameCache.current = { at: Date.now(), state: await props.state() }
    const state = nameCache.current.state
    setItems(state ? names(state, query) : [])
  }

  changed.current = (e) => {
    setEmpty(e.isEmpty)
    saveDraft(e)
    findMenu(e)
  }

  const choose = (item: Item) => {
    if (!menu || !editor) return
    const node = item.kind === 'task' ? { type: 'dispatchTask', attrs: { name: item.label, text: item.token } } : { type: 'dispatchName', attrs: { kind: item.kind, label: item.label, token: item.token } }
    editor
      .chain()
      .focus()
      .insertContentAt({ from: menu.from, to: menu.to }, [node, { type: 'text', text: ' ' }])
      .run()
    setMenu(null)
  }

  const startMenu = (sign: '@' | '/') => {
    if (!editor) return
    const { $from } = editor.state.selection
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    editor
      .chain()
      .focus()
      .insertContent({ type: 'text', text: `${before && !/\s$/.test(before) ? ' ' : ''}${sign}` })
      .run()
  }

  const attach = async (list: FileList | File[]) => {
    const now = [...files]
    for (const file of Array.from(list)) {
      const out = await legacy?.attach.admit(file, now, backend)
      if (!out) continue
      if (out.error) {
        toast.error(out.error)
        continue
      }
      now.push({ file, kind: out.kind, url: URL.createObjectURL(file) })
    }
    setFiles(now)
  }
  pasted.current = attach

  const send = () => {
    if (!editor) return
    const said = textOf(editor).trim()
    if ((!said && !files.length) || busy) {
      if (busy) toast('Dispatch is still working on the last message. Stop it or wait, then send.')
      return
    }
    if (!props.onSend(said, files)) return
    const past = read<string[]>(HISTORY_KEY, []).filter((t) => t !== said)
    if (said) write(HISTORY_KEY, [said, ...past].slice(0, HISTORY_SIZE))
    editor.commands.clearContent(true)
    setFiles([])
    setMenu(null)
    history.current = null
  }

  const pastTexts = useMemo(() => [...new Set([...props.sent.slice().reverse(), ...read<string[]>(HISTORY_KEY, [])])], [props.sent])

  keys.current = (e) => {
    if (e.isComposing || !editor) return false
    if (menu && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        choose(items[Math.min(active, items.length - 1)])
        return true
      }
    }
    if (menu && e.key === 'Escape') {
      setMenu(null)
      return true
    }
    if (e.key === 'Escape' && busy) {
      props.onStop()
      return true
    }
    // Arrow up in an empty box, or while walking back, brings back what was sent before.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !menu && (history.current || (editor.isEmpty && e.key === 'ArrowUp'))) {
      const h = history.current || { at: -1, saved: editor.getJSON() }
      const at = Math.max(-1, Math.min(pastTexts.length - 1, h.at + (e.key === 'ArrowUp' ? 1 : -1)))
      if (at === h.at) return false
      history.current = at < 0 ? null : { at, saved: h.saved }
      editor.chain().setContent(at < 0 ? h.saved : docOf(pastTexts[at])).focus('end').run()
      history.current = at < 0 ? null : { at, saved: h.saved }
      return true
    }
    if (e.key !== 'Enter') return false
    const mod = e.metaKey || e.ctrlKey
    if (mode === 'enter' ? !e.shiftKey && !mod : mod) {
      send()
      return true
    }
    if (mode === 'enter' && e.shiftKey) {
      editor.commands.splitBlock()
      return true
    }
    return false
  }

  const canSend = !empty || files.length > 0
  const loadSettings = () =>
    fetch('/api/settings', { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then(
        (s) => {
          setCodexModels(s.codex_models || [])
          setApproval(({ ask: 'prompt', auto: 'allow' } as Record<string, string>)[s.dispatch?.approval] || s.dispatch?.approval || 'prompt')
        },
        () => setCodexModels([])
      )
  useEffect(() => {
    loadSettings()
  }, [])
  const shownApproval = APPROVAL[approval || 'prompt']
  const ApprovalIcon = shownApproval.icon
  const chip = 'inline-flex h-7 max-w-56 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'

  return (
    <div className="@container/composer relative mx-auto w-full max-w-3xl px-4 pt-2 pb-4">
      {menu && (
        <div
          role="listbox"
          aria-label={menu.kind === 'tasks' ? 'Saved prompts' : 'Machines, sessions and folders'}
          className="scrollbar-sleek absolute inset-x-4 bottom-full z-30 mb-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {!items.length && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{menu.kind === 'tasks' ? 'No saved prompt matches. Save one from the … menu.' : 'Nothing by that name.'}</div>
          )}
          {items.map((item, i) => {
            const Icon = KIND_ICON[item.kind]
            return (
              <div key={`${item.group}:${item.label}:${i}`}>
                {(i === 0 || items[i - 1].group !== item.group) && <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{item.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={(e) => (e.movementX || e.movementY) && i !== active && setActive(i)}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    if (e.button === 0) choose(item)
                  }}
                  className={cn('flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm', i === active && 'bg-foreground/10 dark:bg-foreground/12')}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{item.label}</span>
                  <span className="ml-auto max-w-[55%] truncate text-xs text-muted-foreground">{item.detail}</span>
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div ref={pillRef} className="yb-legacy dictation-pill mb-1.5" role="group" aria-label="Dictation" hidden />
      {voiceSetup && (
        <div role="status" className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs">
          <Mic className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">Voice input is off. Set it up to dictate messages.</span>
          <Button size="xs" onClick={() => props.onOpenSettings('voice')}>
            Set up voice
          </Button>
          <button type="button" aria-label="Dismiss" onClick={() => setVoiceSetup(false)} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false)
          if (!e.dataTransfer.files.length || e.defaultPrevented) return
          e.preventDefault()
          attach(e.dataTransfer.files)
        }}
        onClick={(e) => e.target === e.currentTarget && editor?.commands.focus('end')}
        className={cn(
          'group/composer rounded-xl border border-border bg-background p-1.5 shadow-xs transition-colors focus-within:border-foreground/25 dark:bg-foreground/[0.03]',
          dragging && 'border-dashed border-foreground/40 bg-accent/40'
        )}
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
            {files.map((f, i) => (
              <div key={f.url} className="group/file relative flex h-14 max-w-52 items-center gap-2 overflow-hidden rounded-lg border border-border bg-muted/40 pr-7 text-xs">
                {f.kind === 'image' ? (
                  <img src={f.url} alt="" className="h-full w-14 object-cover" />
                ) : (
                  <span className="grid h-full w-12 place-items-center bg-muted">
                    <FileText className="size-4 text-muted-foreground" />
                  </span>
                )}
                <span className="absolute top-1 left-1 grid size-4 place-items-center rounded-full bg-background/90 text-[10px] font-medium tabular-nums">{i + 1}</span>
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{f.file.name}</span>
                  <span className="text-[11px] text-muted-foreground">{legacy?.attach.sizeText(f.file.size)}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-background/80 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <EditorContent editor={editor} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && (attach(e.target.files), (e.target.value = ''))} />
        <div className="flex items-center justify-between gap-2 pt-0.5 text-muted-foreground">
          <div className="flex min-w-0 shrink items-center gap-0.5">
            <Hint label="Attach files: images, PDFs and text">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach file" onClick={() => fileInput.current?.click()}>
                <Plus className="size-4" />
              </Button>
            </Hint>
            <DropdownMenu onOpenChange={(o) => o && loadSettings()}>
              <DropdownMenuTrigger asChild>
                <button type="button" title={`Before Dispatch starts, stops or types into a session: ${shownApproval.detail.toLowerCase()}`} className={chip}>
                  <ApprovalIcon className="size-3.5 shrink-0" />
                  <span className="hidden truncate @[34rem]/composer:inline">{shownApproval.label}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-72">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Before Dispatch starts, stops or types into a session</DropdownMenuLabel>
                {Object.entries(APPROVAL).map(([value, a]) => (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => {
                      setApproval(value)
                      props.onRunsOn({ approval: value })
                    }}
                  >
                    <span className="w-4">{value === (approval || 'prompt') && <Check className="size-3.5" />}</span>
                    <span className="grid">
                      <span>{a.label}</span>
                      <span className="text-xs text-muted-foreground">{a.detail}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => props.onOpenSettings('dispatch')}>
                  <Settings2 /> Rules and Dispatch settings
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <Hint label="More chat controls">
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label="More chat controls">
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent side="top" align="start" className="w-72">
                <DropdownMenuItem onSelect={() => startMenu('/')}>
                  <Slash /> Insert a saved prompt <span className="ml-auto text-xs text-muted-foreground">/</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => startMenu('@')}>
                  <AtSign /> Name a machine, session or folder <span className="ml-auto text-xs text-muted-foreground">@</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onScan}>
                  <ScanLine /> Scan a folder
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const said = editor ? textOf(editor).trim() : ''
                    if (!said) {
                      toast('Type the prompt first, then save it.')
                      editor?.commands.focus()
                      return
                    }
                    props.onSaveTask(said)
                  }}
                >
                  <Bookmark /> Save as prompt
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    const next = mode === 'enter' ? 'mod' : 'enter'
                    setMode(next)
                    write(SEND_KEY, next)
                    toast(next === 'enter' ? 'Enter sends, Shift+Enter starts a new line' : `${MOD}+Enter sends, Enter starts a new line`)
                  }}
                >
                  <Keyboard /> Send with
                  <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground" title={mode === 'enter' ? 'Shift+Enter starts a new line' : 'Enter starts a new line'}>
                    {mode === 'enter' ? 'Enter' : `${MOD} Enter`}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {runsOn && (
              <ModelPicker
                runsOn={runsOn}
                backend={backend}
                inChat={Boolean(conversation)}
                codexModels={codexModels}
                onOpen={() => codexModels === null && loadSettings()}
                onChange={props.onRunsOn}
                onSettings={() => props.onOpenSettings('dispatch')}
                listModels={async (agent) => {
                  const here = (await props.state())?.machines.find((m) => m.local)?.name
                  if (!here) return null
                  const res = await fetch(`/machines/${encodeURIComponent(here)}/models?agent=${encodeURIComponent(agent)}`, { headers: { Accept: 'application/json' } })
                  return res.ok ? ((await res.json()).models as Listed[] | null) : null
                }}
              />
            )}
            {runsOn && (
              <Hint label={runsOn.voice_input ? (runsOn.voice_mode === 'hold' ? 'Hold to dictate' : 'Start dictation') : 'Voice input is off. Set it up in Settings.'}>
                <Button
                  ref={micRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Start dictation"
                  onClick={runsOn.voice_input ? undefined : () => setVoiceSetup(true)}
                  className={cn('[&.recording]:bg-secondary [&.recording]:text-foreground', !runsOn.voice_input && 'opacity-60')}
                >
                  <Mic className="size-4 [.recording_&]:hidden" />
                  <Square className="hidden size-3.5 fill-current [.recording_&]:block" />
                </Button>
              </Hint>
            )}
            {busy ? (
              <Hint label="Stop Dispatch's reply (Esc). Sessions it started keep running.">
                <Button type="button" variant="secondary" size="icon-round" aria-label="Stop" onMouseDown={(e) => e.preventDefault()} onClick={(e) => e.detail <= 1 && props.onStop()}>
                  <Square className="size-3.5 fill-current" />
                </Button>
              </Hint>
            ) : (
              <Hint label={canSend ? (mode === 'enter' ? 'Send (Enter)' : `Send (${MOD}+Enter)`) : 'Type a message to send'}>
                <span className="inline-flex">
                  <Button type="button" size="icon-round" aria-label="Send" disabled={!canSend} onMouseDown={(e) => e.preventDefault()} onClick={(e) => e.detail <= 1 && send()}>
                    <ArrowUp className="size-4" />
                  </Button>
                </span>
              </Hint>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

// The model picker follows Orca's composer pill: the model's name, and above the box a searchable
// list with each model's description. Dispatch has no effort setting, so there is no effort row.
function ModelPicker({
  runsOn,
  backend,
  inChat,
  codexModels,
  onOpen,
  onChange,
  onSettings,
  listModels
}: {
  listModels: (agent: string) => Promise<Listed[] | null>
  runsOn: RunsOn
  backend: string
  inChat: boolean
  codexModels: string[] | null
  onOpen: () => void
  onChange: (change: Record<string, string>) => void
  onSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [live, setLive] = useState<Record<string, Listed[]>>({})
  useEffect(() => {
    if (!open || live[backend]) return
    listModels(backend).then((list) => list?.length && setLive((l) => ({ ...l, [backend]: list })), () => {})
  }, [open, backend])
  const agents = Object.keys(runsOn.agents || {})
  const label = (a: string) => runsOn.agents?.[a]?.label || AGENT_LABEL[a] || a
  const chosen = runsOn.agents?.[backend]?.model || ''
  const base = catalogFor(backend)
  const catalog = base && live[backend] ? liveCatalog(base, live[backend]) : base
  const known = catalog?.models || []
  const extra = backend === 'codex' ? (codexModels || []).filter((m) => !known.some((k) => k.id === m)).map((m) => ({ id: m, label: m, description: undefined as string | undefined })) : []
  const all = [{ id: '', label: 'Default', description: `Whatever ${label(backend)} picks on its own` }, ...known.map((m) => ({ id: m.id, label: m.label, description: m.description })), ...extra]
  if (chosen && !all.some((m) => m.id === chosen)) all.push({ id: chosen, label: chosen, description: undefined })
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter((m) => terms.every((t) => `${m.id} ${m.label} ${m.description || ''}`.toLowerCase().includes(t)))
  const name = all.find((m) => m.id === chosen)?.label || CLAUDE_MODELS[chosen] || chosen || 'Default'
  const pick = (id: string) => {
    setOpen(false)
    if (id !== chosen) onChange({ [backend === 'codex' ? 'codex_model' : 'model']: id })
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        setQuery('')
        setActive(0)
        if (o) onOpen()
      }}
    >
      <Hint label={`${label(backend)} · ${name}`}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="xs" aria-label={`Model ${name}`} className="max-w-64 text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1">
              <span className="hidden shrink-0 @[30rem]/composer:inline">{label(backend)}</span>
              <span className="truncate text-foreground">{name}</span>
              <ChevronDown className="size-3 shrink-0" />
            </span>
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent side="top" align="end" collisionPadding={8} className="flex w-96 max-w-(--radix-popover-content-available-width) flex-col p-0">
        {agents.length > 1 && (
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
            <span className="text-xs text-muted-foreground">{inChat ? 'This chat stays on' : 'New chats run on'}</span>
            <div role="radiogroup" aria-label="Agent" className="inline-flex rounded-md bg-muted p-0.5">
              {agents.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={a === backend}
                  disabled={inChat && a !== backend}
                  title={inChat && a !== backend ? 'Start a new chat to use another agent' : undefined}
                  onClick={() => a !== backend && onChange({ runs_on: a })}
                  className={cn(
                    'h-6 rounded-[5px] px-2 text-xs disabled:opacity-50',
                    a === backend ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground enabled:hover:text-foreground'
                  )}
                >
                  {label(a)}
                </button>
              ))}
            </div>
          </div>
        )}
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length))
            } else if (e.key === 'Enter' && shown[active]) {
              e.preventDefault()
              pick(shown[active].id)
            }
          }}
          placeholder="Search models…"
          aria-label="Search models"
          className="h-9 border-b border-border/60 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div role="listbox" aria-label="Models" className="scrollbar-sleek max-h-[min(233px,60vh)] overflow-y-auto p-1">
          {!shown.length && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No models match your search.</p>}
          {shown.map((m, i) => (
            <button
              key={m.id || 'default'}
              type="button"
              role="option"
              aria-selected={i === active}
              aria-current={m.id === chosen || undefined}
              onMouseMove={(e) => (e.movementX || e.movementY) && i !== active && setActive(i)}
              onClick={() => pick(m.id)}
              className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left', i === active && 'bg-foreground/10 dark:bg-foreground/12')}
            >
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm">{m.label}</span>
                {m.description && <span className="truncate text-xs text-muted-foreground">{m.description}</span>}
              </span>
              <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">{m.id === chosen && <Check className="size-3.5 text-muted-foreground" />}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-border/60 p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onSettings()
            }}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Settings2 className="size-3.5" /> Dispatch settings
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
