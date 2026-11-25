import { useEffect, useState } from 'react'
import { AlertCircle, Check, ChevronLeft, ExternalLink, Loader2, MessageSquare, MoreHorizontal, Server, Square, Trash2, X } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { later } from '@/components/ui/menu-items'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { Markdown } from '@/lib/markdown'
import { PipelineCanvas } from './Canvas'
import {
  ANSWERABLE,
  api,
  asksForYou,
  clock,
  ENDED,
  KINDS,
  nameOf,
  nodeState,
  runLabel,
  silentPass,
  stateWord,
  SUBJECTLESS,
  tokens,
  took,
  WORDS,
  type Definition,
  type PipelinesData,
  type Run,
  type Step
} from './model'

export type RunActions = {
  busy: boolean
  act: (run: Run, what: string, body?: unknown) => void
  removeRun: (run: Run) => void
  clearRuns: () => void
  stopSession: (run: Run, t: NonNullable<Run['terminals']>[number]) => void
}

const help = 'text-xs leading-relaxed text-muted-foreground'
const head = 'text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase'
const TERMINAL_KEY = 'yb-pipeline-terminal'

export function RunDot({ run }: { run: Run }) {
  const tone = asksForYou(run) ? 'wait' : run.state === 'done' ? 'ok' : run.state === 'dropped' ? 'off' : 'run'
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'wait' && 'bg-status-warning',
        tone === 'ok' && 'bg-status-success',
        tone === 'run' && 'animate-pulse bg-foreground motion-reduce:animate-none',
        tone === 'off' && 'border-[1.5px] border-muted-foreground'
      )}
    />
  )
}

function TokenUse({ run }: { run: Run }) {
  const t = run.tokens || {}
  const used = run.tokens_used || 0
  const unknown = Object.values(t.unknown || {})
  if (!used && !unknown.length && !t.limit) return null
  const passed = Boolean(t.limit && used >= t.limit)
  const total = used ? `${unknown.length ? 'At least ' : ''}${tokens(used)} tokens` : unknown.length ? 'Not known' : '0 tokens'
  const pct = t.limit ? Math.min(100, (used * 100) / t.limit) : 0
  return (
    <div className="grid gap-1.5 rounded-lg border border-border p-2.5">
      <p className="flex justify-between text-xs">
        <span>
          <b className="font-semibold">{total}</b> used
        </span>
        <span className="text-muted-foreground">{t.limit ? `Limit ${tokens(t.limit)}` : 'No limit'}</span>
      </p>
      {Boolean(t.limit) && (
        <div role="img" aria-label={`${Math.round(pct)}% of the limit`} className="h-1.5 overflow-hidden rounded-full bg-muted">
          <span className={cn('block h-full rounded-full', passed ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-600 dark:bg-yellow-500' : 'bg-emerald-600 dark:bg-emerald-500')} style={{ width: `${pct}%` }} />
        </div>
      )}
      {passed && ['running', 'queued'].includes(run.state) && <p className="text-[11px] text-status-warning-text">Past its limit. This step finishes, and the next step that uses tokens waits for you.</p>}
      {unknown.map((why) => (
        <p key={why} className="text-[11px] text-status-warning-text">
          {why}, so the real total may be higher.
        </p>
      ))}
      {Boolean(run.tokens_from_cache) && <p className={help}>{tokens(run.tokens_from_cache)} more were read from cache and are not counted.</p>}
    </div>
  )
}

function NeedBox({ run, d, a }: { run: Run; d: Definition; a: RunActions }) {
  const [text, setText] = useState('')
  const [raise, setRaise] = useState('')
  const w = run.waiting || { kind: '', step: '' }
  const tokenWait = w.kind === 'token_limit' || w.kind === 'token_unknown'
  const answerable = ANSWERABLE.includes(w.kind)
  const open = (run.questions || []).filter((q) => !q.answer)
  const step = d.steps.find((s) => s.id === w.step)
  const command = step?.kind === 'command'
  const ran = run.steps?.[w.step]?.ran
  const didRun = Boolean(ran) && ran!.command === step?.command && step?.approved === step?.command
  return (
    <div className="grid gap-2 rounded-lg border border-status-warning/50 bg-status-warning/8 p-3" id="pl-need">
      <p className="text-[13px]">
        {(w.reason || '').startsWith(nameOf(d, w.step)) ? (
          <b className="font-semibold">{w.reason}</b>
        ) : (
          <>
            <b className="font-semibold">{nameOf(d, w.step)}</b> · {w.reason}
          </>
        )}
      </p>
      {w.kind === 'questions' && open.length > 0 && (
        <ol className="list-decimal pl-5 text-[13px]">
          {open.map((q) => (
            <li key={q.asked}>{q.asked}</li>
          ))}
        </ol>
      )}
      {w.kind === 'no_result' && <p className={help}>The agent went quiet and Yardbell could not read a result from it. Show the terminal to see what it did, then retry the step, continue on pass or fail, or answer it.</p>}
      {w.kind === 'unchanged' && <p className={help}>Yardbell did not start this step and did not reuse its last verdict. Run it again to read the same code, or continue on pass or fail to take that line yourself.</p>}
      {w.kind === 'token_limit' && (
        <>
          <p className={help}>This step uses tokens and was not started. Raise the limit to go on, or start this one step and the run waits again after it.</p>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              a.act(run, 'token-limit', { limit: Number(raise) })
              setRaise('')
            }}
          >
            <label className="grid flex-1 gap-1 text-xs">
              <span className="text-muted-foreground">New limit for this run</span>
              <input
                type="number"
                min={1}
                value={raise}
                placeholder={tokens((run.tokens_used || 0) * 2 || 1000)}
                onChange={(e) => setRaise(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={a.busy || !Number(raise)}>
              Raise the limit
            </Button>
          </form>
        </>
      )}
      {w.kind === 'token_unknown' && <p className={help}>Starting it anyway leaves its use out of the total, and the run does not ask again.</p>}
      {w.screen && <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">{w.screen}</pre>}
      {command && !didRun && <p className={help}>This command has not run in this attempt, so the step cannot continue on pass.</p>}
      {command && didRun && !ran!.passed && <p className={help}>This command failed. If you continue on pass, the run records that you overrode it.</p>}
      {answerable && (
        <textarea
          aria-label="Your answer"
          rows={3}
          value={text}
          placeholder="Your answer"
          onChange={(e) => setText(e.target.value)}
          className="resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost-destructive" disabled={a.busy} onClick={() => a.act(run, 'drop')}>
          Drop
        </Button>
        {w.kind === 'tool_changed' ? (
          <Button size="sm" disabled={a.busy} onClick={() => a.act(run, 'accept-tool')}>
            Accept and run
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={a.busy} onClick={() => a.act(run, 'retry')}>
            {tokenWait ? 'Start this step anyway' : w.kind === 'unchanged' ? 'Run it again' : 'Retry step'}
          </Button>
        )}
        {!tokenWait && (
          <>
            <Button size="sm" variant="outline" disabled={a.busy} onClick={() => a.act(run, 'continue', { outcome: 'fail' })}>
              Continue on fail
            </Button>
            {!(command && !didRun) && (
              <Button size="sm" variant="outline" disabled={a.busy} onClick={() => a.act(run, 'continue', { outcome: 'pass' })}>
                Continue on pass
              </Button>
            )}
          </>
        )}
        {answerable && (
          <Button
            size="sm"
            disabled={a.busy || !text.trim()}
            onClick={() => {
              a.act(run, 'answer', { text })
              setText('')
            }}
          >
            Send answer
          </Button>
        )}
      </div>
    </div>
  )
}

function HeldBox({ run }: { run: Run }) {
  const h = run.held!
  if (h.kind === 'spacing') return <p className={help}>{h.reason}</p>
  return (
    <div role="status" className="grid gap-1 rounded-lg border border-border bg-muted/40 p-3 text-[13px]">
      <p>
        <b className="font-semibold">Held</b> · {h.reason}
      </p>
      {h.told && (
        <p className={help}>
          Held since {clock(h.since)}. It still starts by itself. To start it sooner, free memory on {h.machine} or raise the limit in the Pipelines settings, or stop this run.
        </p>
      )}
    </div>
  )
}

function Report({ text }: { text: string }) {
  const lines = text.trim().split('\n')
  if (lines.length <= 3) return <p className="text-xs whitespace-pre-wrap text-muted-foreground">{text}</p>
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer whitespace-pre-wrap">{lines.slice(0, 2).join('\n')}</summary>
      <p className="whitespace-pre-wrap">{lines.slice(2).join('\n')}</p>
    </details>
  )
}

function entryWord(run: Run, e: NonNullable<Run['history']>[number], last: boolean) {
  if (e.outcome) return WORDS[e.outcome]
  if (last && !ENDED.includes(run.state)) return run.state === 'waiting' ? 'waiting for you' : run.state
  return 'ended without a result'
}

function RunHistory({ run, d, only }: { run: Run; d: Definition; only?: string }) {
  const rows = (run.history || []).map((e, i, all) => ({ e, last: i === all.length - 1 })).filter(({ e }) => (only ? e.step === only : true))
  if (!rows.length) return null
  return (
    <ol className="relative grid gap-0 before:absolute before:top-2 before:bottom-2 before:left-[calc(4rem+0.375rem+0.5rem-0.5px)] before:w-px before:bg-border">
      {rows.map(({ e, last }, i) => {
        const tone = e.outcome === 'fail' ? 'bg-destructive' : e.outcome === 'needs_you' ? 'bg-amber-500' : e.outcome ? 'bg-emerald-500' : e.step ? 'bg-muted-foreground/50' : 'bg-foreground'
        return (
          <li key={i} className="relative grid grid-cols-[4rem_1rem_minmax(0,1fr)] items-baseline gap-x-1.5 py-1 text-xs">
            <time className="text-muted-foreground tabular-nums">{clock(e.at)}</time>
            <span className="relative z-10 grid size-4 place-items-center self-center">
              <span className={cn('size-2 rounded-full ring-[3px] ring-card', tone)} />
            </span>
            <span className={cn('min-w-0', e.outcome === 'fail' && 'text-destructive', e.outcome === 'needs_you' && 'text-amber-700 dark:text-amber-400')}>
              {e.step ? (
                <>
                  {!only && <b className="font-medium text-foreground">{nameOf(d, e.step)} </b>}
                  {entryWord(run, e, last)}
                  {e.note && <span className="text-muted-foreground"> · {e.note}</span>}
                </>
              ) : (
                <>
                  <b className="font-medium text-foreground">Run</b> {e.note || 'started'}
                </>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h4 className="flex items-baseline gap-1.5 text-xs font-semibold">
        {title}
        {note && <span className="font-normal text-muted-foreground">{note}</span>}
      </h4>
      {children}
    </section>
  )
}

const RUN_TONE: Record<string, string> = {
  wait: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  run: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  off: 'border-border bg-muted/60 text-muted-foreground'
}
const runTone = (run: Run) => (asksForYou(run) ? 'wait' : run.state === 'done' ? 'ok' : ENDED.includes(run.state) ? 'off' : 'run')
const RUN_WORD: Record<string, string> = { wait: 'Waiting for you', ok: 'Done', run: 'Running', off: 'Ended' }

function StepMark({ mark, cls }: { mark: string; cls: string }) {
  if (mark === '✓') return <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
  if (mark === '✗') return <X className="size-3.5 text-destructive" />
  if (mark === '!') return <AlertCircle className="size-3.5 text-amber-600 dark:text-amber-400" />
  if (cls === 'now') return <Loader2 className="size-3.5 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400" />
  return <span className="size-1.5 rounded-full bg-muted-foreground/40" />
}

function Detail({ run, d, a, onPick }: { run: Run; d: Definition; a: RunActions; onPick: (id: string) => void }) {
  const s = run.subject || {}
  const ended = ENDED.includes(run.state)
  const chip = 'inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground'
  const tone = runTone(run)
  const reached = d.steps.filter((st) => run.steps?.[st.id])
  return (
    <div className="grid content-start gap-5 p-4">
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium', RUN_TONE[tone])}>
            <RunDot run={run} /> {RUN_WORD[tone]}
          </span>
          <span className="flex-1" />
          {(['queued', 'running'].includes(run.state) || ended) && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="icon-xs" variant="ghost" aria-label="More for this run">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {ended ? (
                  <DropdownMenuItem variant="destructive" disabled={a.busy} onSelect={() => later(() => a.removeRun(run))}>
                    <Trash2 /> Delete this run
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem variant="destructive" disabled={a.busy} onSelect={() => later(() => a.act(run, 'drop'))}>
                    <Square /> Stop this run
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <h3 className="text-[15px] leading-snug font-semibold">{runLabel(run)}</h3>
        <p className="text-xs text-muted-foreground">
          Started {clock(run.started)} by {run.started_by === 'you' ? 'you' : 'a trigger'} · {stateWord(run, d)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {s.ticket?.url && (
            <a href={s.ticket.url} target="_blank" rel="noopener noreferrer" className={chip}>
              {s.ticket.id} <ExternalLink className="size-3" />
            </a>
          )}
          {s.pr && (
            <a href={s.pr.url} target="_blank" rel="noopener noreferrer" className={chip}>
              {s.pr.forge === 'gitlab' ? `!${s.pr.number}` : `#${s.pr.number}`} <ExternalLink className="size-3" />
            </a>
          )}
          {run.pull && (
            <a href={run.pull.url} target="_blank" rel="noopener noreferrer" className={chip}>
              Draft #{run.pull.number} <ExternalLink className="size-3" />
            </a>
          )}
          {run.conversation && (
            <a href={`/dispatch?c=${encodeURIComponent(run.conversation)}`} className={chip}>
              <MessageSquare className="size-3" /> Conversation
            </a>
          )}
          {run.place?.machine && (
            <span className={cn(chip, 'hover:border-border hover:text-muted-foreground')}>
              <Server className="size-3" /> {[run.place.machine, run.place.branch].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      </div>
      {run.state === 'waiting' && <NeedBox run={run} d={d} a={a} />}
      {run.state === 'queued' && run.held && <HeldBox run={run} />}
      <TokenUse run={run} />
      {run.teardown_problem && (
        <p role="alert" className="text-xs text-destructive">
          {run.teardown_problem}
        </p>
      )}
      {reached.length > 0 && (
        <Section title="Steps" note={`${reached.length} of ${d.steps.length}`}>
          <ol className="relative grid before:absolute before:top-3 before:bottom-3 before:left-[10.5px] before:w-px before:bg-border">
            {reached.map((st) => {
              const state = run.steps![st.id]
              const n = nodeState(run, st)
              return (
                <li key={st.id} className="relative flex gap-2.5 rounded-md py-1.5 pr-1.5">
                  <span className="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full border border-border bg-card">
                    <StepMark mark={n.mark} cls={n.cls} />
                  </span>
                  <div className="grid min-w-0 flex-1 gap-0.5 pt-0.5">
                    <span className="flex flex-wrap items-baseline gap-x-1.5">
                      <button type="button" onClick={() => onPick(st.id)} className="text-[13px] font-medium hover:underline">
                        {st.name}
                      </button>
                      <span className={cn('text-xs', n.cls === 'failed' ? 'text-destructive' : n.cls === 'waiting' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{n.note}</span>
                    </span>
                    {state.overridden && <small className="text-xs text-amber-700 dark:text-amber-400">Passed by a person after its command failed</small>}
                    {silentPass(st, state) && <small className="text-xs text-amber-700 dark:text-amber-400">Passed without a report. Check its transcript before trusting the next step.</small>}
                    {state.pin?.head && (
                      <small className="text-xs text-muted-foreground">
                        Read <code title={state.pin.head}>{state.pin.head.slice(0, 7)}</code>
                        {state.pin.changes ? ' with uncommitted changes' : ''}
                      </small>
                    )}
                    {state.report && <Report text={state.report} />}
                  </div>
                  <time className="shrink-0 pt-1 text-[11px] text-muted-foreground tabular-nums">{clock(state.ended || state.started)}</time>
                </li>
              )
            })}
          </ol>
        </Section>
      )}
      {run.report && (
        <Section title="Report">
          <pre className="overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 text-xs whitespace-pre-wrap">{run.report}</pre>
        </Section>
      )}
      {Boolean(run.history?.length) && (
        <Section title="History" note="every step it entered, in order">
          <RunHistory run={run} d={d} />
        </Section>
      )}
    </div>
  )
}

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  if (!children) return null
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function StepPanel({ run, d, step, onBack }: { run: Run; d: Definition; step: Step; onBack: () => void }) {
  const st = run.steps?.[step.id]
  const n = nodeState(run, step)
  const last = (st?.runs || 0) > 1
  return (
    <div className="grid content-start gap-3 p-4" aria-label={`${step.name} in this run`}>
      <div className="grid gap-1">
        <button type="button" onClick={onBack} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-3.5" /> This run
        </button>
        <h3 className="text-[15px] font-semibold">{step.name}</h3>
        <p className="text-xs text-muted-foreground">
          {KINDS[step.kind] || step.kind} · {st ? n.note : 'not reached in this run'}
        </p>
      </div>
      {st ? (
        <>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
            <Fact name="Outcome">{st.outcome ? WORDS[st.outcome] : n.cls === 'now' || n.cls === 'waiting' ? n.note : 'No result'}</Fact>
            <Fact name={last ? 'Last started' : 'Started'}>{clock(st.started)}</Fact>
            <Fact name={last ? 'Last ended' : 'Ended'}>{clock(st.ended)}</Fact>
            <Fact name="Took">{took(st.started, st.ended)}</Fact>
            <Fact name="Ran">{st.runs === 1 ? 'Once' : st.runs ? `${st.runs} times` : ''}</Fact>
            <Fact name="Machine">{st.machine}</Fact>
            <Fact name="Folder">{st.path && <code className="font-mono text-[11px]">{st.path}</code>}</Fact>
            <Fact name="Session">{st.session && <code className="font-mono text-[11px]">{st.session}</code>}</Fact>
          </dl>
          {st.overridden && <p className="text-xs text-status-warning-text">Passed by a person after its command failed.</p>}
          {st.report && (
            <div className="grid gap-1.5">
              <p className={head}>Report</p>
              <p className="text-xs whitespace-pre-wrap">{st.report}</p>
            </div>
          )}
          {Boolean(st.details?.length) && (
            <div className="grid gap-1.5">
              <p className={head}>Details</p>
              <ul className="list-disc pl-4 text-xs">
                {st.details!.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {st.answer && (
            <div className="grid gap-1.5">
              <p className={head}>Your answer</p>
              <p className="text-xs whitespace-pre-wrap">{st.answer}</p>
            </div>
          )}
          {st.ran && (
            <p className={help}>
              Its command {st.ran.passed ? 'passed' : 'failed'}: <code className="font-mono">{st.ran.command}</code>
            </p>
          )}
          <Section title="Each time it ran">
            <RunHistory run={run} d={d} only={step.id} />
          </Section>
        </>
      ) : (
        <p className={help}>The run has not reached this step.</p>
      )}
    </div>
  )
}

type Transcript = {
  available?: boolean
  why?: string
  loading?: boolean
  error?: string
  path?: string
  machine?: string
  transcript?: {
    dropped?: number
    skipped?: number
    cut?: boolean
    files: string[]
    items: { kind: 'prompt' | 'agent' | 'tool'; text?: string; at?: string; name?: string; input?: string; result?: string; failed?: boolean }[]
  }
}

const transcripts = new Map<string, Transcript>()

function StepLog({ run, step, open, onToggle }: { run: Run; step: Step; open: boolean; onToggle: () => void }) {
  const st = run.steps?.[step.id]
  const key = `${run.id}:${step.id}:${st?.runs}:${st?.ended}`
  const [, redraw] = useState(0)
  const read = () => {
    transcripts.set(key, { loading: true })
    redraw((n) => n + 1)
    api<Transcript>('GET', `/api/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}/transcript`)
      .then(
        (out) => transcripts.set(key, out),
        (err) => transcripts.set(key, { error: err.message })
      )
      .finally(() => redraw((n) => n + 1))
  }
  useEffect(() => {
    if (st && !transcripts.has(key)) read()
  }, [key])
  const got: Transcript | undefined = st ? transcripts.get(key) : { available: false, why: 'The run has not reached this step.' }
  let body: React.ReactNode
  if (!got || got.loading) body = <p className={help} role="status">Reading the transcript{st?.machine ? ` from ${st.machine}` : ''}…</p>
  else if (got.error)
    body = (
      <p className="text-xs text-destructive" role="alert">
        {got.error}
      </p>
    )
  else if (!got.available)
    body = (
      <p className={help}>
        {got.why}
        {run.conversation && ['plan', 'report'].includes(step.kind) && (
          <>
            {' '}
            <a href={`/dispatch?c=${encodeURIComponent(run.conversation)}`} className="underline">
              Open the conversation
            </a>
          </>
        )}
      </p>
    )
  else {
    const t = got.transcript!
    const items: ({ kind: 'tools'; list: typeof t.items } | (typeof t.items)[number])[] = []
    for (const item of t.items) {
      const prev = items.at(-1)
      if (item.kind === 'tool' && prev && 'list' in prev) prev.list.push(item)
      else items.push(item.kind === 'tool' ? { kind: 'tools', list: [item] } : item)
    }
    body = (
      <div className="grid gap-2">
        {Boolean(t.dropped) && <p className={help}>The {t.dropped} oldest entries are left out.</p>}
        {items.map((x, i) =>
          'list' in x ? (
            <div key={i} className="grid gap-1">
              {x.list.map((c, j) => (
                <details key={j} className="rounded-md border border-border text-xs">
                  <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1">
                    <span className={cn('size-1.5 rounded-full', c.failed ? 'bg-destructive' : c.result ? 'bg-status-success' : 'bg-muted-foreground/40')} />
                    <span className="font-medium">{c.name}</span>
                    {c.input && <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{c.input}</code>}
                  </summary>
                  {c.result ? <pre className="max-h-64 overflow-auto border-t border-border p-2 font-mono text-[11px] whitespace-pre-wrap">{c.result}</pre> : <p className={cn(help, 'border-t border-border p-2')}>No result was saved.</p>}
                </details>
              ))}
            </div>
          ) : x.kind === 'prompt' ? (
            <div key={i} className="ml-8 grid gap-0.5 rounded-lg bg-muted px-3 py-2 text-[13px]">
              <span className="text-[11px] text-muted-foreground">Sent by Yardbell{x.at ? ` · ${clock(x.at)}` : ''}</span>
              {(x.text || '').length <= 280 ? (
                <span className="whitespace-pre-wrap">{x.text}</span>
              ) : (
                <details>
                  <summary className="cursor-pointer">{(x.text || '').slice(0, 120).trim()}…</summary>
                  <span className="whitespace-pre-wrap">{x.text}</span>
                </details>
              )}
            </div>
          ) : (
            <Markdown key={i} text={x.text || ''} />
          )
        )}
        {Boolean(t.skipped) && (
          <p className={help}>
            {t.skipped} {t.skipped === 1 ? 'line was' : 'lines were'} too long to read, such as large tool output.
          </p>
        )}
        {t.cut && <p className={help}>The transcript is over 16 MB, so its end is missing here.</p>}
        <p className={help}>
          Read only, from {t.files.join(', ')} in <code className="font-mono">{got.path}</code> on {got.machine}.
        </p>
      </div>
    )
  }
  return (
    <section className="flex min-h-0 flex-col border-t border-border">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs">
        <Button size="xs" variant="ghost" aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide transcript' : 'Show transcript'}
        </Button>
        <strong className="font-semibold">{step.name}</strong>
        <span className="flex-1" />
        {(got?.available || got?.error) && (
          <Button size="xs" variant="ghost" onClick={read}>
            Read again
          </Button>
        )}
      </header>
      {open && <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 pb-4">{body}</div>}
    </section>
  )
}

const shownTerminal = new Map<string, string>()

function Terminal({ run, step, a, open, onToggle }: { run: Run; step: Step | null; a: RunActions; open: boolean; onToggle: () => void }) {
  const [, redraw] = useState(0)
  const list = run.terminals || []
  const live = step && list.find((t) => t.name === run.steps?.[step.id]?.session)
  if (step && !live) return <StepLog run={run} step={step} open={open} onToggle={onToggle} />
  if (!list.length)
    return (
      <section className="flex h-12 shrink-0 items-center border-t border-border px-4">
        <p className={help}>This run has no live session. Pick a step to see what it did.</p>
      </section>
    )
  const shown = live || list.find((t) => t.name === shownTerminal.get(run.id)) || list.find((t) => t.current) || list[0]
  const src = `/term/${encodeURIComponent(shown.machine)}/${encodeURIComponent(shown.name)}`
  return (
    <section className="flex min-h-0 flex-col border-t border-border">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs">
        <Button size="xs" variant="ghost" aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide terminal' : 'Show terminal'}
        </Button>
        {list.length > 1 && !live ? (
          <div role="group" aria-label="Sessions of this run" className="flex rounded-md bg-muted p-0.5">
            {list.map((t) => (
              <button
                key={t.name}
                type="button"
                aria-pressed={t === shown}
                onClick={() => {
                  shownTerminal.set(run.id, t.name)
                  redraw((n) => n + 1)
                }}
                className={cn('rounded-[5px] px-2 py-0.5', t === shown ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground')}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <strong className="font-semibold">{live ? step!.name : shown.label}</strong>
        )}
        {live && <small className="rounded-full bg-status-success/15 px-1.5 text-[10px] font-medium text-status-success">Live</small>}
        <span className="flex-1" />
        <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground">
          Open <ExternalLink className="size-3" />
        </a>
        <Button size="xs" variant="ghost-destructive" disabled={a.busy} onClick={() => a.stopSession(run, shown)}>
          Stop session
        </Button>
      </header>
      {open && (
        <div className="relative min-h-0 flex-1">
          <iframe title={`Terminal of ${shown.label}`} src={`${src}?embed=1`} data-unzoom="" className="absolute inset-0 size-full border-0" />
        </div>
      )}
    </section>
  )
}

export function RunsTab({
  d,
  runs,
  query,
  setQuery,
  a
}: {
  d: Definition
  runs: Run[]
  data: PipelinesData
  query: URLSearchParams
  setQuery: (change: Record<string, string | null>) => void
  a: RunActions
}) {
  const [terminalOpen, setTerminalOpen] = useState(() => localStorage.getItem(TERMINAL_KEY) !== 'false')
  const [logOpen, setLogOpen] = useState(true)
  const chosen = runs.find((r) => r.id === query.get('run')) || runs[0]
  if (!runs.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="border-b border-border px-5 py-3 text-[13px] text-muted-foreground">
          No runs yet. {SUBJECTLESS.includes(d.trigger.kind) ? 'Run it now, or' : 'Run it now with a ticket or link, or'} switch it on and let its trigger start one.
        </p>
        <PipelineCanvas def={d} viewKey={`${d.id}:${d.version}:`} className="flex-1" />
      </div>
    )
  const shape = chosen.definition || d
  const step = shape.steps.find((s) => s.id === query.get('step')) || null
  const ended = runs.filter((r) => ENDED.includes(r.state)).length
  const open = step ? logOpen : terminalOpen && Boolean(chosen.terminals?.length)
  const toggle = () => {
    if (step) return setLogOpen((o) => !o)
    setTerminalOpen((o) => {
      localStorage.setItem(TERMINAL_KEY, String(!o))
      return !o
    })
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)_22rem] max-lg:grid-cols-[minmax(0,1fr)]">
      <nav aria-label="Runs" className="scrollbar-sleek flex min-h-0 flex-col overflow-y-auto border-r border-border bg-card/40 max-lg:hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <span className="text-xs font-semibold">Runs</span>
          <span className="text-xs text-muted-foreground tabular-nums">{runs.length}</span>
          <span className="flex-1" />
          {ended > 0 && (
            <Button size="xs" variant="ghost" disabled={a.busy} onClick={a.clearRuns} className="text-muted-foreground hover:text-destructive" title="Delete every run that has ended">
              <Trash2 /> Clear ended
            </Button>
          )}
        </div>
        <div className="grid gap-1 p-2">
          {runs.map((r) => {
            const tone = runTone(r)
            return (
              <button
                key={r.id}
                type="button"
                aria-current={r === chosen}
                onClick={() => setQuery({ run: r.id, step: null })}
                className={cn(
                  'grid gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  r === chosen ? 'border-border bg-background shadow-xs' : 'border-transparent hover:bg-accent/50',
                  tone === 'wait' && r !== chosen && 'border-amber-500/25'
                )}
              >
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                  <RunDot run={r} />
                  <span className="truncate">{runLabel(r)}</span>
                </span>
                <small className={cn('truncate pl-4 text-xs', tone === 'wait' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{stateWord(r, r.definition || d)}</small>
              </button>
            )
          })}
        </div>
      </nav>
      <div className={cn('grid min-h-0 min-w-0', open ? 'grid-rows-[minmax(0,1fr)_minmax(0,45%)]' : 'grid-rows-[minmax(0,1fr)_auto]')}>
        <PipelineCanvas def={shape} run={chosen} selected={step?.id || null} on={{ select: (id) => setQuery({ step: id && id !== query.get('step') ? id : null }) }} viewKey={`${d.id}:${chosen.version}:${chosen.id}`} />
        <Terminal run={chosen} step={step} a={a} open={open} onToggle={toggle} />
      </div>
      <aside className="scrollbar-sleek min-h-0 overflow-y-auto border-l border-border max-lg:hidden">
        {step ? <StepPanel run={chosen} d={shape} step={step} onBack={() => setQuery({ step: null })} /> : <Detail run={chosen} d={shape} a={a} onPick={(id) => setQuery({ step: id })} />}
      </aside>
    </div>
  )
}

