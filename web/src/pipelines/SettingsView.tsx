import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, type PipelinesData } from './model'

const input =
  'h-8 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'
const sectionTitle = 'text-[15px] font-semibold'
const helpText = 'text-[12.5px] leading-relaxed text-muted-foreground'

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_10rem] items-start gap-x-6 gap-y-1 border-b border-border/50 py-3 last:border-b-0 max-sm:grid-cols-1">
      <span className="grid gap-0.5">
        <span className="text-[13px] font-medium">{label}</span>
        <span className={helpText}>{help}</span>
      </span>
      {children}
    </label>
  )
}

export function SettingsView({ data, onSaved, onCancel }: { data: PipelinesData; onSaved: () => Promise<void>; onCancel: () => void }) {
  const s = data.settings
  const [perMachine, setPerMachine] = useState(String(s.per_machine))
  const [minutes, setMinutes] = useState(String(s.minutes))
  const [tokenLimit, setTokenLimit] = useState(s.token_limit ? String(s.token_limit) : '')
  const [memoryOn, setMemoryOn] = useState(s.memory_limit > 0)
  const [memory, setMemory] = useState(s.memory_limit ? String(s.memory_limit) : '')
  const [notes, setNotes] = useState(Object.entries(s.qa_notes || {}).map(([folder, note]) => ({ folder, note })))
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      const qa_notes = Object.fromEntries(notes.filter((n) => n.folder.trim()).map((n) => [n.folder.trim(), n.note]))
      await api('PUT', '/api/pipelines/settings', {
        per_machine: Number(perMachine),
        minutes: Number(minutes),
        memory_limit: memoryOn ? Number(memory) : 0,
        token_limit: Number(tokenLimit) || 0,
        qa_notes
      })
      toast('Saved to yardbell.yml')
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="mx-auto grid max-w-3xl gap-8"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <section className="grid gap-2">
        <h2 className={sectionTitle}>Limits</h2>
        <div className="rounded-xl border border-border bg-card px-4">
          <Row label="Agent steps at once" help="On each machine, from 1 to 6.">
            <input type="number" min={1} max={6} value={perMachine} onChange={(e) => setPerMachine(e.target.value)} className={input} />
          </Row>
          <Row label="Minutes a step may run" help="Past this the step waits for you. A step can set its own.">
            <input type="number" min={10} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={input} />
          </Row>
          <Row label="Tokens one run may use" help="Past this the run waits for you. Empty or 0 means no limit. A pipeline can set its own in its builder.">
            <input type="number" min={0} placeholder="No limit" value={tokenLimit} onChange={(e) => setTokenLimit(e.target.value)} className={input} />
          </Row>
        </div>
      </section>

      <section className="grid gap-2">
        <h2 className={sectionTitle}>Memory</h2>
        <div className="grid gap-3 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium">Hold new steps when memory runs short</span>
            <Switch checked={memoryOn} onCheckedChange={setMemoryOn} aria-label="Hold new steps when memory runs short" />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="number"
              min={50}
              max={99}
              required={memoryOn}
              disabled={!memoryOn}
              placeholder="50 to 99"
              aria-label="Percent of memory in use that holds new steps"
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              className={`${input} w-32`}
            />
            <span className="text-xs text-muted-foreground">% of memory in use</span>
          </label>
          <p className={helpText}>
            Off unless you switch it on. To turn it on, switch it on and enter the percent of memory in use, from 50 to 99, that holds new steps. New agent steps on that machine then wait until it has stayed under for two minutes, and at most one starts a minute. Running steps are never stopped. On a
            Mac this figure can read well above what macOS itself reports, so look at each machine's figure when it is idle before you choose.
          </p>
        </div>
      </section>

      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}>QA notes per folder</h2>
          <Button type="button" size="sm" variant="outline" onClick={() => setNotes([...notes, { folder: '', note: '' }])}>
            <Plus /> Add a note
          </Button>
        </div>
        <p className={helpText}>Added to every agent step working in that folder, such as how to run its specs and console.</p>
        <div className="grid gap-2 rounded-xl border border-border bg-card p-4">
          {!notes.length && <p className="text-xs text-muted-foreground">No notes yet.</p>}
          {notes.map((n, i) => (
            <div key={i} className="grid grid-cols-[12rem_minmax(0,1fr)_auto] gap-2 max-sm:grid-cols-1">
              <input
                aria-label="Folder"
                placeholder="acme/web"
                value={n.folder}
                onChange={(e) => setNotes(notes.map((x, j) => (j === i ? { ...x, folder: e.target.value } : x)))}
                className={input}
              />
              <input
                aria-label="Note"
                placeholder="Run bin/rspec, then check the page in the browser"
                value={n.note}
                onChange={(e) => setNotes(notes.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                className={input}
              />
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove this note" onClick={() => setNotes(notes.filter((_, j) => j !== i))} className="text-muted-foreground">
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </div>
    </form>
  )
}
