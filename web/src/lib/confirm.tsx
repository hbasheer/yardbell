import { useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'

type Choice = { value: string; label: string; danger?: boolean; primary?: boolean }
type Ask = { title: string; body?: string; confirm?: string; danger?: boolean; input?: string; choices?: Choice[]; resolve: (v: string | null) => void }

let current: Ask | null = null
const listeners = new Set<() => void>()
const set = (a: Ask | null) => {
  current = a
  listeners.forEach((l) => l())
}

// Resolves to true when the person confirms. Cancel, Esc and clicking outside all resolve false.
export function confirmAction(o: { title: string; body?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => set({ ...o, resolve: (v) => resolve(v !== null) }))
}

export function askText(o: { title: string; body?: string; confirm?: string; value: string }): Promise<string | null> {
  return new Promise((resolve) => set({ title: o.title, body: o.body, confirm: o.confirm, input: o.value, resolve }))
}

// Resolves to the picked choice's value, or null when the dialog is closed without a pick.
export function askChoice(o: { title: string; body?: string; choices: Choice[] }): Promise<string | null> {
  return new Promise((resolve) => set({ title: o.title, body: o.body, choices: o.choices, resolve }))
}

function Body({ ask }: { ask: Ask }) {
  const [value, setValue] = useState(ask.input ?? '')
  const done = (v: string | null) => {
    ask.resolve(v)
    set(null)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && done(null)}>
      <DialogContent className="sm:max-w-sm">
        {ask.choices && (
          <button
            type="button"
            aria-label="Close"
            onClick={() => done(null)}
            className="absolute top-4 right-4 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
        <DialogTitle className={ask.choices ? 'pr-8' : undefined}>{ask.title}</DialogTitle>
        {ask.body && <DialogDescription className="whitespace-pre-line">{ask.body}</DialogDescription>}
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (ask.input === undefined || value.trim()) done(ask.input === undefined ? '' : value.trim())
          }}
        >
          {ask.input !== undefined && (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={80}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          )}
          {ask.choices ? (
            <DialogFooter>
              {ask.choices.map((c) => (
                <Button key={c.value} type="button" variant={c.danger ? 'destructive' : c.primary ? 'default' : 'outline'} autoFocus={c.primary} onClick={() => done(c.value)}>
                  {c.label}
                </Button>
              ))}
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => done(null)}>
                Cancel
              </Button>
              <Button type="submit" variant={ask.danger ? 'destructive' : 'default'} autoFocus={ask.input === undefined}>
                {ask.confirm ?? 'OK'}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmHost() {
  const ask = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current
  )
  return ask ? <Body key={ask.title} ask={ask} /> : null
}
