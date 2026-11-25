/* eslint-disable @typescript-eslint/no-explicit-any */
// The board and its toolbar follow Orca's agent dashboard (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  ExternalLink,
  Filter,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LayoutList,
  MessageCircleQuestion,
  MemoryStick,
  TriangleAlert,
  Workflow,
  Zap,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SquareArrowOutUpRight,
  SquareTerminal,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { MenuItems, later, type MenuEntry } from '@/components/ui/menu-items'
import { Hint } from '@/components/ui/tooltip'
import { confirmAction } from '@/lib/confirm'
import { copy, openShell } from '@/lib/actions'
import { cn } from '@/lib/class-names'
import { openInsights } from '@/insights/Insights'
import { pageOfLegacy, pathOf } from '@/shell/pages'
import { MoveDialog, RemoveWorktreeDialog, SetupDialog, setupNote } from './Dialogs'
import {
  LANES,
  api,
  canMerge,
  connection,
  describe,
  enc,
  gb,
  lane,
  lasted,
  limitPct,
  memPct,
  mergeText,
  noun,
  order,
  plural,
  portTone,
  pullStatus,
  ref,
  reviewMark,
  reviewable,
  short,
  tone,
  toneWord,
  type DashState,
  type Ended,
  type LaneKey,
  type Mach,
  type PullInfo,
  type Sess,
  type Setup
} from './model'

const VIEW_KEY = 'yardbell.dashboard.view'
const MACHINE_KEY = 'yardbell.tree.machine.dashboard'
const IDLE_KEY = 'yardbell.dashboard.idle'
const SUGGEST_KEY = 'yardbell.dispatch.suggest'
const LEAVING_FOR = 15000
const onHost = ['localhost', '127.0.0.1'].includes(location.hostname)
const touch = matchMedia('(pointer: coarse)')

const remembered = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const remember = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {}
}

// A link the old pages wrote goes to the same page here when there is one.
export function follow(href: string) {
  const url = new URL(href, location.origin)
  if (url.origin !== location.origin) return void window.open(url.href, '_blank', 'noopener')
  const to = pageOfLegacy(url.href)
  if (!to) return void location.assign(url.href)
  history.pushState(null, '', `${pathOf(to.id)}${to.search}${url.hash}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const TONE: Record<string, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  pending: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  done: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  '': 'border-border bg-muted/60 text-muted-foreground'
}
const DOT: Record<string, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-destructive' }
const pill = 'inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] leading-none whitespace-nowrap'

function Dot({ t, title }: { t: string; title?: string }) {
  return <span title={title} className={cn('inline-block size-2 shrink-0 rounded-full', DOT[t] || 'bg-muted-foreground/50')} />
}

function StatusBadge({ s }: { s: Sess }) {
  if (s.stale) return <span className={cn(pill, TONE[''])}>Last known</span>
  if (s.activity === 'blocked')
    return (
      <span title="Waiting for your answer or approval" className={cn(pill, 'border-agent-question/40 bg-agent-question/10 text-agent-question-text')}>
        Needs you
      </span>
    )
  if (s.stopped) {
    const resets = s.resets ? new Date(s.resets) : null
    const when = resets ? resets.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    const future = resets && resets.getTime() > Date.now()
    const next = !resets ? '' : future ? ` Its limit resets at ${when}, and Dispatch then offers to resume it.` : ` Its limit reset at ${when}.`
    return (
      <span title={`Its last turn ended on: ${s.stopped}.${next}`} className={cn(pill, TONE.bad)}>
        {future ? `Limit until ${when}` : 'Error'}
      </span>
    )
  }
  return s.activity === 'active' ? <span className={cn(pill, TONE.pending)}>Working</span> : <span className={cn(pill, TONE[''])}>Idle</span>
}

const PR_ICON: Record<string, typeof GitPullRequest> = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed }

function PullBadge({ p }: { p?: PullInfo | null }) {
  if (!p) return null
  const { word, tone: t } = pullStatus(p)
  const Icon = PR_ICON[p.draft && p.state === 'open' ? 'draft' : p.state] || GitPullRequest
  return (
    <a href={p.url} target="_blank" rel="noopener" title={describe(p)} onClick={(e) => e.stopPropagation()} className={cn(pill, TONE[t], 'hover:underline')}>
      <Icon className="size-2.5" />
      <span className="tabular-nums">{ref(p)}</span>
      {word}
    </a>
  )
}

function Marks({ s, onSetup }: { s: Sess; onSetup: (r: Setup) => void }) {
  const m = reviewMark(s)
  return (
    <>
      <PullBadge p={s.pull} />
      {m && (
        <button
          type="button"
          title={m.title}
          onClick={(e) => {
            e.stopPropagation()
            follow(m.href)
          }}
          className={cn(pill, TONE[m.tone], 'hover:underline')}
        >
          {m.word}
        </button>
      )}
      {!s.pull && s.pull_why && (
        <button
          type="button"
          title={s.pull_why}
          onClick={(e) => {
            e.stopPropagation()
            follow('/settings#pull-requests')
          }}
          className={cn(pill, TONE[''], 'hover:text-foreground')}
        >
          No PR info
        </button>
      )}
      {s.setup && (
        <button
          type="button"
          title={setupNote(s.setup)}
          onClick={(e) => {
            e.stopPropagation()
            onSetup(s.setup!)
          }}
          className={cn(pill, s.setup.ok ? TONE[''] : TONE.bad)}
        >
          {s.setup.ok ? 'Setup ran' : s.setup.timed_out ? 'Setup timed out' : 'Setup failed'}
        </button>
      )}
    </>
  )
}

function Bar({ parts, label }: { parts: { cls: string; pct: number }[]; label: string }) {
  return (
    <div role="img" aria-label={label} className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {parts.map((p, i) => (
        <span key={i} className={p.cls} style={{ width: `${Math.max(0, Math.min(100, p.pct))}%` }} />
      ))}
    </div>
  )
}

const level = (pct: number) => (pct >= 95 ? 'text-destructive' : pct >= 85 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')

function Memory({ m }: { m: Mach }) {
  const h = m.health
  if (!m.up || !h || !h.mem_total_kb) return null
  // RSS counts shared pages once per process, so the per-account sums can exceed what is in use.
  const used = Math.min(h.mem_used_kb, h.mem_total_kb)
  const agents = Math.min(h.agent_kb, used)
  const split = h.user_kb > 0
  const mine = split ? Math.min(Math.max(h.user_kb, agents), used) : agents
  const yours = mine - agents
  const others = used - mine
  const free = Math.max(h.mem_total_kb - used, 0)
  const share = (kb: number) => (kb / h.mem_total_kb) * 100
  const pct = memPct(m) ?? 0
  const parts: [string, string, number, string][] = [['agents', 'Agents', agents, 'bg-sky-500']]
  if (split) parts.push(['mine', 'Your other processes', yours, 'bg-violet-400'])
  if (!split || others > 0) parts.push(['other', split ? 'Other accounts' : 'Other', others, 'bg-muted-foreground/45'])
  parts.push(['free', 'Free', free, 'bg-muted'])
  const label = `Memory ${pct}% used of ${gb(h.mem_total_kb)} GB: ` + parts.map(([, n, kb]) => `${n.toLowerCase()} ${gb(kb)} GB`).join(', ')
  const accounts = (m.accounts || []).some((a) => !a.you) ? m.accounts!.slice(0, 6) : []
  const limit = limitPct(m)
  return (
    <div className="grid gap-1">
      <div className="text-[11px] text-muted-foreground">
        Memory <span className={cn('font-medium tabular-nums', level(pct))}>{pct}% used</span> of {gb(h.mem_total_kb)} GB
      </div>
      <Bar label={label} parts={parts.slice(0, -1).map(([, , kb, cls]) => ({ cls, pct: share(kb) }))} />
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10.5px] text-muted-foreground">
        {parts.map(([k, n, kb, cls]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <i className={cn('inline-block size-1.5 rounded-full', k === 'free' ? 'border border-border bg-transparent' : cls)} />
            {n} {gb(kb)} GB
          </span>
        ))}
      </div>
      {accounts.length > 0 && (
        <div className="flex flex-wrap gap-x-2.5 text-[10.5px] text-muted-foreground">
          {accounts.map((a) => (
            <span key={a.name} title={a.containers_kb ? `${gb(a.containers_kb)} GB of it in containers` : undefined} className={cn(a.you && 'text-foreground')}>
              {a.name}
              {a.you ? ' (you)' : ''} <b className="font-medium">{gb(a.kb)} GB</b>
            </span>
          ))}
        </div>
      )}
      {limit !== null && (
        <div className="text-[10.5px] text-muted-foreground">
          Your account's limit:{' '}
          <b className={cn('font-medium', level(limit))}>
            {gb(h.limit_used_kb)} of {gb(h.limit_kb)} GB
          </b>
          , {limit}%
        </div>
      )}
    </div>
  )
}

function Disk({ m }: { m: Mach }) {
  const h = m.health
  if (!m.up || !h || !h.disk_total_kb) return null
  const pct = Math.round(((h.disk_used_kb ?? 0) / h.disk_total_kb) * 100)
  const free = Math.max(h.disk_total_kb - (h.disk_used_kb ?? 0), 0)
  return (
    <div className="grid gap-1">
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Disk <span className={cn('font-medium tabular-nums', level(pct))}>{pct}% used</span> of {gb(h.disk_total_kb)} GB
        </span>
        <span>{gb(free)} GB free</span>
      </div>
      <Bar label={`Disk ${pct}% used of ${gb(h.disk_total_kb)} GB, ${gb(free)} GB free`} parts={[{ cls: 'bg-muted-foreground/45', pct }]} />
    </div>
  )
}

function Ports({ s }: { s: Sess }) {
  if (!s.ports?.length) return null
  return (
    <ul className="grid gap-0.5">
      {s.ports.map((p) => {
        const t = portTone(p.status)
        const name = (
          <>
            <Dot t={t} title={p.status} />
            <span className="truncate">{p.service}</span>
            <span className="text-muted-foreground tabular-nums">:{p.local ?? p.remote}</span>
          </>
        )
        return (
          <li key={`${p.service}${p.remote}`} className="flex items-center gap-1.5 text-[11.5px]">
            {p.url ? (
              <a href={p.url} target="_blank" rel="noopener" title={`${p.status}, remote port ${p.remote}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-1.5 hover:underline">
                {name}
                <ExternalLink className="size-3 text-muted-foreground" />
              </a>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">{name}</span>
            )}
            <span className={cn('ml-auto text-[10.5px]', t === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : t === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-destructive')}>{p.status}</span>
          </li>
        )
      })}
    </ul>
  )
}

type Ctx = {
  state: DashState
  agentLabel: (name: string) => string
  focusedId: string
  open: (s: Sess) => void
  menu: (s: Sess) => MenuEntry[]
  merge: (s: Sess) => void
  setup: (r: Setup) => void
}

function Identity({ s, ctx, extra }: { s: Sess | (Ended & { pull?: null }); ctx: Ctx; extra?: React.ReactNode }) {
  const sess = s as Sess
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13px] font-medium" title={s.folder}>
          {short(s.folder)}
        </span>
        {s.ticket && s.ticket !== '-' && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10.5px] text-muted-foreground">{s.ticket}</span>}
        {extra}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {s.branch && <span className="max-w-[18rem] truncate font-mono text-[11px]">{s.branch}</span>}
        {'ports' in s && <Marks s={sess} onSetup={ctx.setup} />}
        {s.agent && <span>{ctx.agentLabel(s.agent)}</span>}
      </div>
    </div>
  )
}

function RowMenu({ items, label }: { items: MenuEntry[]; label: string }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} title="More" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuItems items={items} as="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SessionRow({ s, ctx }: { s: Sess; ctx: Ctx }) {
  const openable = s.attachable && !s.stale
  const items = ctx.menu(s)
  const row = (
    <li
      data-id={openable ? s.id : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-label={openable ? `Open ${short(s.folder)} on ${s.machine}` : undefined}
      onClick={(e) => {
        // A menu's portal is outside the row, yet React still bubbles its clicks here.
        if (!openable || !e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest('a, button')) return
        // On a touch screen the whole row as one target swallowed taps meant for the buttons.
        if (touch.matches) return
        ctx.open(s)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && openable && e.target === e.currentTarget) ctx.open(s)
      }}
      className={cn(
        'group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,14rem)_auto]',
        openable && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:outline-none',
        ctx.focusedId === s.id && 'bg-accent/50',
        s.stale && 'opacity-60'
      )}
    >
      <Identity s={s} ctx={ctx} />
      <div className="justify-self-end md:justify-self-start">
        <StatusBadge s={s} />
      </div>
      <div className="col-span-2 min-w-0 md:col-span-1">
        <Ports s={s} />
      </div>
      <div className="col-span-2 flex items-center justify-end gap-1 md:col-span-1">
        {openable && (
          <>
            {canMerge(s) && (
              <Button variant="outline" size="xs" title={`Merge ${noun(s.pull!).toLowerCase()} ${ref(s.pull!)} into ${s.pull!.base || 'its base branch'}`} onClick={() => ctx.merge(s)}>
                <GitMerge /> Merge {ref(s.pull!)}
              </Button>
            )}
            <Button variant="outline" size="xs" onClick={() => ctx.open(s)}>
              <SquareTerminal /> Open
            </Button>
            <RowMenu items={items} label={`More for ${s.tmux}`} />
          </>
        )}
      </div>
    </li>
  )
  if (!openable) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <MenuItems items={items} as="context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}

type Acts = {
  newSession: (machine?: string, path?: string) => void
  shell: (machine: string) => void
  machineMenu: (m: Mach) => MenuEntry[]
  moveToTmux: (s: Sess) => void
  stopPid: (s: Sess) => void
  resume: (e: Ended) => void
  removeWorktree: (machine: string, path: string) => void
  insights: (machine: string, name: string) => void
  forget: (e: Ended) => void
}

function MachineGroup({ m, ctx, acts, filtering, matches, matchesEnded }: { m: Mach; ctx: Ctx; acts: Acts; filtering: boolean; matches: (s: Sess) => boolean; matchesEnded: (e: Ended) => boolean }) {
  const [folded, setFolded] = useState(() => remembered(`collapsed:${m.name}`) === '1')
  const [panels, setPanels] = useState<Record<string, boolean>>(() => ({
    loose: remembered(`open:loose:${m.name}`) === '1',
    stale: remembered(`open:stale:${m.name}`) === '1',
    ended: remembered(`open:ended:${m.name}`) === '1'
  }))
  const mine = ctx.state.sessions.filter((s) => s.machine === m.name)
  const rows = mine.filter((s) => s.attachable && !s.stale && matches(s))
  const stale = mine.filter((s) => s.stale && matches(s))
  const loose = mine.filter((s) => !s.attachable && !s.stale && matches(s))
  const ended = (ctx.state.ended || []).filter((e) => e.machine === m.name && matchesEnded(e))
  if (filtering && !rows.length && !loose.length && !ended.length && !stale.length) return null
  const live = mine.filter((s) => !s.stale).length
  const collapsed = !filtering && folded
  const t = tone(m)
  const toggle = (kind: string) => {
    const next = !panels[kind]
    setPanels((p) => ({ ...p, [kind]: next }))
    remember(`open:${kind}:${m.name}`, next ? '1' : '0')
  }
  const isOpen = (kind: string) => filtering || panels[kind]
  const sub = 'flex flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-accent/30'

  return (
    <section aria-labelledby={`mg-${m.name}`} className={cn('overflow-hidden rounded-xl border bg-card', t === 'warn' ? 'border-amber-500/40' : t === 'bad' ? 'border-border/60 opacity-80' : 'border-border/60')}>
      <header className="grid gap-3 border-b border-border/60 bg-muted/30 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)_auto] md:items-start">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {filtering ? (
              <span className="size-5" />
            ) : (
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? 'Show' : 'Hide'} sessions on ${m.name}`}
                onClick={() => {
                  setFolded(!folded)
                  remember(`collapsed:${m.name}`, folded ? '0' : '1')
                }}
                className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronRight className={cn('size-3.5 transition-transform', !collapsed && 'rotate-90')} />
              </button>
            )}
            <Dot t={t} title={toneWord(m)} />
            <h2 id={`mg-${m.name}`} className="truncate text-[13.5px] font-semibold">
              {m.name}
            </h2>
            {m.up && <span className="rounded-full bg-background px-1.5 text-[11px] text-muted-foreground tabular-nums">{plural(live, 'session')}</span>}
          </div>
          <p className="mt-0.5 pl-[26px] text-[11.5px] text-muted-foreground">{connection(m, ctx.state.mesh)}</p>
        </div>
        <div className="grid gap-2 pl-[26px] md:pl-0">
          <Memory m={m} />
          <Disk m={m} />
        </div>
        <div className="flex items-center gap-0.5 justify-self-end">
          {m.up && (
            <>
              <Hint label={`New session on ${m.name}`}>
                <Button variant="ghost" size="icon-xs" aria-label={`New session on ${m.name}`} onClick={() => acts.newSession(m.name)}>
                  <Plus />
                </Button>
              </Hint>
              <Hint label={`Open a shell on ${m.name}`}>
                <Button variant="ghost" size="icon-xs" aria-label={`Open a shell on ${m.name}`} onClick={() => acts.shell(m.name)}>
                  <SquareTerminal />
                </Button>
              </Hint>
            </>
          )}
          <RowMenu items={acts.machineMenu(m)} label={`More for ${m.name}`} />
        </div>
      </header>
      {!collapsed && (
        <>
          <ul className="divide-y divide-border/50">
            {rows.length ? (
              rows.map((s) => <SessionRow key={s.id} s={s} ctx={ctx} />)
            ) : (
              <li className="flex items-center justify-between gap-2 px-3 py-3 text-[12.5px] text-muted-foreground">
                {filtering ? (
                  'No matching open sessions'
                ) : m.up ? (
                  <>
                    No open sessions
                    <Button variant="ghost" size="xs" onClick={() => acts.newSession(m.name)}>
                      Start one
                    </Button>
                  </>
                ) : (
                  'Unreachable. Its sessions reappear when it reconnects.'
                )}
              </li>
            )}
          </ul>
          {(loose.length > 0 || ended.length > 0 || stale.length > 0) && (
            <div className="flex gap-1 border-t border-border/50 px-2 py-1.5">
              {stale.length > 0 && (
                <Button variant="ghost" size="xs" aria-expanded={isOpen('stale')} onClick={() => toggle('stale')} className="text-muted-foreground">
                  <ChevronRight className={cn('transition-transform', isOpen('stale') && 'rotate-90')} />
                  <span className="tabular-nums">{stale.length}</span> last known
                </Button>
              )}
              {loose.length > 0 && (
                <Button variant="ghost" size="xs" aria-expanded={isOpen('loose')} onClick={() => toggle('loose')} className="text-muted-foreground">
                  <ChevronRight className={cn('transition-transform', isOpen('loose') && 'rotate-90')} />
                  <span className="tabular-nums">{loose.length}</span> outside tmux
                </Button>
              )}
              {ended.length > 0 && (
                <Button variant="ghost" size="xs" aria-expanded={isOpen('ended')} onClick={() => toggle('ended')} className="text-muted-foreground">
                  <ChevronRight className={cn('transition-transform', isOpen('ended') && 'rotate-90')} />
                  <span className="tabular-nums">{ended.length}</span> ended
                </Button>
              )}
            </div>
          )}
          {stale.length > 0 && isOpen('stale') && (
            <div className="border-t border-border/50 bg-muted/20">
              <p className="px-3 pt-2 text-[11.5px] text-muted-foreground">What ran on {m.name} when Yardbell last reached it. They may still be running; they open again once it reconnects.</p>
              <ul className="divide-y divide-border/40">
                {stale.map((s) => (
                  <SessionRow key={s.id} s={s} ctx={ctx} />
                ))}
              </ul>
            </div>
          )}
          {loose.length > 0 && isOpen('loose') && (
            <div className="border-t border-border/50 bg-muted/20">
              <p className="px-3 pt-2 text-[11.5px] text-muted-foreground">
                Yardbell can only open sessions that run in tmux. Move one to stop its agent and start it again in tmux with the same conversation, or{' '}
                <a className="underline" href="https://github.com/hbasheer/yardbell#making-every-session-openable" target="_blank" rel="noopener">
                  start agents inside tmux
                </a>{' '}
                from now on.
              </p>
              <ul className="divide-y divide-border/40">
                {loose.map((s) => (
                  <li key={s.id} className={sub}>
                    <Identity s={s} ctx={ctx} extra={s.activity === 'active' && <span title="Estimated from CPU use" className={cn(pill, TONE.pending)}>Working</span>} />
                    <div className="flex gap-1">
                      <Button variant="outline" size="xs" onClick={() => acts.moveToTmux(s)}>
                        Move to tmux
                      </Button>
                      <Button variant="ghost-destructive" size="xs" onClick={() => acts.stopPid(s)}>
                        Stop
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ended.length > 0 && isOpen('ended') && (
            <ul className="divide-y divide-border/40 border-t border-border/50 bg-muted/20">
              {ended.map((e) => (
                <li key={e.id} className={sub}>
                  <Identity s={{ ...e, branch: e.worktree ? e.branch : '' }} ctx={ctx} />
                  <div className="flex flex-wrap gap-1">
                    <Button variant="outline" size="xs" onClick={() => acts.resume(e)}>
                      Resume
                    </Button>
                    {e.worktree && e.path && (
                      <Button variant="ghost-destructive" size="xs" onClick={() => acts.removeWorktree(e.machine, e.path!)}>
                        Remove worktree
                      </Button>
                    )}
                    <Button variant="ghost" size="xs" title="When it worked, waited and idled, and the tools and tests it ran" onClick={() => acts.insights(e.machine, e.id.slice(e.machine.length + 1))}>
                      Insights
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => acts.forget(e)}>
                      Forget
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function BoardCard({ s, ctx, onPreview }: { s: Sess; ctx: Ctx; onPreview: (s: Sess) => void }) {
  const openable = s.attachable && !s.stale
  const needs = lane(s) === 'needs'
  const isReady = lane(s) === 'ready'
  const heading = s.branch || short(s.folder).split('/').pop() || s.folder
  const card = (
    <div
      data-id={openable ? s.id : undefined}
      className={cn(
        'group flex w-full flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors',
        needs
          ? 'border-agent-question/40 bg-agent-question/[0.06] hover:border-agent-question/60 hover:bg-agent-question/10'
          : isReady
            ? 'border-emerald-500/40 bg-emerald-500/[0.06] hover:border-emerald-500/60 hover:bg-emerald-500/10'
            : 'border-border/60 bg-card hover:border-border hover:bg-accent/40',
        ctx.focusedId === s.id && 'ring-2 ring-ring',
        s.stale && 'opacity-60'
      )}
    >
      <button
        type="button"
        disabled={!openable}
        tabIndex={openable ? 0 : -1}
        aria-label={openable ? `Open ${short(s.folder)} on ${s.machine}` : undefined}
        onClick={() => onPreview(s)}
        className="flex w-full flex-col gap-1.5 text-left focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
      >
        <div className="flex w-full items-center gap-1.5">
          <span className="truncate font-mono text-[12px]" title={heading}>
            {heading}
          </span>
          {s.ticket && s.ticket !== '-' && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{s.ticket}</span>}
          <span className="ml-auto">
            <StatusBadge s={s} />
          </span>
        </div>
        <div className="truncate text-xs text-foreground/80" title={s.folder}>
          {short(s.folder)}
        </div>
        {s.activity === 'blocked' && (
          <div className="flex w-full items-start gap-1 rounded-md bg-agent-question/15 px-1.5 py-1 text-[11px] text-agent-question-text ring-1 ring-agent-question/25 ring-inset">
            <MessageCircleQuestion className="mt-px size-3 shrink-0" />
            <span className="line-clamp-2">Waiting for your answer or approval</span>
          </div>
        )}
      </button>
      <div className="flex flex-wrap items-center gap-1">
        <Marks s={s} onSetup={ctx.setup} />
      </div>
      <div className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-muted-foreground/10" title={s.machine}>
          <Server className="size-3" />
        </span>
        <span className="truncate">{[s.machine, s.agent ? ctx.agentLabel(s.agent) : ''].filter(Boolean).join(' · ')}</span>
        {openable && isReady && canMerge(s) && (
          <Button variant="outline" size="xs" className="ml-auto h-6" onClick={() => ctx.merge(s)}>
            <GitMerge /> Merge {ref(s.pull!)}
          </Button>
        )}
      </div>
    </div>
  )
  if (!openable) return card
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <MenuItems items={ctx.menu(s)} as="context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}

function Board({ machines, visible, ctx, showIdle, onPreview }: { machines: Mach[]; visible: Sess[]; ctx: Ctx; showIdle: boolean; onPreview: (s: Sess) => void }) {
  const rank = new Map(machines.map((m, i) => [m.name, i]))
  const lanes = new Map<LaneKey, Sess[]>(LANES.map((l) => [l.key, []]))
  for (const s of visible) lanes.get(lane(s))!.push(s)
  for (const list of lanes.values()) list.sort((a, b) => (rank.get(a.machine) ?? 0) - (rank.get(b.machine) ?? 0))
  const shown = LANES.filter((l) => l.key !== 'idle' || showIdle)
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 overflow-x-auto p-3">
      <div className="mx-auto flex w-full max-w-[1480px] gap-3">
        {shown.map((l) => {
          const list = lanes.get(l.key)!
          return (
            <section key={l.key} aria-label={l.title} className="flex min-w-[220px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30">
              <header className="flex items-center gap-2 px-3 py-2" title={l.help}>
                <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">{l.title}</span>
                <span className="ml-auto rounded-full bg-background px-1.5 text-[11px] text-muted-foreground tabular-nums">{list.length}</span>
              </header>
              <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {list.length ? (
                  <div role="list" className="flex flex-col gap-2">
                    {list.map((s) => (
                      <div role="listitem" key={s.id}>
                        <BoardCard s={s} ctx={ctx} onPreview={onPreview} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground">None</p>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function Preview({ s, ctx, onClose, onOpen }: { s: Sess | null; ctx: Ctx; onClose: () => void; onOpen: (s: Sess) => void }) {
  return (
    <Dialog open={s !== null} onOpenChange={(o) => !o && onClose()}>
      {s && (
        <DialogContent aria-describedby={undefined} className="flex h-[min(80dvh,760px)] w-[calc(100vw-40px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[1200px]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-3 py-2">
            <DialogTitle className="truncate text-[12.5px] font-semibold">{s.branch || short(s.folder)}</DialogTitle>
            <span className="truncate text-[11px] text-muted-foreground">
              {short(s.folder)} · {s.machine} · {ctx.agentLabel(s.agent)}
            </span>
            <StatusBadge s={s} />
            <Button variant="ghost" size="icon-xs" className="ml-auto opacity-70 hover:opacity-100" onClick={onClose}>
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </Button>
          </div>
          <div className="relative min-h-0 flex-1">
            <iframe title={`Terminal for ${s.tmux}`} src={`/term/${enc(s.machine)}/${enc(s.tmux || '')}?embed=1`} data-unzoom="" className="absolute inset-0 size-full border-0 bg-black" />
          </div>
          <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <Marks s={s} onSetup={ctx.setup} />
            </div>
            <span className="ml-auto" />
            <RowMenu items={ctx.menu(s).filter((e) => !(e && typeof e === 'object' && e.label === 'Open in Workspace'))} label={`More for ${s.tmux}`} />
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                onClose()
                onOpen(s)
              }}
            >
              <SquareArrowOutUpRight className="size-3" /> Open in Workspace
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

const STUCK: Record<string, { icon: typeof Workflow; word: string; open: string }> = {
  run_queued: { icon: Workflow, word: 'Pipeline run', open: 'Open run' },
  run_waiting: { icon: Workflow, word: 'Pipeline run', open: 'Open run' },
  step_quiet: { icon: SquareTerminal, word: 'Pipeline step', open: 'Open run' },
  ci_pending: { icon: GitPullRequest, word: 'Pull request', open: 'Open' },
  trigger_failing: { icon: Zap, word: 'Trigger', open: 'Open trigger' },
  memory_short: { icon: MemoryStick, word: 'Machine', open: 'Open' }
}

// What the health checks found, each with what it is, how long it has lasted and a way to it.
function Stuck({ problems }: { problems: { key: string; title: string; detail: string; link: string; since: string }[] }) {
  const [open, setOpen] = useState(true)
  return (
    <section aria-label="Things that look stuck" className="mx-3 mt-3 shrink-0 overflow-hidden rounded-xl border border-amber-500/35 bg-card md:mx-5">
      <header className="flex items-center gap-3 bg-amber-500/[0.06] px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{problems.length === 1 ? '1 thing looks stuck' : `${problems.length} things look stuck`}</p>
          <p className="text-xs text-muted-foreground">The health checks noticed automation that stopped moving.</p>
        </div>
        <Button variant="ghost" size="xs" onClick={() => follow('/settings#health')}>
          <Settings2 /> Change checks
        </Button>
        <Button variant="ghost" size="icon-xs" aria-expanded={open} aria-label={open ? 'Hide the list' : 'Show the list'} onClick={() => setOpen(!open)}>
          <ChevronDown className={cn('transition-transform', !open && '-rotate-90')} />
        </Button>
      </header>
      {open && (
        <ul className="divide-y divide-border/60">
          {problems.map((p) => {
            const kind = STUCK[p.key.split(':')[0]] || { icon: TriangleAlert, word: 'Check', open: 'Open' }
            const Icon = kind.icon
            const outside = /^https?:/.test(p.link)
            return (
              <li key={p.key} className="flex items-center gap-3 px-4 py-2.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">
                    <span className="font-medium">{p.title.charAt(0).toUpperCase() + p.title.slice(1)}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {kind.word} · {p.detail}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 text-[11px] leading-5 font-medium text-amber-700 tabular-nums dark:text-amber-300">
                  for {lasted(p.since)}
                </span>
                <Button size="xs" variant="outline" onClick={() => (outside ? window.open(p.link, '_blank', 'noopener') : follow(p.link))}>
                  {kind.open} {outside && <ExternalLink />}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Banner({ tone: t, children }: { tone: 'warn' | 'info'; children: React.ReactNode }) {
  return (
    <div role="alert" className={cn('mx-3 mt-3 shrink-0 rounded-lg border px-3 py-2.5 text-[12.5px] md:mx-5', t === 'warn' ? 'border-amber-500/40 bg-amber-500/[0.07]' : 'border-border bg-muted/40')}>
      {children}
    </div>
  )
}

type Filters = { projects: string[]; reviews: string[] }
const REVIEWS = [
  { id: 'none', label: 'No pull request' },
  { id: 'open', label: 'Open' },
  { id: 'draft', label: 'Draft' },
  { id: 'needs', label: 'Needs a fix' },
  { id: 'ready', label: 'Ready to merge' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' }
]
function reviewOf(s: Sess): string[] {
  const p = s.pull
  if (!p) return ['none']
  if (p.state !== 'open') return [p.state]
  const out = [p.draft ? 'draft' : 'open']
  if (p.ci === 'failing' || p.mergeable === 'conflicting' || p.review === 'changes_requested') out.push('needs')
  if (canMerge(s)) out.push('ready')
  return out
}
const toggled = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

export function DashboardPage({
  state: raw,
  updated,
  offline,
  live,
  onOpenSession,
  onNewSession
}: {
  state: any
  updated: number
  offline: boolean
  live: boolean
  onOpenSession: (machine: string, name: string) => void
  onNewSession: (machine?: string, path?: string) => void
}) {
  const [selected, setSelected] = useState(() => {
    const q = new URLSearchParams(location.search)
    return (q.has('machine') ? q.get('machine') : remembered(MACHINE_KEY)) || ''
  })
  const [layout, setLayout] = useState<'machines' | 'board'>(() => ((new URLSearchParams(location.search).get('view') || remembered(VIEW_KEY)) === 'board' ? 'board' : 'machines'))
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'needs' | 'active' | 'idle'>('all')
  const [filters, setFilters] = useState<Filters>({ projects: [], reviews: [] })
  const [showIdle, setShowIdle] = useState(() => remembered(IDLE_KEY) !== '0')
  const [focusedId, setFocusedId] = useState('')
  const [preview, setPreview] = useState<Sess | null>(null)
  const [moving, setMoving] = useState<Sess | null>(null)
  const [removing, setRemoving] = useState<{ machine: string; path: string } | null>(null)
  const [setupRun, setSetupRun] = useState<Setup | null>(null)
  const [checking, setChecking] = useState(false)
  const [leaving, setLeaving] = useState<Map<string, number>>(new Map())
  const [, setTick] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sshHosts = useRef<Record<string, string> | null>(null)

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const back = () => {
      const q = new URLSearchParams(location.search)
      if (q.has('machine')) setSelected(q.get('machine') || '')
      if (q.get('view')) setLayout(q.get('view') === 'board' ? 'board' : 'machines')
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])

  useEffect(() => {
    if (!location.pathname.startsWith(pathOf('dashboard'))) return
    const params = new URLSearchParams()
    if (selected) params.set('machine', selected)
    if (layout === 'board') params.set('view', 'board')
    const q = params.toString()
    history.replaceState(null, '', `${pathOf('dashboard')}${q ? `?${q}` : ''}`)
  }, [selected, layout])

  // A stopped session leaves the list at once. A state fetched before the server checked its
  // machine again still lists it, so it stays out until a state without it.
  const state: DashState | null = useMemo(() => {
    if (!raw) return null
    if (!leaving.size) return raw
    return { ...raw, sessions: raw.sessions.filter((s: Sess) => !leaving.has(s.id)) }
  }, [raw, leaving])
  useEffect(() => {
    if (!raw || !leaving.size) return
    const listed = new Set(raw.sessions.map((s: Sess) => s.id))
    const now = Date.now()
    const kept = [...leaving].filter(([id, at]) => now - at < LEAVING_FOR && listed.has(id))
    if (kept.length !== leaving.size) setLeaving(new Map(kept))
  }, [raw, leaving])
  const leave = (id: string) => setLeaving((l) => new Map(l).set(id, Date.now()))

  const machines = useMemo(() => (state ? order(state.machines) : []), [state])
  const sel = selected && state && !state.machines.some((m) => m.name === selected) ? '' : selected
  const pick = (name: string) => {
    setSelected(name)
    remember(MACHINE_KEY, name || null)
  }
  const shownMachines = machines.filter((m) => !sel || m.name === sel)

  const agentLabel = (name: string) => state?.agents.find((a) => a.name === name)?.label || name
  const projectOf = (s: { id: string; folder: string }) => (raw?.projects || []).find((p: any) => p.sessions?.includes(s.id))?.name || short(s.folder)

  const q = query.trim().toLowerCase()
  const filtering = Boolean(q) || status !== 'all' || filters.projects.length > 0 || filters.reviews.length > 0
  const matchesText = (fields: string[]) => !q || fields.join(' ').toLowerCase().includes(q)
  const shownAs = (s: Sess) => (s.activity === 'blocked' ? 'idle' : s.activity)
  const needsYou = (s: Sess) => !s.stale && (s.activity === 'blocked' || Boolean(s.stopped))
  const matches = (s: Sess) => {
    if (status === 'needs' ? !needsYou(s) : status !== 'all' && (s.stale || shownAs(s) !== status)) return false
    if (filters.projects.length && !filters.projects.includes(projectOf(s))) return false
    if (filters.reviews.length && !reviewOf(s).some((r) => filters.reviews.includes(r))) return false
    return matchesText([s.folder, s.branch, s.ticket === '-' ? '' : s.ticket, agentLabel(s.agent), s.machine])
  }
  const matchesEnded = (e: Ended) =>
    status === 'all' && !filters.reviews.length && (!filters.projects.length || filters.projects.includes(projectOf(e))) && matchesText([e.folder, e.ticket === '-' ? '' : e.ticket, agentLabel(e.agent), e.machine])

  const inScope = (state?.sessions || []).filter((s) => !sel || s.machine === sel)
  const live_ = inScope.filter((s) => !s.stale)
  const counts = { all: live_.length, needs: live_.filter(needsYou).length, active: live_.filter((s) => s.activity === 'active').length, idle: live_.filter((s) => shownAs(s) === 'idle').length }
  const listed = inScope.filter((s) => s.attachable || s.stale)
  const visible = listed.filter(matches)
  const projectOptions = useMemo(() => {
    const n = new Map<string, number>()
    for (const s of listed) n.set(projectOf(s), (n.get(projectOf(s)) || 0) + 1)
    return [...n].sort((a, b) => a[0].localeCompare(b[0]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, sel])
  const reviewCount = (id: string) => listed.filter((s) => reviewOf(s).includes(id)).length
  const activeFilters = filters.projects.length + filters.reviews.length

  const open = (s: Sess) => s.tmux && onOpenSession(s.machine, s.tmux)

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const merge = async (s: Sess) => {
    const p = s.pull!
    const text = mergeText(p)
    if (!(await confirmAction({ title: text.title, body: text.body, confirm: 'Merge' }))) return
    run(async () => {
      await api('POST', `/sessions/${enc(s.machine)}/${enc(s.tmux!)}/merge`, { head: p.head })
      toast(`Merged ${ref(p)}`)
    })
  }

  const insights = (machine: string, name: string) =>
    openInsights({
      machine,
      name,
      onSuggest: (data: unknown) => {
        try {
          sessionStorage.setItem(SUGGEST_KEY, JSON.stringify(data))
        } catch {}
        follow('/dispatch')
      }
    })

  const stop = async (s: Sess) => {
    if (!(await confirmAction({ title: `Stop ${s.tmux} on ${s.machine}?`, body: 'The agent in that session closes.', confirm: 'Stop', danger: true }))) return
    run(async () => {
      await api('POST', `/sessions/${enc(s.machine)}/${enc(s.tmux!)}/stop`)
      leave(s.id)
      toast(`Stopped ${s.tmux}`)
    })
  }

  const sessionMenu = (s: Sess): MenuEntry[] => [
    { label: 'Open in Workspace', icon: SquareTerminal, onSelect: () => open(s) },
    { label: 'Open in a new window', icon: ExternalLink, onSelect: () => window.open(`/term/${enc(s.machine)}/${enc(s.tmux!)}`, '_blank', 'noopener') },
    onHost &&
      state?.host_terminal !== 'none' && {
        label: 'Open in the terminal app',
        onSelect: () => run(() => api('POST', `/sessions/${enc(s.machine)}/${enc(s.tmux!)}/host-terminal`))
      },
    'separator',
    canMerge(s) && { label: `Merge ${ref(s.pull!)}`, icon: GitMerge, onSelect: () => merge(s) },
    reviewable(s) && {
      label: `Review ${ref(s.pull!)}`,
      icon: GitPullRequest,
      onSelect: () =>
        run(async () => {
          const res = await api('POST', '/dispatch/reviews', { machine: s.machine, name: s.tmux })
          follow(`/dispatch?c=${enc(res.conversation)}`)
        })
    },
    { label: 'Insights', onSelect: () => insights(s.machine, s.tmux!) },
    { label: 'Move to another machine…', onSelect: () => setMoving(s) },
    s.worktree && s.path && { label: 'Remove worktree…', onSelect: () => setRemoving({ machine: s.machine, path: s.path }) },
    { label: 'Copy session name', onSelect: () => copy(s.tmux!, 'the session name') },
    'separator',
    { label: 'Stop', danger: true, onSelect: () => stop(s) }
  ]

  const ctx: Ctx | null = state ? { state, agentLabel, focusedId, open, menu: sessionMenu, merge, setup: setSetupRun } : null

  const startAndOpen = async (body: Record<string, unknown>) => {
    const res = await api('POST', '/sessions', { ...body, wait: true })
    if (res.setup && !res.setup.ok) toast.warning(`${setupNote(res.setup)}. The agent started anyway; its row shows the output.`)
    onOpenSession(String(body.machine), res.name)
  }

  const acts: Acts = {
    newSession: (machine, path) => {
      if (!state?.machines.some((m) => m.up)) return void toast.error('No machine is connected right now')
      onNewSession(machine || sel || undefined, path)
    },
    shell: async (machine) => {
      const key = await openShell(machine)
      if (key) onOpenSession(machine, key.slice(machine.length + 1))
    },
    machineMenu: (m) => [
      { label: 'Machine settings', icon: Settings2, onSelect: () => follow(`/settings#machine-${m.name}`) },
      !m.local && {
        label: 'Copy ssh command',
        onSelect: async () => {
          if (!sshHosts.current) {
            try {
              const d = await api('GET', '/api/settings')
              sshHosts.current = Object.fromEntries(d.machines.map((x: any) => [x.name, x.ssh || x.name]))
            } catch {}
          }
          copy(`ssh ${sshHosts.current?.[m.name] || m.name}`, 'the ssh command')
        }
      },
      !m.local && 'separator',
      !m.local && {
        label: 'Remove machine…',
        danger: true,
        onSelect: async () => {
          if (!(await confirmAction({ title: `Remove ${m.name} from Yardbell?`, body: 'Its sessions keep running. Yardbell stops watching it and closes its tunnels.', confirm: 'Remove', danger: true }))) return
          run(async () => {
            const res = await api('POST', `/machines/${enc(m.name)}/remove`)
            if (res.ok === false) throw new Error(res.message)
            toast(`Removed ${m.name}`)
            if (sel === m.name) pick('')
          })
        }
      }
    ],
    moveToTmux: async (s) => {
      const warn = s.activity === 'active' ? 'It is working right now and will be interrupted. ' : ''
      const ok = await confirmAction({
        title: `Move ${short(s.folder)} on ${s.machine} into tmux?`,
        body: `${warn}Yardbell stops ${agentLabel(s.agent)} and starts it again in tmux with its last conversation. The terminal it runs in now gets its prompt back.`,
        confirm: 'Move to tmux'
      })
      if (!ok) return
      run(async () => {
        const res = await api('POST', `/sessions/${enc(s.machine)}/${enc(String(s.pid))}/move-to-tmux`)
        toast(`Moved ${short(s.folder)} into tmux`)
        onOpenSession(s.machine, res.name)
      })
    },
    stopPid: async (s) => {
      const warn = s.activity === 'active' ? 'It is working right now and will be interrupted. ' : ''
      const ok = await confirmAction({
        title: `Stop ${agentLabel(s.agent)} in ${short(s.folder)} on ${s.machine}?`,
        body: `${warn}The agent ends and the terminal it runs in gets its prompt back. Its conversation is kept, so Resume can continue it.`,
        confirm: 'Stop',
        danger: true
      })
      if (!ok) return
      run(async () => {
        await api('POST', `/sessions/${enc(s.machine)}/${enc(String(s.pid))}/stop-process`)
        leave(s.id)
        toast(`Stopped ${agentLabel(s.agent)} in ${short(s.folder)}`)
      })
    },
    resume: (e) => run(() => startAndOpen({ machine: e.machine, ...(e.path ? { path: e.path } : { folder: e.folder }), resume: true, agent: e.agent })),
    removeWorktree: (machine, path) => setRemoving({ machine, path }),
    insights,
    forget: (e) => run(() => api('POST', `/ended/${enc(e.id)}/forget`))
  }

  const refresh = async () => {
    setChecking(true)
    await run(() => api('POST', '/refresh'))
    setChecking(false)
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target.closest('input, select, textarea, [role="dialog"], [role="menu"], dialog[open]') || document.querySelector('[role="dialog"]')) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'n') {
        e.preventDefault()
        acts.newSession()
        return
      }
      if (!['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [])]
      if (!rows.length) return
      if (e.key === 'Enter') {
        const s = state?.sessions.find((x) => x.id === focusedId)
        if (s && target.closest('[data-id]')) {
          e.preventDefault()
          layout === 'board' ? setPreview(s) : open(s)
        }
        return
      }
      e.preventDefault()
      const step = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1
      let i = rows.findIndex((r) => r.dataset.id === focusedId)
      i = i < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(Math.max(i + step, 0), rows.length - 1)
      const row = rows[i]
      setFocusedId(row.dataset.id!)
      ;(row.matches('[tabindex]') ? row : row.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })

  const secs = updated ? Math.max(0, Math.round((Date.now() - updated) / 1000)) : null
  const updatedText = live ? 'Live' : secs === null ? '' : secs < 3 ? 'Updated just now' : `Updated ${secs}s ago`
  const selectedMachine = machines.find((m) => m.name === sel)
  const problems = state?.problems || []
  const mesh = state?.mesh

  let view: React.ReactNode
  if (!state || !ctx) {
    view = <p className="p-6 text-sm text-muted-foreground">Checking machines…</p>
  } else if (!machines.length) {
    view = (
      <div className="grid place-items-center gap-3 p-10 text-center text-sm text-muted-foreground">
        <p>No machines yet. Add one to see its agent sessions here.</p>
        <Button onClick={() => follow('/settings?add=1#machines')}>Add machine</Button>
      </div>
    )
  } else if (layout === 'board' && (visible.length || !filtering)) {
    const staleHidden = visible.filter((s) => s.stale).length
    view = (
      <>
        <Board machines={shownMachines} visible={visible.filter((s) => !s.stale)} ctx={ctx} showIdle={showIdle} onPreview={setPreview} />
        {staleHidden > 0 && (
          <p className="shrink-0 px-3 pb-3 text-center text-[11px] text-muted-foreground md:px-5">
            {staleHidden === 1 ? '1 session' : `${staleHidden} sessions`} on unreachable machines left out. They come back when their machine reconnects.
          </p>
        )}
      </>
    )
  } else {
    const groups = layout === 'board' ? [] : shownMachines.map((m) => <MachineGroup key={m.name} m={m} ctx={ctx} acts={acts} filtering={filtering} matches={matches} matchesEnded={matchesEnded} />)
    const any = layout !== 'board' && shownMachines.some((m) => {
      const mine = state.sessions.filter((s) => s.machine === m.name)
      return !filtering || mine.some(matches) || (state.ended || []).some((e) => e.machine === m.name && matchesEnded(e))
    })
    view = any ? (
      <div className="mx-auto grid w-full max-w-[1280px] gap-3 p-3 md:px-5">{groups}</div>
    ) : (
      <div className="grid place-items-center gap-3 p-10 text-center text-sm text-muted-foreground">
        <p>No sessions match{q ? ` "${query.trim()}"` : ''}.</p>
        <Button
          variant="outline"
          onClick={() => {
            setQuery('')
            setStatus('all')
            setFilters({ projects: [], reviews: [] })
          }}
        >
          Clear filters
        </Button>
      </div>
    )
  }

  const chip = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors'
  const seg = (on: boolean) => cn('inline-flex h-6 items-center gap-1 rounded-[5px] px-2 text-[12px]', on ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3 md:px-5">
        <h1 className="truncate text-[15px] font-semibold">{selectedMachine ? selectedMachine.name : 'Sessions'}</h1>
        <span className="text-[11px] text-muted-foreground tabular-nums">{counts.all} total</span>
        {updatedText && (
          <span aria-live="polite" className={cn('rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground', !live && secs !== null && secs > 15 && 'border-amber-500/40 text-amber-700 dark:text-amber-400')}>
            {updatedText}
          </span>
        )}
        <span className="flex-1" />
        <Hint label="Check machines now">
          <Button variant="ghost" size="icon-sm" aria-label="Check machines now" disabled={checking} onClick={refresh}>
            <RefreshCw className={cn(checking && 'animate-spin')} />
          </Button>
        </Hint>
        <Button variant="outline" size="sm" className="hidden md:inline-flex" onClick={() => follow('/settings?add=1#machines')}>
          Add machine
        </Button>
        <Button size="sm" onClick={() => acts.newSession()}>
          <Plus /> New session
        </Button>
      </header>

      <nav aria-label="Machines" className="scrollbar-none flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2 md:px-5">
        <button type="button" aria-pressed={!sel} onClick={() => pick('')} className={cn(chip, !sel ? 'border-foreground/25 bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
          All machines
        </button>
        {machines.map((m) => (
          <button
            key={m.name}
            type="button"
            aria-pressed={sel === m.name}
            onClick={() => pick(m.name)}
            className={cn(chip, sel === m.name ? 'border-foreground/25 bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}
          >
            <Dot t={tone(m)} title={toneWord(m)} />
            {m.name}
          </button>
        ))}
        <button type="button" onClick={() => follow('/settings?add=1#machines')} className={cn(chip, 'border-dashed border-border text-muted-foreground hover:text-foreground')}>
          <Plus className="size-3" /> Add machine
        </button>
      </nav>

      <div role="search" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 md:px-5">
        <div role="group" aria-label="Show sessions" className="inline-flex rounded-md bg-muted p-0.5">
          {(['all', 'needs', 'active', 'idle'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)} className={seg(status === k)}>
              {k === 'all' ? 'All' : k === 'needs' ? 'Needs you' : k === 'active' ? 'Working' : 'Idle'}
              <span className={cn('text-[10.5px] tabular-nums', k === 'needs' && counts.needs ? 'font-semibold text-agent-question-text' : 'text-muted-foreground')}>{counts[k]}</span>
            </button>
          ))}
        </div>
        <div role="group" aria-label="Lay out sessions" className="inline-flex rounded-md bg-muted p-0.5">
          <button type="button" aria-pressed={layout === 'machines'} title="Sessions grouped by machine" onClick={() => (setLayout('machines'), remember(VIEW_KEY, 'machines'))} className={seg(layout === 'machines')}>
            <LayoutList className="size-3.5" /> Machines
          </button>
          <button type="button" aria-pressed={layout === 'board'} title="Sessions from every machine in lanes, by what they need next" onClick={() => (setLayout('board'), remember(VIEW_KEY, 'board'))} className={seg(layout === 'board')}>
            <Columns3 className="size-3.5" /> Board
          </button>
        </div>
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              setQuery('')
              e.currentTarget.blur()
            }}
            placeholder="Search folder, branch, ticket or agent…"
            aria-label="Search sessions by folder, branch, ticket or agent"
            autoComplete="off"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-input bg-muted/55 pr-8 pl-7 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {query ? (
            <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground">
              <X className="size-3" />
            </Button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-border px-1 font-mono text-[9px] text-muted-foreground">/</kbd>
          )}
        </div>
        {filtering && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {visible.length} of {listed.length} shown
          </span>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" className={cn('h-7 gap-1.5 px-2 text-xs', activeFilters > 0 && 'border-foreground/25')}>
              <Filter className="size-3" /> Filter
              {activeFilters > 0 && <span className="rounded-full bg-foreground px-1.5 py-px text-[10px] leading-none text-background">{activeFilters}</span>}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
            <DropdownMenuLabel>Project</DropdownMenuLabel>
            {projectOptions.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No open sessions</p>}
            {projectOptions.map(([name, n]) => (
              <Check key={name} on={filters.projects.includes(name)} onToggle={() => setFilters((f) => ({ ...f, projects: toggled(f.projects, name) }))} label={name} count={n} />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Pull request</DropdownMenuLabel>
            {REVIEWS.map((r) => (
              <Check key={r.id} on={filters.reviews.includes(r.id)} onToggle={() => setFilters((f) => ({ ...f, reviews: toggled(f.reviews, r.id) }))} label={r.label} count={reviewCount(r.id)} />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={activeFilters === 0} onSelect={() => setFilters({ projects: [], reviews: [] })} className="text-muted-foreground">
              <X className="size-3.5" /> Clear all filters
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {layout === 'board' && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Board settings" title="Board settings">
                <Settings2 />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Board</DropdownMenuLabel>
              <Check
                on={showIdle}
                onToggle={() => {
                  setShowIdle(!showIdle)
                  remember(IDLE_KEY, showIdle ? '0' : '1')
                }}
                label="Show the Idle lane"
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {activeFilters > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-2 md:px-5">
          <span className="mr-0.5 text-[10px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Filters</span>
          {filters.projects.map((p) => (
            <ActiveChip key={`p:${p}`} label={p} onRemove={() => setFilters((f) => ({ ...f, projects: toggled(f.projects, p) }))} />
          ))}
          {filters.reviews.map((r) => (
            <ActiveChip key={`r:${r}`} label={`PR: ${REVIEWS.find((x) => x.id === r)?.label}`} onRemove={() => setFilters((f) => ({ ...f, reviews: toggled(f.reviews, r) }))} />
          ))}
          <Button variant="link" size="xs" onClick={() => setFilters({ projects: [], reviews: [] })} className="h-[22px] px-1 text-[11px] text-muted-foreground">
            Clear
          </Button>
        </div>
      )}

      <div ref={listRef} className={cn('flex min-h-0 flex-1 flex-col', layout === 'board' && (visible.length || !filtering) ? '' : 'scrollbar-sleek overflow-y-auto')}>
        {offline && (
          <Banner tone="warn">
            <strong className="font-semibold">Yardbell is not responding.</strong> <span className="text-muted-foreground">Showing the last data received. Retrying every 5 seconds.</span>
          </Banner>
        )}
        {mesh && mesh.on === false && (
          <Banner tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong className="font-semibold">{mesh.label} is off on this machine.</strong>{' '}
                <span className="text-muted-foreground">Other machines and your phone cannot reach Yardbell or its tunnels. {mesh.hint || ''}</span>
              </div>
              {mesh.can_turn_on && (
                <Button
                  size="sm"
                  onClick={() =>
                    run(async () => {
                      const res = await api('POST', '/mesh/on')
                      toast(res.message)
                    })
                  }
                >
                  Turn on {mesh.label}
                </Button>
              )}
            </div>
          </Banner>
        )}
        {problems.length > 0 && <Stuck problems={problems} />}
        {view}
        {layout === 'machines' && state && (
          <p aria-hidden className="hidden pb-4 text-center text-[11px] text-muted-foreground md:block">
            <Kbd>/</Kbd> search · <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>n</Kbd> new session
          </p>
        )}
      </div>

      {ctx && <Preview s={preview} ctx={ctx} onClose={() => setPreview(null)} onOpen={open} />}
      <MoveDialog session={moving} state={state} onClose={() => setMoving(null)} onOpen={onOpenSession} onLeave={leave} />
      <RemoveWorktreeDialog target={removing} onClose={() => setRemoving(null)} />
      <SetupDialog run={setupRun} onClose={() => setSetupRun(null)} />
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border px-1 font-mono text-[10px]">{children}</kbd>
}

function Check({ on, onToggle, label, count }: { on: boolean; onToggle: () => void; label: string; count?: number }) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault()
        later(onToggle)
      }}
      role="menuitemcheckbox"
      aria-checked={on}
    >
      <span className={cn('grid size-3.5 place-items-center rounded-[3px] border', on ? 'border-foreground bg-foreground text-background' : 'border-border')}>
        {on && (
          <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
            <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        )}
      </span>
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{count}</span>}
    </DropdownMenuItem>
  )
}

function ActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border bg-muted/55 pr-1 pl-2 text-[11px]">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label} filter`} className="rounded-full text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </span>
  )
}
