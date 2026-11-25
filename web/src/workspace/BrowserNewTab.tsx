// Adapted from Orca's browser new tab page (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useState } from 'react'
import { ArrowUpRight, Globe, GitPullRequest, X } from 'lucide-react'
import { toast } from 'sonner'
import { Hint } from '@/components/ui/tooltip'
import { hostOf, removeVisit, restore, topSites, useHistory } from '@/lib/browser-history'
import type { Session, YardbellState } from '@/lib/state'
import type { Place } from './SendNotes'
import { sessionsIn } from './SendNotes'

type Port = { service?: string; remote?: number; local?: number }
type Pull = { number?: number; url?: string; title?: string; forge?: string }

export function Favicon({ url, className }: { url: string; className: string }) {
  const [failed, setFailed] = useState(false)
  let src = ''
  try {
    src = new URL('/favicon.ico', url).href
  } catch {}
  if (failed || !src) return <Globe className={`${className} text-muted-foreground`} />
  return <img src={src} alt="" className={className} onError={() => setFailed(true)} />
}

function Row({ icon, title, detail, onOpen }: { icon: React.ReactNode; title: string; detail: React.ReactNode; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/row flex w-full min-w-0 items-center gap-3.5 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted group-hover/row:bg-background group-focus-visible/row:bg-background">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
    </button>
  )
}

function Section({ label, detail, children }: { label: string; detail?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex min-w-0 gap-1.5 px-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-semibold tracking-[0.05em] uppercase">{label}</span>
        {detail && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{detail}</span>
          </>
        )}
      </h2>
      {children}
    </section>
  )
}

function Scroller({ children }: { children: React.ReactNode }) {
  return (
    <div className="scrollbar-sleek @container absolute inset-0 z-10 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[680px] flex-col gap-8 px-3 pt-14 pb-12 @xs:px-6">{children}</div>
    </div>
  )
}

const portUrl = (local: number) => `${location.protocol}//${location.hostname}:${local}`

export function BrowserNewTab({ place, state, onOpen }: { place: Place | null; state: YardbellState | null; onOpen: (url: string) => void }) {
  const history = useHistory()
  const suggested = topSites(history, 8)
  const sessions = place ? sessionsIn(state, place.machine, place.path) : []
  const servers = sessions.flatMap((s) => ((s as Session & { ports?: Port[] }).ports || []).filter((p) => p.local).map((p) => ({ p, s })))
  const pulls = new Map<string, Pull>()
  for (const s of sessions) {
    const pull = s.pull as Pull | null | undefined
    if (pull?.url && !pulls.has(pull.url)) pulls.set(pull.url, pull)
  }
  const workspaceName = place?.path.split('/').filter(Boolean).pop()

  const remove = (url: string) => {
    const gone = removeVisit(url)
    if (gone) toast(`Removed “${gone.title || hostOf(gone.url)}” from history`, { action: { label: 'Undo', onClick: () => restore([gone]) } })
  }

  if (!servers.length && !pulls.size && !suggested.length)
    return (
      <Scroller>
        <div className="flex flex-col items-center gap-2.5 px-4 pt-16 text-center">
          <div className="mb-1.5 grid size-13 place-items-center rounded-full border border-border text-muted-foreground">
            <Globe className="size-5" />
          </div>
          <p className="text-base font-semibold text-foreground">New Tab</p>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            Search or enter an address above. Sites you visit, app ports the sessions here forward, and their pull request will show up here.
          </p>
        </div>
      </Scroller>
    )

  return (
    <Scroller>
      {(servers.length > 0 || pulls.size > 0) && (
        <Section label="This workspace" detail={workspaceName}>
          <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-card p-1.5">
            {servers.map(({ p, s }) => (
              <Row
                key={`${s.id}${p.local}`}
                icon={<Favicon url={portUrl(p.local!)} className="size-5" />}
                title={p.service || s.branch || 'App'}
                detail={
                  <>
                    <span className="mr-1.5 inline-block size-1.5 rounded-full bg-status-success align-middle" />
                    <span className="font-mono">localhost:{p.local}</span>
                    {p.remote && p.remote !== p.local ? ` · port ${p.remote} on ${s.machine}` : ` · ${s.machine}`}
                  </>
                }
                onOpen={() => onOpen(portUrl(p.local!))}
              />
            ))}
            {servers.length > 0 && pulls.size > 0 && <div className="mx-3 my-1 h-px bg-border" />}
            {[...pulls.values()].map((pull) => (
              <Row
                key={pull.url}
                icon={<GitPullRequest className="size-4 text-muted-foreground" />}
                title={pull.title || `${pull.forge === 'gitlab' ? '!' : '#'}${pull.number}`}
                detail={`${pull.forge === 'gitlab' ? 'Merge request' : 'Pull request'} ${pull.forge === 'gitlab' ? '!' : '#'}${pull.number}`}
                onOpen={() => window.open(pull.url, '_blank', 'noopener')}
              />
            ))}
          </div>
        </Section>
      )}
      {suggested.length > 0 && (
        <Section label="Suggested">
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
            {suggested.map((v) => (
              <div key={v.url} className="group/tile relative min-w-0">
                <Hint label={v.title && v.title !== hostOf(v.url) ? `${v.title} · ${v.url}` : v.url} side="top">
                  <button
                    type="button"
                    onClick={() => onOpen(v.url)}
                    className="flex h-24 w-full min-w-0 flex-col items-center justify-center gap-3 rounded-2xl px-2 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @md:h-28 @md:gap-3.5"
                  >
                    <Favicon url={v.url} className="size-8" />
                    <span className="max-w-full truncate text-sm text-foreground">{v.title || hostOf(v.url)}</span>
                  </button>
                </Hint>
                <button
                  type="button"
                  aria-label="Remove from history"
                  onClick={() => remove(v.url)}
                  className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 outline-none group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
    </Scroller>
  )
}
