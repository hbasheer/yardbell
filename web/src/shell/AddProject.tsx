import { useEffect, useState } from 'react'
import { Check, Folder, GitBranch, Home, LoaderCircle, Server, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { getJson, type YardbellState } from '@/lib/state'
import { short } from '@/lib/tree'

type Entry = { name: string; git?: boolean; branch?: string }
type Listing = { path: string; entries: Entry[]; git?: boolean; branch?: string }

const api = (m: string) => `/machines/${encodeURIComponent(m)}`
const row = 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent'

export function AddProject({ open, state, onClose }: { open: boolean; state: YardbellState | null; onClose: () => void }) {
  const up = (state?.machines || []).filter((m) => m.up)
  const [machine, setMachine] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const go = (m: string, path?: string) => {
    setListing(null)
    setError('')
    getJson<Listing>(`${api(m)}/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`)
      .then(setListing)
      .catch((e) => setError(e.message))
  }

  useEffect(() => {
    if (!open) return
    const first = up.find((m) => m.local)?.name || up[0]?.name || ''
    setMachine(first)
    if (first) go(first)
  }, [open])

  const add = async () => {
    if (!listing || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ machine, path: listing.path })
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Yardbell answered ${res.status}`)
      toast(`Added ${listing.path.split('/').filter(Boolean).pop()} to your projects`)
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const parts = listing ? listing.path.split('/').filter(Boolean) : []
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-md">
        <div className="flex items-center justify-between">
          <DialogTitle>Add project</DialogTitle>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <DialogDescription className="-mt-2 text-xs">Pick a folder. It shows in the sidebar under its machine, with the sessions that run in it.</DialogDescription>
        {!up.length ? (
          <p className="text-sm text-muted-foreground">No machine is connected right now.</p>
        ) : (
          <>
            {up.length > 1 && (
              <div role="radiogroup" aria-label="Machine" className="flex flex-wrap gap-1">
                {up.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    role="radio"
                    aria-checked={machine === m.name}
                    onClick={() => {
                      setMachine(m.name)
                      go(m.name)
                    }}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs',
                      machine === m.name ? 'border-foreground/40 bg-accent' : 'border-input hover:bg-accent/50'
                    )}
                  >
                    <Server className="size-3.5 text-muted-foreground" /> {m.name}
                    {machine === m.name && <Check className="size-3.5" />}
                  </button>
                ))}
              </div>
            )}
            <div className="grid min-h-0 gap-1.5 rounded-lg border border-border p-2">
              {listing && (
                <nav className="flex flex-wrap items-center gap-0.5 text-xs" aria-label="Folder path">
                  <button type="button" onClick={() => go(machine, '~')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent">
                    <Home className="size-3" /> Home
                  </button>
                  {parts.map((p, i) => (
                    <span key={i} className="inline-flex items-center">
                      <span className="text-muted-foreground">/</span>
                      <button
                        type="button"
                        onClick={() => go(machine, `/${parts.slice(0, i + 1).join('/')}`)}
                        className={cn('rounded px-1 py-0.5 hover:bg-accent', i === parts.length - 1 && 'font-medium')}
                      >
                        {p}
                      </button>
                    </span>
                  ))}
                </nav>
              )}
              <ul className="scrollbar-sleek grid max-h-64 gap-px overflow-y-auto">
                {!listing && !error && (
                  <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin" /> Reading folders…
                  </li>
                )}
                {error && <li className="px-2 py-1 text-xs text-destructive">{error}</li>}
                {listing && parts.length > 0 && (
                  <li>
                    <button type="button" onClick={() => go(machine, `/${parts.slice(0, -1).join('/')}`)} className={row}>
                      ..
                    </button>
                  </li>
                )}
                {listing?.entries.map((e) => (
                  <li key={e.name}>
                    <button type="button" onClick={() => go(machine, `${listing.path.replace(/\/$/, '')}/${e.name}`)} className={row}>
                      {e.git ? <GitBranch className="size-3.5 text-muted-foreground" /> : <Folder className="size-3.5 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      {e.git && e.branch && <span className="truncate font-mono text-2xs text-muted-foreground">{e.branch}</span>}
                    </button>
                  </li>
                ))}
                {listing && !listing.entries.length && <li className="px-2 py-1.5 text-xs text-muted-foreground">No folders inside.</li>}
              </ul>
            </div>
          </>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-[11px] text-muted-foreground">{listing ? `${machine}:${short(listing.path)}` : ''}</p>
          <Button onClick={add} disabled={!listing || busy}>
            {busy && <LoaderCircle className="animate-spin" />} Add project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
