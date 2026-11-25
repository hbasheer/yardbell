import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { EDITOR_OPTIONS, languageOf, monaco } from '@/lib/monaco'
import { diffKey, notesIn, setNotes, useNotes, type Note } from '@/lib/notes'
import { getJson, type YardbellState } from '@/lib/state'
import { Crumbs } from './FileView'
import { SendNotes } from './SendNotes'
import { useDark } from './useDark'

type Line = { k: 'hunk' | 'meta' | 'ctx' | 'add' | 'del'; o: number | null; n: number | null; t: string }
type Diff = { added?: number; removed?: number; binary?: boolean; notes?: string[]; next: number; total: number; cut?: boolean; lines: Line[] }

const WHOLE = 100000
const MAX_PAGES = 20
const VIEW = 'workspace.diff.view'
const NO_NOTES: Note[] = []

// A diff of the whole file in one piece can be rebuilt into its two sides; anything else
// (cut short, binary, several hunks) cannot.
function sides(lines: Line[]) {
  const before: string[] = []
  const after: string[] = []
  for (const l of lines) {
    if (l.k === 'hunk' || l.k === 'meta') continue
    if (l.k === 'del' || l.k === 'ctx') {
      if (l.o !== before.length + 1) return null
      before.push(l.t)
    }
    if (l.k === 'add' || l.k === 'ctx') {
      if (l.n !== after.length + 1) return null
      after.push(l.t)
    }
  }
  return { before: before.join('\n'), after: after.join('\n') }
}

function lineAt(lines: Line[], side: 'old' | 'new', n: number) {
  return lines.find((l) => (side === 'old' ? l.k === 'del' && l.o === n : (l.k === 'add' || l.k === 'ctx') && l.n === n))
}

type Zone = { id: string; node: HTMLElement; anchor: string; editor: monaco.editor.ICodeEditor }

function NoteCard({
  note,
  editing,
  onEdit,
  onSave,
  onCancel,
  onRemove
}: {
  note?: Note
  editing: boolean
  onEdit?: () => void
  onSave: (text: string) => void
  onCancel: () => void
  onRemove?: () => void
}) {
  const [text, setText] = useState(note?.text ?? '')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!editing) return
    let tries = 10
    const focus = () => {
      if (box.current?.offsetParent) {
        box.current.focus()
        box.current.setSelectionRange(box.current.value.length, box.current.value.length)
      } else if (tries-- > 0) requestAnimationFrame(focus)
    }
    requestAnimationFrame(focus)
  }, [editing])
  const mac = /Mac/.test(navigator.platform)
  if (!editing && note)
    return (
      <div className="max-w-[680px] rounded-lg border border-border bg-card p-2.5 text-[13px]">
        <p className="m-0 whitespace-pre-wrap break-words">{note.text}</p>
        <div className="mt-1.5 flex justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
    )
  return (
    <div className="max-w-[680px] rounded-lg border border-border bg-card p-2.5">
      <textarea
        ref={box}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (text.trim()) onSave(text.trim())
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        placeholder="Leave a note for the agent on this line"
        aria-label="Note"
        className="block w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <span className="mr-auto text-2xs text-muted-foreground">{mac ? '⌘↵' : 'Ctrl+Enter'} to save</span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => text.trim() && onSave(text.trim())}>
          {note ? 'Save' : 'Add note'}
        </Button>
      </div>
    </div>
  )
}

export function DiffView({
  machine,
  root,
  path,
  staged,
  state
}: {
  machine: string
  root: string
  path: string
  staged: boolean
  state: YardbellState | null
}) {
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState('')
  const [split, setSplit] = useState(() => localStorage.getItem(VIEW) === '"split"')
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState('')
  const [zones, setZones] = useState<Zone[]>([])
  const [ready, setReady] = useState(0)
  const [sending, setSending] = useState(false)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const zoneIds = useRef<{ editor: monaco.editor.ICodeEditor; id: string; ro: ResizeObserver }[]>([])
  const store = useNotes()
  const key = diffKey({ machine, root, path, staged })
  const notes = store[key] ?? NO_NOTES
  const dark = useDark()

  useEffect(() => {
    let gone = false
    const params = { root, path, staged: String(staged), context: String(WHOLE) }
    const url = (from: number) => `/machines/${encodeURIComponent(machine)}/changes/diff?${new URLSearchParams({ ...params, from: String(from) })}`
    ;(async () => {
      let data = await getJson<Diff>(url(0))
      const lines = [...data.lines]
      for (let page = 1; data.next < data.total && page < MAX_PAGES; page++) {
        data = await getJson<Diff>(url(data.next))
        lines.push(...data.lines)
      }
      if (!gone) setDiff({ ...data, cut: data.cut || data.next < data.total, lines })
    })().catch((e) => !gone && setError(e.message))
    return () => {
      gone = true
    }
  }, [machine, root, path, staged])

  useEffect(() => {
    try {
      localStorage.setItem(VIEW, JSON.stringify(split ? 'split' : 'unified'))
    } catch {}
    editorRef.current?.updateOptions({ renderSideBySide: split })
  }, [split])

  // Notes live in view zones; a removed line's note sits in the unified view beside its change.
  useEffect(() => {
    const de = editorRef.current
    if (!de || !diff || !de.getLineChanges()) return
    for (const z of zoneIds.current) {
      z.ro.disconnect()
      z.editor.changeViewZones((acc) => acc.removeZone(z.id))
    }
    zoneIds.current = []
    const anchors = new Set<string>(
      notes
        .map((n) => `${n.side}:${n.line}`)
        .filter((a) => {
          const [side, n] = a.split(':')
          return Boolean(lineAt(diff.lines, side as 'old' | 'new', Number(n)))
        })
    )
    if (adding) anchors.add(adding)
    const ordered = [...anchors].sort((a, b) => Number(!a.startsWith('old:')) - Number(!b.startsWith('old:')))
    const next: Zone[] = []
    for (const anchor of ordered) {
      const [side, num] = anchor.split(':')
      const n = Number(num)
      let editor: monaco.editor.ICodeEditor = de.getModifiedEditor()
      let after = n
      if (side === 'old') {
        if (split) editor = de.getOriginalEditor()
        else {
          const ch = (de.getLineChanges() || []).find((c) => c.originalStartLineNumber <= n && n <= c.originalEndLineNumber)
          after = ch ? ch.modifiedEndLineNumber || ch.modifiedStartLineNumber : 0
        }
      }
      const node = document.createElement('div')
      node.className = 'z-10 pr-4 pl-16 py-1 font-sans'
      const inner = document.createElement('div')
      node.append(inner)
      // Monaco captures the pointer on any press inside the editor, so the note's buttons would never get the click.
      for (const type of ['pointerdown', 'mousedown', 'keydown']) node.addEventListener(type, (e) => e.stopPropagation())
      const spec = { afterLineNumber: after, heightInPx: 96, domNode: node, suppressMouseDown: true }
      let id = ''
      editor.changeViewZones((acc) => {
        id = acc.addZone(spec)
      })
      const ro = new ResizeObserver(() => {
        const h = Math.ceil(inner.getBoundingClientRect().height) + 8
        if (h > 8 && h !== spec.heightInPx) {
          spec.heightInPx = h
          editor.changeViewZones((acc) => acc.layoutZone(id))
        }
      })
      ro.observe(inner)
      zoneIds.current.push({ editor, id, ro })
      next.push({ id, node: inner, anchor, editor })
    }
    setZones(next)
  }, [diff, notes, adding, split, ready])

  const mount: DiffOnMount = (de, m) => {
    editorRef.current = de
    de.onDidUpdateDiff(() => setReady((r) => r + 1))
    for (const [editor, side] of [
      [de.getModifiedEditor(), 'new'],
      [de.getOriginalEditor(), 'old']
    ] as const) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.title = 'Add a note'
      btn.setAttribute('aria-label', 'Add a note on this line')
      btn.className =
        'absolute left-0.5 z-20 hidden size-4 place-items-center rounded bg-primary text-[13px] leading-none font-semibold text-primary-foreground'
      btn.textContent = '+'
      editor.getDomNode()!.append(btn)
      let line = 0
      const show = (n: number) => {
        line = n
        btn.style.display = n ? 'grid' : 'none'
        if (n) btn.style.top = `${editor.getTopForLineNumber(n) - editor.getScrollTop() + 2}px`
      }
      editor.onMouseMove((e) => {
        if (btn.contains(e.event.target as Node)) return
        const t = e.target
        if (t.type === m.editor.MouseTargetType.CONTENT_VIEW_ZONE || t.type === m.editor.MouseTargetType.GUTTER_VIEW_ZONE || !t.position) return show(0)
        show(t.position.lineNumber)
      })
      editor.onMouseLeave((e) => !btn.contains(e.event.browserEvent?.relatedTarget as Node) && show(0))
      editor.onDidScrollChange(() => show(line))
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      btn.addEventListener('click', () => {
        if (!line) return
        setEditing('')
        setAdding(`${side}:${line}`)
      })
    }
  }

  const both = diff && !diff.binary && !diff.cut ? sides(diff.lines) : null
  const empty = diff && !diff.lines.some((l) => l.k !== 'hunk' && l.k !== 'meta')

  const save = (anchor: string, text: string, id?: string) => {
    if (id)
      setNotes(
        key,
        notes.map((n) => (n.id === id ? { ...n, text } : n))
      )
    else {
      const [side, num] = anchor.split(':') as ['old' | 'new', string]
      const line = lineAt(diff!.lines, side, Number(num))
      setNotes(key, [...notes, { id: Math.random().toString(36).slice(2, 10), side, line: Number(num), code: line?.t ?? '', text, at: Date.now() }])
    }
    setAdding('')
    setEditing('')
  }

  const lost = diff ? notes.filter((n) => !lineAt(diff.lines, n.side, n.line)) : []
  const all = notesIn(store, machine, root).filter((n) => n.key === key)

  return (
    <div className="flex size-full flex-col bg-editor-surface">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs text-muted-foreground">
        <Crumbs root={root} path={path} />
        <span>{staged ? 'Staged' : 'Working tree'}</span>
        {diff && !diff.binary && (
          <span className="tabular-nums">
            <span className="text-status-success">+{diff.added ?? 0}</span> <span className="text-destructive">-{diff.removed ?? 0}</span>
          </span>
        )}
        {notes.length > 0 && (
          <Button size="xs" variant="outline" onClick={() => setSending(true)}>
            Send notes to agent ({notes.length})
          </Button>
        )}
        <span className="inline-flex rounded-md border border-border p-px">
          {(['Unified', 'Split'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setSplit(v === 'Split')}
              aria-pressed={split === (v === 'Split')}
              className={cn('h-5 rounded-[5px] px-2', split === (v === 'Split') ? 'bg-accent text-foreground' : 'hover:text-foreground')}
            >
              {v}
            </button>
          ))}
        </span>
      </div>
      {lost.length > 0 && (
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {lost.length === 1 ? 'A note is' : `${lost.length} notes are`} on lines no longer in the diff.{' '}
          <button
            type="button"
            className="underline"
            onClick={() =>
              setNotes(
                key,
                notes.filter((n) => !lost.includes(n))
              )
            }
          >
            Remove {lost.length === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {error ? (
          <p role="alert" className="m-6 text-sm text-muted-foreground">
            {error}
          </p>
        ) : !diff ? (
          <p className="m-6 text-sm text-muted-foreground">Loading the diff…</p>
        ) : diff.binary ? (
          <p className="m-6 text-sm text-muted-foreground">This is a binary file, so its changes are not shown.</p>
        ) : empty ? (
          <p className="m-6 text-sm text-muted-foreground">{diff.notes?.join('. ') || 'No line changed.'}</p>
        ) : !both ? (
          <p className="m-6 text-sm text-muted-foreground">The diff is too large to show here.</p>
        ) : (
          <DiffEditor
            original={both.before}
            modified={both.after}
            language={languageOf(path)}
            theme={dark ? 'yardbell-dark' : 'yardbell-light'}
            onMount={mount}
            options={{
              ...EDITOR_OPTIONS,
              readOnly: true,
              domReadOnly: true,
              renderSideBySide: split,
              useInlineViewWhenSpaceIsLimited: false,
              renderOverviewRuler: false,
              ignoreTrimWhitespace: false,
              hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 }
            }}
          />
        )}
      </div>
      {zones.map((z) => {
        const here = notes.filter((n) => `${n.side}:${n.line}` === z.anchor)
        return createPortal(
          <div className="flex flex-col gap-1.5">
            {here.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                editing={editing === n.id}
                onEdit={() => {
                  setAdding('')
                  setEditing(n.id)
                }}
                onSave={(text) => save(z.anchor, text, n.id)}
                onCancel={() => setEditing('')}
                onRemove={() =>
                  setNotes(
                    key,
                    notes.filter((x) => x.id !== n.id)
                  )
                }
              />
            ))}
            {adding === z.anchor && <NoteCard editing onSave={(text) => save(z.anchor, text)} onCancel={() => setAdding('')} />}
          </div>,
          z.node,
          z.id
        )
      })}
      <SendNotes open={sending} onOpenChange={setSending} place={{ machine, path: root }} list={all} state={state} />
    </div>
  )
}
