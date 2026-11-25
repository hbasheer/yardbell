import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { compose, dropSent, useNotes, type FolderNote } from '@/lib/notes'
import type { YardbellState } from '@/lib/state'
import { title } from './layout'

export type Place = { machine: string; path: string }

const inside = (path: string, base: string) => {
  const b = base.replace(/\/$/, '')
  return Boolean(b) && (path === b || path.startsWith(`${b}/`))
}

export function sessionsIn(state: YardbellState | null, machine: string, root: string) {
  return (state?.sessions || [])
    .filter((s) => !s.stale && s.tmux && s.machine === machine)
    .filter((s) => {
      const at = s.path || s.cwd
      return at && (inside(at, root) || inside(root, at))
    })
}

export function SendNotes({
  open,
  onOpenChange,
  place,
  list,
  state
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  place: Place
  list: FolderNote[]
  state: YardbellState | null
}) {
  const store = useNotes()
  const owners = sessionsIn(state, place.machine, place.path)
  const [pick, setPick] = useState(0)
  const [now, setNow] = useState(false)
  const [busy, setBusy] = useState(false)
  const text = compose(list)

  const send = async () => {
    const to = owners[pick]
    if (!to) return
    setBusy(true)
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(to.machine)}/${encodeURIComponent(to.tmux!)}/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ text, enter: now })
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Yardbell answered ${res.status}`)
      dropSent(store, list)
      onOpenChange(false)
      toast(now ? `Sent the notes to ${title(to)}` : `Pasted the notes into ${title(to)}'s prompt`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          Send {list.length} {list.length === 1 ? 'note' : 'notes'} to the agent
        </DialogTitle>
        {owners.length === 0 ? (
          <DialogDescription>No session runs in this folder. Start one, then send it the notes.</DialogDescription>
        ) : owners.length === 1 ? (
          <DialogDescription>
            To <b className="text-foreground">{title(owners[0])}</b> ({owners[0].tmux} on {owners[0].machine})
          </DialogDescription>
        ) : (
          <div className="grid gap-1">
            <DialogDescription>Several sessions run here. Which one gets the notes?</DialogDescription>
            {owners.map((o, i) => (
              <label key={o.id} className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-accent">
                <input type="radio" name="send-to" checked={pick === i} onChange={() => setPick(i)} />
                <span className="flex-1">{title(o)}</span>
                <span className="text-xs text-muted-foreground">{o.tmux}</span>
              </label>
            ))}
          </div>
        )}
        <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{text}</pre>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> Send it now (press Enter after pasting)
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={busy || !owners.length}>
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
