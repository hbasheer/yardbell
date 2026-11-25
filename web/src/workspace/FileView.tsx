import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { EDITOR_OPTIONS, languageOf, monaco } from '@/lib/monaco'
import { getJson } from '@/lib/state'
import { useDark } from './useDark'

type FileText = { path: string; size: number; text: string; hash: string; editable: boolean }

const sizeWords = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB` : `${n} bytes`)
const linesOf = (t: string) => t.split('\n').length - (t.endsWith('\n') ? 1 : 0)

export function Crumbs({ root, path }: { root: string; path: string }) {
  const parts = [root.replace(/\/$/, '').split('/').pop() || root, ...path.split('/')]
  return (
    <span className="min-w-0 flex-1 truncate">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="px-1 opacity-50">/</span>}
          <span className={cn(i === parts.length - 1 && 'font-medium text-foreground')}>{p}</span>
        </span>
      ))}
    </span>
  )
}

export function FileView({ machine, root, path, onDirty }: { machine: string; root: string; path: string; onDirty: (dirty: boolean) => void }) {
  const [file, setFile] = useState<FileText | null>(null)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const hash = useRef('')
  const clean = useRef(0)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const dark = useDark()
  const readOnly = !file?.editable

  useEffect(() => {
    let gone = false
    getJson<FileText>(`/machines/${encodeURIComponent(machine)}/file?${new URLSearchParams({ root, path })}`)
      .then((f) => {
        if (gone) return
        hash.current = f.hash
        setFile(f)
      })
      .catch((e) => !gone && setError(e.message))
    return () => {
      gone = true
    }
  }, [machine, root, path])

  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = async () => {
    const ed = editor.current
    if (!ed || readOnly || saving) return
    const text = ed.getValue()
    setSaving(true)
    try {
      const res = await fetch(`/machines/${encodeURIComponent(machine)}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ root, path, hash: hash.current, text })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The save failed (${res.status})`)
      hash.current = data.hash
      setFile((f) => (f ? { ...f, size: data.size, text } : f))
      if (ed.getValue() === text) {
        clean.current = ed.getModel()!.getAlternativeVersionId()
        setDirty(false)
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const mount: OnMount = (ed, m) => {
    editor.current = ed
    clean.current = ed.getModel()!.getAlternativeVersionId()
    ed.onDidChangeModelContent(() => setDirty(ed.getModel()!.getAlternativeVersionId() !== clean.current))
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => saveRef.current())
  }

  const facts = file
    ? `${linesOf(file.text)} ${linesOf(file.text) === 1 ? 'line' : 'lines'} · ${sizeWords(file.size)}${file.editable ? '' : ' · read only, not UTF-8'}`
    : 'Loading…'

  return (
    <div className="flex size-full flex-col bg-editor-surface">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs text-muted-foreground">
        <Crumbs root={root} path={path} />
        <span className={cn('shrink-0', dirty && 'text-foreground')}>{error ? '' : dirty ? 'Unsaved changes' : facts}</span>
        {dirty && (
          <Button size="xs" onClick={save} disabled={saving} title="Save (Ctrl+S)">
            Save
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {error ? (
          <p role="alert" className="m-6 text-sm text-muted-foreground">
            {error}
          </p>
        ) : file ? (
          <Editor
            defaultValue={file.text}
            language={languageOf(path)}
            path={`file:///${machine}${root}/${path}`}
            theme={dark ? 'yardbell-dark' : 'yardbell-light'}
            onMount={mount}
            options={{ ...EDITOR_OPTIONS, readOnly, domReadOnly: readOnly }}
          />
        ) : null}
      </div>
    </div>
  )
}
