import { useEffect, useState } from 'react'
import { Check, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import type { YardbellState } from '@/lib/state'
import { memPct } from '@/lib/tree'

export function NewTerminal({
  open,
  state,
  preferred,
  onClose,
  onOpen
}: {
  open: boolean
  state: YardbellState | null
  preferred?: string
  onClose: () => void
  onOpen: (machine: string) => Promise<void>
}) {
  const machines = state?.machines || []
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const up = machines.filter((m) => m.up)
    setPick(up.find((m) => m.name === preferred)?.name || up[0]?.name || '')
  }, [open])

  const go = async (machine = pick) => {
    if (!machine || busy) return
    setBusy(true)
    try {
      await onOpen(machine)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="gap-4 sm:max-w-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.defaultPrevented) {
            e.preventDefault()
            go()
          }
        }}
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="text-base font-semibold">New terminal</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">Run on</span>
          <div role="radiogroup" aria-label="Run on" className="grid gap-1">
            {machines.length === 0 && <p className="text-xs text-muted-foreground">No machines in your config.</p>}
            {machines.map((m) => {
              const mem = m.up ? memPct(m) : null
              return (
                <button
                  key={m.name}
                  type="button"
                  role="radio"
                  aria-checked={pick === m.name}
                  disabled={!m.up}
                  onClick={() => setPick(m.name)}
                  onDoubleClick={() => go(m.name)}
                  className={cn(
                    'flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2 text-left text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                    pick === m.name ? 'border-foreground/40 bg-accent' : 'border-input hover:bg-accent/50'
                  )}
                >
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{m.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {!m.up
                        ? m.reason || 'Offline'
                        : [m.local ? 'This computer' : null, mem != null ? `${mem}% memory` : null].filter(Boolean).join(' · ') || 'Online'}
                    </span>
                  </span>
                  {pick === m.name && <Check className="size-4" />}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => go()} disabled={!pick || busy}>
            Open terminal <span className="ml-1 text-xs opacity-60">↵</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
