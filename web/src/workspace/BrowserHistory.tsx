// Adapted from Orca's browser history dialog (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useMemo, useState } from 'react'
import { Globe, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/class-names'
import { clearSince, hostOf, matching, removeVisit, restore, useHistory, type Visit } from '@/lib/browser-history'

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0)
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

function dayHeading(startsAt: number) {
  const today = startOfDay(Date.now())
  if (startsAt === today) return 'Today'
  if (startsAt === startOfDay(today - 1)) return 'Yesterday'
  return dayFormat.format(startsAt)
}

const RANGES = [
  { label: 'Last hour', since: () => Date.now() - 3_600_000 },
  { label: 'Today', since: () => startOfDay(Date.now()) },
  { label: 'All time', since: () => 0 }
]

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-muted px-1 font-sans text-2xs text-muted-foreground">{children}</kbd>
}

export function BrowserHistory({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (url: string) => void }) {
  const all = useHistory()
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState(0)
  const [cleared, setCleared] = useState<Visit[] | null>(null)
  const rows = useMemo(() => matching(all, query).sort((a, b) => b.last - a.last), [all, query])
  const days = useMemo(() => {
    const out: { startsAt: number; rows: Visit[] }[] = []
    for (const v of rows) {
      const d = startOfDay(v.last)
      if (out.at(-1)?.startsAt !== d) out.push({ startsAt: d, rows: [] })
      out.at(-1)!.rows.push(v)
    }
    return out
  }, [rows])

  const go = (v: Visit | undefined) => {
    if (!v) return
    onClose()
    onOpen(v.url)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setPick((p) => Math.max(0, Math.min(rows.length - 1, p + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(rows[pick])
    } else if (e.key === 'Delete' && e.shiftKey && rows[pick]) {
      e.preventDefault()
      removeVisit(rows[pick].url)
    }
  }

  let index = -1
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return
        setQuery('')
        setCleared(null)
        onClose()
      }}
    >
      <DialogContent className="top-[min(10%,4rem)] w-[720px] max-w-[96vw] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[720px]" onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">History</DialogTitle>
        <DialogDescription className="sr-only">Search and manage browsing history</DialogDescription>
        <label className="flex h-11 items-center gap-2 border-b border-border/60 px-3.5">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPick(0)
            }}
            placeholder="Search history"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div className="scrollbar-sleek max-h-[min(560px,calc(100vh-14rem))] overflow-y-auto p-1.5">
          {!rows.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">{all.length ? 'No pages match your search' : 'Pages you visit will show up here'}</p>
          )}
          {days.map((day) => (
            <section key={day.startsAt} className="pb-1">
              <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{dayHeading(day.startsAt)}</h3>
              {day.rows.map((v) => {
                index += 1
                const mine = index
                return (
                  <div
                    key={v.url}
                    role="option"
                    aria-selected={pick === mine}
                    onMouseMove={() => setPick(mine)}
                    onClick={() => go(v)}
                    className={cn('group/row flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5', pick === mine && 'bg-accent')}
                  >
                    <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="truncate text-[13px] text-foreground">{v.title || hostOf(v.url)}</span>
                      <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">{v.url}</span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeFormat.format(v.last)}</span>
                    <button
                      type="button"
                      aria-label="Remove from history"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeVisit(v.url)
                      }}
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-foreground/10 hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border/60 px-3.5 py-2 text-2xs text-muted-foreground">
          {cleared ? (
            <div className="flex items-center gap-2">
              <span>Cleared browsing history</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  restore(cleared)
                  setCleared(null)
                }}
              >
                Undo
              </Button>
            </div>
          ) : (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" disabled={!all.length}>
                  <Trash2 /> Clear history
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuLabel>Clear history from</DropdownMenuLabel>
                {RANGES.map((r) => (
                  <DropdownMenuItem
                    key={r.label}
                    onSelect={() => {
                      const gone = clearSince(r.since())
                      if (gone.length) setCleared(gone)
                    }}
                  >
                    {r.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="flex items-center gap-2">
            <Key>Enter</Key> <span>Open</span>
            <Key>Shift Delete</Key> <span>Remove</span>
            <Key>Esc</Key> <span>Close</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
