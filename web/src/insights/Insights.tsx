/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { FlaskConical, GitPullRequest, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { describe as pullDetails, noun, pullStatus, ref } from '@/dashboard/model'

type Request = { machine: string; name: string; onSuggest?: (data: any) => void }

let current: Request | null = null
const listeners = new Set<() => void>()
export function openInsights(r: Request) {
  current = r
  listeners.forEach((l) => l())
}
const close = () => openInsights(null as never)

const SHOWN = 80
const STATES = ['working', 'waiting', 'idle'] as const
const WORDS: Record<string, string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle' }
const DOT: Record<string, string> = { working: 'bg-emerald-500', waiting: 'bg-amber-500', idle: 'bg-muted-foreground/50' }
const SEG: Record<string, string> = { working: 'bg-emerald-500/80', waiting: 'bg-amber-500/80', idle: 'bg-muted-foreground/25' }
const MEANS: Record<string, string> = {
  working: 'The agent was busy: thinking, editing files or running commands.',
  waiting: 'It stopped at a question or a permission prompt until you answered.',
  idle: 'Nothing was happening, usually because it had finished and was at its prompt.'
}
const NOW: Record<string, string> = { active: 'working now', blocked: 'waiting for you now', idle: 'idle now' }
const TONE: Record<string, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  pending: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  done: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  '': 'border-border bg-muted/60 text-muted-foreground'
}
const pill = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] whitespace-nowrap'

function duration(secs: number) {
  const mins = Math.floor(secs / 60)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`
}
const amount = (secs: number) => (!secs ? '0 min' : secs < 60 ? '<1 min' : duration(secs))
function hour(stamp: string) {
  const d = new Date(stamp)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function clock(stamp: string) {
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return ''
  return d.toDateString() === new Date().toDateString() ? hour(stamp) : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${hour(stamp)}`
}
function day(stamp: string) {
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
const times = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Whole percentages that add up to 100, so the three shares never read as 101%.
function shares(values: number[]) {
  const total = values.reduce((a, b) => a + b, 0)
  if (!total) return values.map(() => 0)
  const raw = values.map((v) => (v * 100) / total)
  const out = raw.map(Math.floor)
  const left = 100 - out.reduce((a, b) => a + b, 0)
  raw
    .map((v, i) => [v - out[i], i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, left)
    .forEach(([, i]) => out[i]++)
  return out
}

function Heading({ title, note }: { title: string; note?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {note && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{note}</p>}
    </div>
  )
}

function Line({ who, text, warn }: { who: string; text?: string; warn?: boolean }) {
  if (!text) return null
  return (
    <p className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs">
      <span className={cn('font-medium', warn ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{who}</span>
      <span className="line-clamp-6 whitespace-pre-wrap break-words">{text}</span>
    </p>
  )
}

function Part({ part }: { part: any }) {
  if (!part) return null
  const said = part.asked?.length || part.question || part.stopped_at || part.summary || part.said
  if (!said) return null
  const total = (part.did?.length || 0) + (part.more || 0)
  return (
    <div className="mt-1.5 grid gap-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      {(part.asked || []).map((t: string, i: number) => (
        <Line key={i} who="You said" text={t} />
      ))}
      <Line who="It asked" text={part.question} warn />
      <Line who="Stopped at" text={part.stopped_at} warn />
      <Line who="Did" text={part.summary} />
      <Line who="It said" text={part.said} />
      {total > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show {times(total, 'step')}</summary>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted-foreground">
            {part.more > 0 && <li className="list-none italic">{times(part.more, 'older step')} not shown.</li>}
            {part.did.map((a: any, i: number) => (
              <li key={i}>{a.what}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

function Run({ r, at }: { r: any; at: string }) {
  const Icon = r.kind === 'pull' ? GitPullRequest : r.kind === 'test' ? FlaskConical : SquareTerminal
  return (
    <li className="relative grid grid-cols-[3.5rem_1rem_minmax(0,1fr)_auto] items-start gap-2 py-1 text-xs">
      <span className="text-muted-foreground tabular-nums">{at}</span>
      <span className="relative z-10 grid size-4 place-items-center rounded bg-background text-muted-foreground">
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 truncate">
        {r.kind === 'pull' ? (
          r.url ? (
            <a href={r.url} target="_blank" rel="noopener" className="hover:underline">
              {r.text}
            </a>
          ) : (
            r.text
          )
        ) : (
          <code className="font-mono text-[11.5px]">{r.text}</code>
        )}
      </span>
      {r.ok === true && <span className={cn(pill, TONE.ok)}>Passed</span>}
      {r.ok === false && <span className={cn(pill, TONE.bad)}>Failed</span>}
    </li>
  )
}

function Body({ data, all, onAll }: { data: any; all: boolean; onAll: () => void }) {
  const t = data.timeline
  const w = data.work
  const about = w?.title || (data.task ? '' : w?.first_prompt)
  const facts: [string, string][] = (
    [
      t && [t.started ? 'Started' : 'Watched since', clock(t.since)],
      t?.ended && ['Ended', clock(t.ended)],
      ['Machine', data.machine],
      t?.folder && ['Folder', t.folder],
      t?.branch && ['Branch', t.branch],
      t?.agent && ['Agent', t.agent]
    ] as ([string, string] | false | undefined)[]
  ).filter(Boolean) as [string, string][]
  const p = data.pull

  const told = data.parts?.periods.some((part: any) => part.did.length)
  const items: { at: string; node: React.ReactNode }[] = t
    ? [
        ...t.periods.map((per: any, i: number) => ({
          at: per.from,
          node: (
            <li key={`p${i}`} className="relative grid grid-cols-[3.5rem_1rem_minmax(0,1fr)] gap-2 py-1.5">
              <span className="pt-px text-xs text-muted-foreground tabular-nums">{hour(per.from)}</span>
              <span className="relative z-10 grid size-4 place-items-center">
                <span className={cn('size-2.5 rounded-full ring-4 ring-background', DOT[per.state])} />
              </span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="font-medium">{WORDS[per.state]}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{per.to ? `for ${duration(per.seconds)}` : `${duration(per.seconds)} so far`}</span>
                </div>
                <Part part={data.parts?.periods[i]} />
              </div>
            </li>
          )
        })),
        ...t.runs
          .filter((r: any) => !(told && r.kind === 'tool'))
          .map((r: any, i: number) => ({ at: r.at, node: <Run key={`r${i}`} r={r} at={hour(r.at)} /> }))
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : []
  if (t?.ended)
    items.push({
      at: t.ended,
      node: (
        <li key="ended" className="relative grid grid-cols-[3.5rem_1rem_minmax(0,1fr)] gap-2 py-1.5 text-[13px]">
          <span className="text-xs text-muted-foreground tabular-nums">{hour(t.ended)}</span>
          <span className="relative z-10 grid size-4 place-items-center">
            <span className="size-2.5 rounded-full bg-foreground ring-4 ring-background" />
          </span>
          <span className="font-medium">Ended</span>
        </li>
      )
    })
  const hidden = all ? 0 : Math.max(0, items.length - SHOWN)
  let last = ''
  const shown = items.slice(hidden).flatMap((i, n) => {
    const d = day(i.at)
    const head =
      d && d !== last ? (
        <li key={`d${n}`} className="relative z-10 py-1.5 pl-[4.5rem]">
          <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{d}</span>
        </li>
      ) : null
    last = d
    return head ? [head, i.node] : [i.node]
  })
  const warn = [w?.shared ? 'Another session runs in this folder, so the detail may be from that session.' : '', w?.partial ? 'This is a long session, so older stretches may have no detail.' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className="grid gap-7">
      {about && <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[13px]">{about}</p>}
      <div className="grid gap-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">{k}</dt>
              <dd className="truncate text-[13px]" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        {p && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-[13px]">
            <GitPullRequest className="size-3.5 text-muted-foreground" aria-label={noun(p)} />
            <a href={p.url} target="_blank" rel="noopener" className="min-w-0 truncate hover:underline" title={pullDetails(p)}>
              <span className="text-muted-foreground tabular-nums">{ref(p)}</span> {p.title}
            </a>
            <span className={cn(pill, TONE[pullStatus(p).tone])}>{pullStatus(p).word}</span>
          </div>
        )}
        {t && !t.started && <p className="text-xs text-muted-foreground">It was already running when Yardbell started watching it, so the figures below start at {clock(t.since)}.</p>}
      </div>

      {t ? (
        <>
          <section>
            <Spent t={t} />
          </section>
          {items.length > 0 && (
            <section>
              <Heading
                title="Timeline"
                note={
                  <>
                    {told
                      ? "What happened in each stretch of working, waiting and idle, from this session's transcript, with each test run"
                      : 'Each change between working, waiting and idle with how long it lasted, and each tool call and test run Yardbell saw'}
                    {t.runs.some((r: any) => r.kind === 'pull') ? ', and what happened to its pull request or merge request' : ''}, oldest first.{warn ? ` ${warn}` : ''}
                  </>
                }
              />
              <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-[calc(3.5rem+0.5rem+0.5rem-0.5px)] before:w-px before:bg-border">
                {t.dropped > 0 && <li className="py-1 pl-[4.5rem] text-xs text-muted-foreground">{times(t.dropped, 'older change')} no longer kept.</li>}
                {hidden > 0 && (
                  <li className="py-1 pl-[4.5rem]">
                    <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onAll}>
                      Show {hidden} earlier
                    </Button>
                  </li>
                )}
                {!hidden && data.parts?.before && (
                  <li className="relative grid grid-cols-[3.5rem_1rem_minmax(0,1fr)] gap-2 py-1.5">
                    <span />
                    <span className="relative z-10 grid size-4 place-items-center">
                      <span className="size-2.5 rounded-full border border-border bg-background" />
                    </span>
                    <div>
                      <span className="text-[13px] font-medium">Before Yardbell was watching</span>
                      <Part part={data.parts.before} />
                    </div>
                  </li>
                )}
                {shown}
              </ol>
            </section>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] font-medium">Nothing recorded yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Yardbell builds this timeline from its regular checks of {data.machine}. It has not checked this session since it appeared, so the first entries come with the next check. Open
            Insights again in a moment.
          </p>
        </div>
      )}

      {w?.screen && (
        <section>
          <Heading title="End of its terminal" note="Yardbell can only read what happened in each stretch from Claude Code's sessions." />
          <pre className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[12px] whitespace-pre-wrap">{w.screen}</pre>
        </section>
      )}
      {data.scrollback_error && <p className="text-xs text-muted-foreground">Could not read the scrollback: {data.scrollback_error}</p>}
      {data.earlier?.length > 0 && (
        <section>
          <Heading title="Earlier, from the scrollback" note="Tool calls and test runs on the screen from before Yardbell recorded them, oldest first. Their times are not known." />
          <ol>
            {data.earlier.map((r: any, i: number) => (
              <Run key={i} r={r} at="" />
            ))}
          </ol>
        </section>
      )}
      {(data.task || data.from) && (
        <section>
          {data.task && (
            <>
              <Heading title="Task" note="The prompt this session started with." />
              <pre className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[12px] whitespace-pre-wrap">{data.task}</pre>
            </>
          )}
          {data.from && (
            <p className="mt-2 text-xs text-muted-foreground">
              From the task <strong className="font-medium text-foreground">{data.from.name}</strong>, version {data.from.version}
              {data.from.current !== data.from.version ? `. It is at version ${data.from.current} now` : ''}.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

function Spent({ t }: { t: any }) {
  const secs = STATES.map((s) => t.totals[s] || 0)
  const total = secs.reduce((a, b) => a + b, 0)
  const pct = shares(secs)
  const waits = t.periods.filter((p: any) => p.state === 'waiting').length
  const tests = t.runs.filter((r: any) => r.ok !== undefined)
  const failed = tests.filter((r: any) => r.ok === false).length
  const all = duration(total)
  const barTotal = t.periods.reduce((n: number, p: any) => n + p.seconds, 0)
  return (
    <>
      <Heading
        title="Time spent"
        note={`${total ? `${all[0].toUpperCase()}${all.slice(1)} in all, from ${clock(t.since)} to ${t.ended ? clock(t.ended) : 'now'}. ` : ''}How long the session spent in each state Yardbell tracks.`}
      />
      {barTotal > 0 && (
        <div className="mb-3">
          <div className="flex h-2.5 gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
            {t.periods.map((p: any, i: number) => (
              <span key={i} className={SEG[p.state]} style={{ flexGrow: Math.max(p.seconds, barTotal / 400) }} title={`${WORDS[p.state]}, ${duration(p.seconds)} from ${clock(p.from)}`} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>{clock(t.periods[0].from)}</span>
            <span>{t.ended ? clock(t.ended) : 'Now'}</span>
          </div>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {STATES.map((state, i) => {
          const share = secs[i] ? `${pct[i] || 'under 1'}% of the time` : ''
          const count = state === 'waiting' ? (waits ? times(waits, 'time') : 'Never waited') : ''
          const sub = [count, share].filter(Boolean).join(', ')
          return (
            <div key={state} title={MEANS[state]} className="rounded-lg border border-border/60 bg-card p-3">
              <dt className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <span className={cn('size-2 rounded-full', DOT[state])} />
                {WORDS[state]}
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{amount(secs[i])}</dd>
              {sub && <dd className="text-[11px] text-muted-foreground">{sub}</dd>}
            </div>
          )
        })}
        <div
          title={tests.length ? 'Summaries a test runner printed on the screen.' : "No test runner's summary showed on the screen, such as one from cargo test, npm test or pytest."}
          className="rounded-lg border border-border/60 bg-card p-3"
        >
          <dt className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <FlaskConical className="size-3" /> Test results
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{tests.length ? times(tests.length, 'run') : 'None'}</dd>
          {tests.length > 0 && (
            <dd className="text-[11px] text-muted-foreground">
              {tests.length - failed} passed, {failed ? <b className="font-medium text-destructive">{failed} failed</b> : '0 failed'}
            </dd>
          )}
        </div>
      </dl>
    </>
  )
}

export function InsightsHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [all, setAll] = useState(false)

  useEffect(() => {
    setData(null)
    setError('')
    setAll(false)
    if (!req) return
    let gone = false
    fetch(`/sessions/${encodeURIComponent(req.machine)}/${encodeURIComponent(req.name)}/insights`, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 401) {
          location.href = '/login'
          throw new Error('Log in again')
        }
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`)
        return d
      })
      .then(
        (d) => !gone && setData(d),
        (e) => !gone && setError(e.message)
      )
    return () => {
      gone = true
    }
  }, [req])

  if (!req) return null
  const t = data?.timeline
  const status = !data ? '' : t?.ended ? 'Ended' : data.live ? (NOW[data.activity] ? `Running, ${NOW[data.activity]}` : 'Running') : 'No longer running'
  const statusTone = !data ? '' : t?.ended || !data.live ? '' : data.activity === 'active' ? 'ok' : data.activity === 'blocked' ? 'warn' : ''

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[min(88dvh,900px)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium tracking-[0.05em] text-muted-foreground uppercase">Insights</p>
            <DialogTitle className="truncate text-base">{req.name}</DialogTitle>
            <DialogDescription className="text-xs">{data ? `What Yardbell saw of this session on ${req.machine} while it watched it.` : `Reading ${req.name} on ${req.machine}…`}</DialogDescription>
          </div>
          {status && <span className={cn(pill, TONE[statusTone], 'mt-1')}>{status}</span>}
        </header>
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : !data ? (
            <div className="grid gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />
              ))}
            </div>
          ) : (
            <Body data={data} all={all} onAll={() => setAll(true)} />
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          {data && <p className="mr-auto text-xs text-muted-foreground">Asks Dispatch to read this session and propose a clearer prompt for next time.</p>}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={close}>
            Close
          </Button>
          {data && req.onSuggest && (
            <Button
              size="sm"
              autoFocus
              onClick={() => {
                const s = req.onSuggest!
                close()
                s(data)
              }}
            >
              Suggest a better prompt
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
