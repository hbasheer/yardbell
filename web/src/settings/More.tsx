/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import { Box, CalendarDays, Plus, RefreshCw, SquareTerminal, ArrowLeftRight, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'
import { saved } from './saved'
import { EmptyState, Field, Group, inputClass, Section, Segmented } from './ui'

const fail = (e: unknown) => toast.error((e as Error).message)
const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const keep = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {}
}

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
function tokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}
function duration(secs: number) {
  if (secs < 60) return 'under a minute'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
function started(epoch: number) {
  const d = new Date(epoch * 1000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `Today ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function StatCard({ icon: Icon, value, label, title }: { icon: typeof Box; value: string; label: string; title?: string }) {
  return (
    <div title={title} className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="grid">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  )
}

// Tokens per day as bars, with sessions per day as their own row of bars on the same days below.
function DailyChart({ r }: { r: any }) {
  const [tip, setTip] = useState<{ i: number; text: string } | null>(null)
  const daily = r.daily as any[]
  const W = 720
  const H = 168
  const S = 44
  const top = 18
  const n = daily.length
  const step = W / n
  const bar = Math.max(2, Math.min(22, step - (n > 40 ? 1 : 4)))
  const max = Math.max(1, ...daily.map((d) => d.tokens))
  const maxSessions = Math.max(1, ...daily.map((d) => d.sessions))
  const every = n <= 7 ? 1 : n <= 31 ? 7 : 15
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Daily usage</h3>
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2 rounded-sm bg-foreground/80" />
            Input and output
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2 rounded-sm bg-foreground/25" />
            Cache reads
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2 rounded-sm bg-status-success" />
            Sessions, up to {maxSessions} a day
          </span>
        </div>
      </div>
      <div className="relative" onPointerLeave={() => setTip(null)}>
        <span className="absolute top-0 left-0 text-[10px] text-muted-foreground">{tokens(max)}</span>
        <svg
          viewBox={`0 0 ${W} ${H + S + 6}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Tokens and sessions per day for the last ${r.days} days`}
          className="h-56 w-full"
        >
          <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} className="stroke-border" />
          {daily.map((d, i) => {
            const x = i * step + (step - bar) / 2
            const io = d.input + d.output + d.cache_write
            const ioH = ((H - top) * io) / max
            const cacheH = ((H - top) * d.cache_read) / max
            const ioY = H - ioH
            const cacheY = ioY - (cacheH > 0 && ioH > 0 ? 2 : 0) - cacheH
            const sH = (S - 8) * (d.sessions / maxSessions)
            const text = `${dayLabel(d.day)}: ${tokens(d.tokens)} tokens (${tokens(io)} input and output, ${tokens(d.cache_read)} cache reads), ${d.sessions} session${d.sessions === 1 ? '' : 's'}`
            const on = tip?.i === i
            return (
              <g key={d.day} onPointerEnter={() => setTip({ i, text })} opacity={tip && !on ? 0.55 : 1}>
                <title>{text}</title>
                <rect x={i * step} y={0} width={step} height={H + S + 6} fill="transparent" />
                {ioH > 0 && <rect x={x} y={ioY} width={bar} height={ioH} rx={2} className="fill-foreground/80" />}
                {cacheH > 0 && <rect x={x} y={cacheY} width={bar} height={cacheH} rx={2} className="fill-foreground/25" />}
                {d.sessions > 0 && <rect x={x} y={H + 6 + S - sH} width={bar} height={sH} rx={2} className="fill-status-success" />}
              </g>
            )
          })}
        </svg>
        {tip && (
          <div className="pointer-events-none absolute top-1 right-0 max-w-sm rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-sm">
            {tip.text}
          </div>
        )}
        <div className="relative h-4 text-[10px] text-muted-foreground">
          {daily.map((d, i) =>
            (n - 1 - i) % every === 0 ? (
              <span key={d.day} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / n) * 100}%` }}>
                {dayLabel(d.day)}
              </span>
            ) : null
          )}
        </div>
      </div>
    </div>
  )
}

export function StatsSection() {
  const [tab, setTab] = useState(() => (['all', 'claude', 'codex'].includes(read('yardbell.stats.tab') || '') ? read('yardbell.stats.tab')! : 'all'))
  const [days, setDays] = useState(() => ([7, 30, 90].includes(Number(read('yardbell.stats.days'))) ? Number(read('yardbell.stats.days')) : 30))
  const [r, setR] = useState<any>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)
  const load = async () => {
    const mine = ++asked.current
    setLoading(true)
    try {
      const out = await api('GET', `/api/usage/stats?provider=${encodeURIComponent(tab)}&days=${days}`)
      if (mine === asked.current) {
        setR(out)
        setError('')
      }
    } catch (e) {
      if (mine === asked.current) setError((e as Error).message)
    } finally {
      if (mine === asked.current) setLoading(false)
    }
  }
  useEffect(() => {
    keep('yardbell.stats.tab', tab)
    keep('yardbell.stats.days', String(days))
    load()
  }, [tab, days])
  const t = r?.totals
  const empty = () => {
    const name = NAMES[tab]
    const found = name ? r.agents[tab] : r.agents.claude || r.agents.codex
    return found ? (
      `No ${name ? `${name} ` : ''}use in the last ${r.days} days.`
    ) : (
      <>
        No {name ? `${name} ` : ''}transcripts on this computer yet. Yardbell reads <code className="font-mono">~/.claude/projects</code> for Claude Code and{' '}
        <code className="font-mono">~/.codex/sessions</code> for Codex.
      </>
    )
  }
  return (
    <Section
      title="Stats & Usage"
      description="Tokens, sessions and models from the Claude Code and Codex transcripts on the computer Yardbell runs on. They are read where they are and nothing is sent anywhere."
      action={
        <Button size="sm" variant="outline" disabled={loading} onClick={load}>
          <RefreshCw className={cn(loading && 'animate-spin')} /> Read again
        </Button>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Agent"
          value={tab}
          onChange={setTab}
          options={[
            ['all', 'Overview'],
            ['claude', 'Claude'],
            ['codex', 'Codex']
          ]}
        />
        <Segmented
          label="Period"
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={[
            ['7', '7 days'],
            ['30', '30 days'],
            ['90', '90 days']
          ]}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't read the usage: {error}
        </p>
      )}
      {!r && !error && <p className="text-sm text-muted-foreground">Reading transcripts…</p>}
      {r && (
        <div className={cn('grid gap-4 transition-opacity', loading && 'opacity-60')}>
          <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
            <StatCard
              icon={Box}
              value={tokens(t.tokens)}
              label="Total tokens"
              title={`${t.tokens.toLocaleString()} tokens, ${t.cache_read.toLocaleString()} of them read from the prompt cache`}
            />
            <StatCard
              icon={ArrowLeftRight}
              value={tokens(t.input + t.output)}
              label="Input and output"
              title={`${t.input.toLocaleString()} input, ${t.output.toLocaleString()} output, ${t.cache_write.toLocaleString()} written to the cache`}
            />
            <StatCard
              icon={SquareTerminal}
              value={t.sessions.toLocaleString()}
              label={t.sessions === 1 ? 'Session' : 'Sessions'}
              title={`${t.turns.toLocaleString()} replies`}
            />
            <StatCard icon={CalendarDays} value={`${t.active_days} of ${r.days}`} label="Active days" />
          </div>
          {t.turns > 0 ? (
            <>
              <DailyChart r={r} />
              {r.models.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-border bg-card">
                  <h3 className="px-4 pt-3 text-[13px] font-semibold">By model</h3>
                  <table className="mt-2 w-full text-left text-[13px]">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="px-4 py-2 font-medium">Model</th>
                        <th className="px-4 py-2 font-medium">Share</th>
                        <th className="px-4 py-2 text-right font-medium">Tokens</th>
                        <th className="px-4 py-2 text-right font-medium">Replies</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.models.slice(0, 8).map((m: any) => {
                        const share = Math.round(m.share * 100)
                        return (
                          <tr key={`${m.provider}:${m.model}`} className="border-b border-border/60 last:border-0">
                            <td className="px-4 py-2">
                              <span className="font-medium">{m.model}</span>
                              {tab === 'all' && <span className="ml-2 text-xs text-muted-foreground">{NAMES[m.provider] || m.provider}</span>}
                            </td>
                            <td className="px-4 py-2">
                              <span className="flex items-center gap-2">
                                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                  <span className="block h-full rounded-full bg-foreground/70" style={{ width: `${Math.max(share, 1)}%` }} />
                                </span>
                                <span className="text-xs tabular-nums">{share}%</span>
                              </span>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{tokens(m.tokens)}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{m.turns.toLocaleString()}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {r.sessions.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-border bg-card">
                  <h3 className="px-4 pt-3 text-[13px] font-semibold">Recent sessions</h3>
                  <table className="mt-2 w-full text-left text-[13px]">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="px-4 py-2 font-medium">Project</th>
                        <th className="px-4 py-2 font-medium">Model</th>
                        <th className="px-4 py-2 text-right font-medium">Tokens</th>
                        <th className="px-4 py-2 font-medium">Started</th>
                        <th className="px-4 py-2 text-right font-medium">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.sessions.map((s: any, i: number) => (
                        <tr key={i} className="border-b border-border/60 last:border-0">
                          <td className="max-w-[16rem] truncate px-4 py-2" title={s.folder || ''}>
                            <span className="font-medium">{s.project}</span>
                            {tab === 'all' && <span className="ml-2 text-xs text-muted-foreground">{NAMES[s.provider] || s.provider}</span>}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground">{s.model || 'Unknown model'}</td>
                          <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">{tokens(s.tokens)}</td>
                          <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{started(s.started)}</td>
                          <td className="px-4 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">{duration(s.duration)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{empty()}</p>
          )}
          {r.scan && (
            <p className="text-xs text-muted-foreground">
              Read {r.scan.files.toLocaleString()} transcript{r.scan.files === 1 ? '' : 's'} ({r.scan.read.toLocaleString()} changed) in{' '}
              {r.scan.ms.toLocaleString()} ms.
            </p>
          )}
        </div>
      )}
    </Section>
  )
}

type Trigger = {
  name: string
  task: string
  enabled: boolean
  schedule?: string
  linear?: { assigned: boolean; states: string[] }
  github?: { assigned: boolean; review_requested: boolean }
}
type TriggerView = {
  trigger: Trigger
  kind: string
  describe: string
  next?: string
  checked?: string
  busy?: boolean
  last?: { outcome: string; at: string; text: string; conversation?: string }
  note?: string
  problem?: string
}
type TriggerData = { zone: string; now: string; triggers: TriggerView[]; tasks: string[] }
type Form = {
  index: number | null
  name: string
  task: string
  kind: string
  repeat: string
  at: string
  hours: string
  cron: string
  linear_assigned: boolean
  states: string
  gh_assigned: boolean
  gh_review: boolean
  enabled: boolean
}

function wall(stamp?: string) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stamp || '')
  return m ? { date: m[1], time: m[2] } : null
}

export function TriggersSection({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [data, setData] = useState<TriggerData | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState('')
  const load = () => api<TriggerData>('GET', '/api/triggers').then(setData, fail)
  useEffect(() => {
    load()
  }, [])
  // Times are the server's wall clock, as the schedule is, whatever the browser's own time zone.
  const when = (stamp?: string) => {
    const at = wall(stamp)
    const today = wall(data?.now)
    if (!at || !today) return ''
    const days = Math.round((Date.parse(at.date) - Date.parse(today.date)) / 86400000)
    if (days === 0) return `${at.time} today`
    if (days === 1) return `${at.time} tomorrow`
    if (days === -1) return `${at.time} yesterday`
    return `${new Date(`${at.date}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${at.time}`
  }
  const save = async (list: Trigger[], message: string) => {
    setData(await api<TriggerData>('POST', '/api/triggers', { triggers: list }))
    saved(message)
  }
  const open = (index: number | null) => {
    if (!data) return
    const t: Trigger = index === null ? { name: '', task: data.tasks[0] || '', enabled: true, schedule: 'daily 09:00' } : data.triggers[index].trigger
    const words = (t.schedule || 'daily 09:00').split(/\s+/)
    const repeat = ['daily', 'weekdays', 'every', 'cron'].includes(words[0]) ? words[0] : 'daily'
    setForm({
      index,
      name: t.name,
      task: t.task,
      kind: t.linear ? 'linear' : t.github ? 'github' : 'schedule',
      repeat,
      at: repeat === 'daily' || repeat === 'weekdays' ? (words[1] || '09:00').padStart(5, '0') : '09:00',
      hours: repeat === 'every' ? String(parseInt(words[1], 10) || 4) : '4',
      cron: repeat === 'cron' ? words.slice(1).join(' ') : '',
      linear_assigned: t.linear ? Boolean(t.linear.assigned) : true,
      states: (t.linear?.states || []).join(', '),
      gh_assigned: Boolean(t.github?.assigned),
      gh_review: t.github ? Boolean(t.github.review_requested) : true,
      enabled: t.enabled !== false
    })
  }
  const submit = async () => {
    if (!form || !data) return
    const t: Trigger = { name: form.name.trim(), task: form.task, enabled: form.enabled }
    if (form.kind === 'linear')
      t.linear = {
        assigned: form.linear_assigned,
        states: form.states
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }
    else if (form.kind === 'github') t.github = { assigned: form.gh_assigned, review_requested: form.gh_review }
    else
      t.schedule = form.repeat === 'every' ? `every ${form.hours.trim()}h` : form.repeat === 'cron' ? `cron ${form.cron.trim()}` : `${form.repeat} ${form.at}`
    const list = data.triggers.map((v) => v.trigger)
    if (form.index === null) list.push(t)
    else list[form.index] = t
    setBusy('form')
    try {
      await save(list, `Trigger ${t.name} saved.`)
      setForm(null)
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
    }
  }
  const tasks = form && data ? (data.tasks.includes(form.task) || !form.task ? data.tasks : [...data.tasks, form.task]) : []
  return (
    <Section
      title="Triggers"
      description={
        <>
          A trigger starts a Dispatch conversation from one of your saved prompts, on a schedule or when a ticket comes your way. Its steps follow your Dispatch rules
          like any other conversation. Times are in <strong>{data?.zone || "this server's time zone"}</strong>, the time zone of the machine Yardbell runs on.
        </>
      }
      action={
        <Button size="sm" variant="outline" disabled={!data} onClick={() => open(null)}>
          <Plus /> Add trigger
        </Button>
      }
    >
      {form && (
        <Group title={form.index === null ? 'New trigger' : `Edit ${form.name}`}>
          <div className="grid gap-3 py-4">
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="Name">
                <input
                  maxLength={60}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Morning summary"
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>
              <Field label="Saved prompt">
                <select value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })} className={inputClass}>
                  {tasks.map((name) => (
                    <option key={name} value={name}>
                      {name}
                      {data!.tasks.includes(name) ? '' : ' (deleted)'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Start it">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={inputClass}>
                <option value="schedule">On a schedule</option>
                <option value="linear">For Linear tickets</option>
                <option value="github">For GitHub issues and reviews</option>
              </select>
            </Field>
            {form.kind === 'schedule' && (
              <>
                <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                  <Field label="Repeat">
                    <select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} className={inputClass}>
                      <option value="daily">Every day</option>
                      <option value="weekdays">Weekdays, Monday to Friday</option>
                      <option value="every">Every few hours</option>
                      <option value="cron">Cron expression</option>
                    </select>
                  </Field>
                  {(form.repeat === 'daily' || form.repeat === 'weekdays') && (
                    <Field label="At">
                      <input type="time" step={60} value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} className={inputClass} />
                    </Field>
                  )}
                  {form.repeat === 'every' && (
                    <Field label="Hours between runs">
                      <input
                        type="number"
                        min={1}
                        max={23}
                        step={1}
                        inputMode="numeric"
                        value={form.hours}
                        onChange={(e) => setForm({ ...form, hours: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                  )}
                  {form.repeat === 'cron' && (
                    <Field label="Cron">
                      <input
                        value={form.cron}
                        onChange={(e) => setForm({ ...form, cron: e.target.value })}
                        placeholder="30 9 * * 1-5"
                        autoCapitalize="off"
                        spellCheck={false}
                        className={cn(inputClass, 'font-mono')}
                      />
                    </Field>
                  )}
                </div>
                {form.repeat === 'every' && (
                  <p className="text-xs text-muted-foreground">Counted from midnight: every 4 hours runs at 00:00, 04:00, 08:00 and so on.</p>
                )}
                {form.repeat === 'cron' && (
                  <p className="text-xs text-muted-foreground">
                    Five fields: minute, hour, day of the month, month and day of the week, where 0 and 7 are Sunday. Use numbers, *, ranges like 1-5, lists
                    like 1,15 and steps like */15.
                  </p>
                )}
              </>
            )}
            {form.kind === 'linear' && (
              <>
                <label className="inline-flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.linear_assigned}
                    onChange={(e) => setForm({ ...form, linear_assigned: e.target.checked })}
                    className="size-3.5 accent-foreground"
                  />
                  A ticket is assigned to me
                </label>
                <Field
                  label="Or one of my tickets moves to"
                  hint="Separate states with commas. Yardbell reads your open Linear tickets every 3 minutes with the API key saved as the secret linear, under Integrations."
                >
                  <input
                    value={form.states}
                    onChange={(e) => setForm({ ...form, states: e.target.value })}
                    placeholder="In Progress, Ready for dev"
                    autoComplete="off"
                    className={inputClass}
                  />
                </Field>
              </>
            )}
            {form.kind === 'github' && (
              <>
                <label className="inline-flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.gh_assigned}
                    onChange={(e) => setForm({ ...form, gh_assigned: e.target.checked })}
                    className="size-3.5 accent-foreground"
                  />
                  An issue is assigned to me
                </label>
                <label className="inline-flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.gh_review}
                    onChange={(e) => setForm({ ...form, gh_review: e.target.checked })}
                    className="size-3.5 accent-foreground"
                  />
                  A pull request asks for my review
                </label>
                <p className="text-xs text-muted-foreground">
                  Yardbell asks the GitHub CLI <code className="font-mono">gh</code> on this machine every 3 minutes, as the account it is logged in with.
                </p>
              </>
            )}
            {form.kind !== 'schedule' && (
              <p className="text-xs text-muted-foreground">
                The prompt gets the ticket: write {'{ticket}'}, {'{title}'}, {'{url}'}, {'{state}'} or {'{repo}'} in it where each goes, or the ticket is added at
                the end. One conversation per ticket, one at a time. Tickets that already match when the trigger starts watching are left alone.
              </p>
            )}
            <div className="flex items-center gap-3 border-t border-border pt-3">
              <label className="inline-flex items-center gap-2 text-[13px]">
                <Switch checked={form.enabled} onCheckedChange={(on) => setForm({ ...form, enabled: on })} aria-label="On" />
                On
              </label>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy === 'form' || !form.name.trim() || !form.task} onClick={submit}>
                Save trigger
              </Button>
            </div>
          </div>
        </Group>
      )}
      <Group>
        {!data && <p className="py-4 text-xs text-muted-foreground">Reading triggers…</p>}
        {data && !data.triggers.length && (
          <EmptyState
            icon={Zap}
            title="No triggers yet"
            action={
              <Button size="sm" variant="outline" onClick={() => open(null)}>
                <Plus /> Add trigger
              </Button>
            }
          >
            Start a Dispatch conversation from a saved prompt every morning, on weekdays, or when a Linear or GitHub ticket is assigned to you.
          </EmptyState>
        )}
        {data?.triggers.map((v, i) => {
          const t = v.trigger
          const schedule = v.kind === 'schedule'
          const plan = !t.enabled
            ? 'Off'
            : v.busy
              ? 'Running now'
              : schedule && v.next
                ? `Next ${when(v.next)}`
                : !schedule && v.checked
                  ? `Checked ${when(v.checked)}`
                  : ''
          return (
            <div key={t.name} className={cn('flex flex-wrap items-start gap-3 py-3', !t.enabled && 'opacity-70')}>
              <Switch
                checked={t.enabled}
                aria-label={`${t.name} on`}
                onCheckedChange={async (on) => {
                  try {
                    setData(await api<TriggerData>('POST', '/api/triggers/enable', { name: t.name, enabled: on }))
                    saved(`Trigger ${t.name} is ${on ? 'on' : 'off'}.`)
                  } catch (e) {
                    fail(e)
                  }
                }}
                className="mt-0.5"
              />
              <div className="grid min-w-0 flex-1 basis-60 gap-0.5">
                <p className="text-[13px] font-medium">
                  {t.name} <span className="font-normal text-muted-foreground">{v.describe}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Runs the saved prompt <strong className="font-medium text-foreground">{t.task}</strong>
                  {plan ? ` · ${plan}` : ''}
                </p>
                {v.last && (
                  <p className={cn('text-xs', v.last.outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                    {v.last.outcome === 'watching' ? '' : 'Last run '}
                    {when(v.last.at)}: {v.last.text}.{' '}
                    {v.last.conversation && (
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground"
                        onClick={() => onOpenConversation(v.last!.conversation!)}
                      >
                        Open the conversation
                      </button>
                    )}
                  </p>
                )}
                {v.note && <p className="text-xs text-muted-foreground">{v.note}.</p>}
                {v.problem && (
                  <p className="text-xs text-destructive">
                    {v.problem.charAt(0).toUpperCase()}
                    {v.problem.slice(1)}.
                  </p>
                )}
              </div>
              <span className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy === t.name || (!schedule && !t.enabled)}
                  onClick={async () => {
                    setBusy(t.name)
                    try {
                      const out = await api<{ conversation?: string; text: string }>('POST', '/api/triggers/run', { name: t.name })
                      toast(out.conversation ? `${t.name} started a conversation in Dispatch.` : `${out.text}.`)
                    } catch (e) {
                      const m = (e as Error).message
                      toast.error(m.charAt(0).toUpperCase() + m.slice(1))
                    }
                    setBusy('')
                    load()
                  }}
                >
                  {schedule ? 'Run now' : 'Check now'}
                </Button>
                <Button size="xs" variant="outline" onClick={() => open(i)}>
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={async () => {
                    if (
                      !(await confirmAction({
                        title: `Delete the trigger ${t.name}?`,
                        body: 'Conversations it started are kept.',
                        confirm: 'Delete',
                        danger: true
                      }))
                    )
                      return
                    try {
                      await save(
                        data.triggers.map((x) => x.trigger).filter((_, j) => j !== i),
                        `Trigger ${t.name} deleted.`
                      )
                      if (form?.index === i) setForm(null)
                    } catch (e) {
                      fail(e)
                    }
                  }}
                >
                  Delete
                </Button>
              </span>
            </div>
          )
        })}
      </Group>
    </Section>
  )
}
