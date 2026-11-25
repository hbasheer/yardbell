import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { api, KINDS, OUTCOMES, tokens, type Definition, type PipelinesData, type Step, type Trigger } from './model'

type Data = PipelinesData & { mcp_servers: string[]; gitlab_hosts: string[] }
type ConnectorFull = { id: string; name: string; enabled?: boolean; params: { name: string; label?: string; filter?: boolean; options?: string }[]; calls: { name: string; kind?: string; needs?: string[] }[]; filters?: Record<string, string> }
export type StepUpdate = (mut: (s: Step) => void) => void
export type DefUpdate = (mut: (d: Definition) => void) => void

export const inputClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'
const areaClass =
  'w-full min-w-0 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'
const help = 'text-[11.5px] leading-relaxed text-muted-foreground'

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5 border-b border-border/60 px-4 py-3.5 last:border-b-0">
      <p className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">{title}</p>
      {children}
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint ? <small className={help}>{hint}</small> : null}
    </label>
  )
}

function Toggle({ label, on, onChange, hint }: { label: string; on: boolean; onChange: (on: boolean) => void; hint?: string }) {
  return (
    <div className="grid gap-1">
      <label className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{label}</span>
        <Switch checked={on} onCheckedChange={onChange} aria-label={label} />
      </label>
      {hint && <small className={help}>{hint}</small>}
    </div>
  )
}

function Picks({ list, chosen, onChange }: { list: string[]; chosen: string[]; onChange: (list: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {list.map((m) => (
        <label key={m} className="inline-flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={chosen.includes(m)} onChange={(e) => onChange(e.target.checked ? [...chosen, m] : chosen.filter((x) => x !== m))} className="size-3.5 accent-foreground" />
          {m}
        </label>
      ))}
    </div>
  )
}

function StepSelect({ value, others, onChange, extra = [] }: { value?: string; others: Step[]; onChange: (v: string) => void; extra?: [string, string][] }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      {!value && <option value="">Pick a step</option>}
      {extra.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
      {others.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )
}

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// What a connection's lists hold, kept per address so a redraw does not ask again.
const choices = new Map<string, { loading?: boolean; list?: { id: string; name?: string }[]; error?: string }>()

function useChoices(id: string | undefined, call: string | undefined, params: Record<string, string> = {}) {
  const [, redraw] = useState(0)
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()
  const url = id && call ? `/api/settings/connectors/${encodeURIComponent(id)}/options/${encodeURIComponent(call)}${query ? `?${query}` : ''}` : ''
  useEffect(() => {
    if (!url || choices.has(url)) return
    choices.set(url, { loading: true })
    api<{ id: string; name?: string }[]>('GET', url)
      .then(
        (list) => choices.set(url, { list }),
        (err) => choices.set(url, { error: err.message })
      )
      .finally(() => redraw((n) => n + 1))
  }, [url])
  return url ? choices.get(url) || { loading: true } : { list: [] }
}

// Only what a list depends on goes in its address, so picking a filter asks nothing again.
function scopeOf(connector: ConnectorFull, call: string, params: Record<string, string> = {}) {
  const needs = connector.calls.find((c) => c.name === call)?.needs || []
  return Object.fromEntries(needs.filter((n) => params[n]).map((n) => [n, params[n]]))
}

const NoConnections = () => (
  <p className={help}>
    No connections yet. Add one under{' '}
    <a href="/settings#connections" className="underline">
      Settings, Connections
    </a>
    .
  </p>
)

const limitOf = (d: Definition, data: Data) => d.token_limit ?? data.settings.token_limit ?? 0
const reportsTokens = (agent: unknown, data: Data) => !(data.agents_without_tokens || []).includes(((agent as string) || data.default_agent) as string)

function AgentFields({ step, others, data, draft, update }: { step: Step; others: Step[]; data: Data; draft: Definition; update: StepUpdate }) {
  const m = (step.machine || { pick: [] }) as { name?: string; same_as?: string; pick?: string[] }
  const mode = 'name' in m ? 'name' : 'same_as' in m ? 'same_as' : 'pick'
  const ws = (step.workspace || { kind: 'new_worktree' }) as { kind: string; step?: string; from?: string }
  const setMachine = (v: unknown) => update((s) => (s.machine = v))
  return (
    <>
      <Group title="Agent">
        <Field label="Instructions" hint="Fill in {ticket}, {title}, {url}, {description}, {branch}, {pr}, {report} or {report:Step name}.">
          <textarea rows={6} value={(step.instructions as string) || ''} onChange={(e) => update((s) => (s.instructions = e.target.value))} className={areaClass} />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field
            label="Agent"
            hint={limitOf(draft, data) > 0 && !reportsTokens(step.agent, data) ? 'This agent cannot report tokens, so a run waits and asks you before starting this step.' : undefined}
          >
            <select value={(step.agent as string) || ''} onChange={(e) => update((s) => (s.agent = e.target.value))} className={inputClass}>
              <option value="">Your default agent</option>
              {data.agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Machine">
            <select
              value={mode}
              onChange={(e) => setMachine(e.target.value === 'name' ? { name: data.machines[0] || '' } : e.target.value === 'same_as' ? { same_as: others[0]?.id || '' } : { pick: [] })}
              className={inputClass}
            >
              <option value="pick">Dispatch picks it</option>
              <option value="name">Always this machine</option>
              <option value="same_as">The machine of another step</option>
            </select>
          </Field>
        </div>
        {mode === 'name' && (
          <Field label="Which machine">
            <select value={m.name || ''} onChange={(e) => setMachine({ name: e.target.value })} className={inputClass}>
              {data.machines.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
        )}
        {mode === 'same_as' && (
          <Field label="Same machine as">
            <StepSelect value={m.same_as} others={others} onChange={(v) => setMachine({ same_as: v })} />
          </Field>
        )}
        {mode === 'pick' && (
          <Field label="Dispatch may pick from" hint="None ticked means any machine.">
            <Picks list={data.machines} chosen={m.pick || []} onChange={(list) => setMachine({ pick: list })} />
          </Field>
        )}
      </Group>
      <Group title="Workspace">
        <Field label="Works in">
          <select
            value={ws.kind}
            onChange={(e) =>
              update((s) => {
                const k = e.target.value
                s.workspace = k === 'new_worktree' ? { kind: k } : k === 'same_as' ? { kind: k, step: others[0]?.id || '' } : { kind: k, from: others[0]?.id || '' }
              })
            }
            className={inputClass}
          >
            <option value="new_worktree">A new worktree on the run's branch</option>
            <option value="same_as">The folder of another step</option>
            <option value="copy">A copy of another step's branch</option>
          </select>
        </Field>
        {ws.kind === 'same_as' && (
          <Field label="Folder of">
            <StepSelect value={ws.step} others={others} onChange={(v) => update((s) => (s.workspace = { kind: 'same_as', step: v }))} />
          </Field>
        )}
        {ws.kind === 'copy' && (
          <Field label="Copy of">
            <StepSelect value={ws.from} others={others} onChange={(v) => update((s) => (s.workspace = { kind: 'copy', from: v }))} />
          </Field>
        )}
        <Toggle label="Review: new read-only session" on={Boolean(step.read_only)} onChange={(on) => update((s) => (s.read_only = on))} hint="Other steps share the run's one session." />
        {data.mcp_servers.length > 0 && (
          <Field label="MCP servers" hint="An agent signs in to a server itself, on its own machine. Signing in here is for Yardbell's own steps. Saved with the step; agents do not get them yet.">
            <Picks list={data.mcp_servers} chosen={(step.mcp_servers as string[]) || []} onChange={(list) => update((s) => (s.mcp_servers = list))} />
          </Field>
        )}
      </Group>
    </>
  )
}

function ConnectionField({ step, data, update }: { step: Step; data: Data; update: StepUpdate }) {
  const value = step.kind === 'tool' ? `server:${step.server}` : `connector:${step.connector}`
  const pick = (chosen: string) =>
    update((s) => {
      const at = chosen.indexOf(':')
      const kind = chosen.slice(0, at)
      const name = chosen.slice(at + 1)
      for (const key of ['connector', 'call', 'params', 'server', 'tool', 'arguments', 'call_kind', 'schema_hash']) delete s[key]
      if (kind === 'server') Object.assign(s, { kind: 'tool', server: name, tool: '', arguments: {}, call_kind: 'change', schema_hash: '' })
      else Object.assign(s, { kind: 'call', connector: name, call: '', params: {} })
    })
  return (
    <Field label="Connection">
      <select value={value} onChange={(e) => pick(e.target.value)} className={inputClass}>
        {data.connectors.length > 0 && (
          <optgroup label="Actions you set up">
            {data.connectors.map((c) => (
              <option key={c.id} value={`connector:${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        {data.mcp_servers.length > 0 && (
          <optgroup label="Any tool on a signed-in server">
            {data.mcp_servers.map((m) => (
              <option key={m} value={`server:${m}`}>
                {m}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </Field>
  )
}

function CallFields({ step, data, update }: { step: Step; data: Data; update: StepUpdate }) {
  const connector = (data.connectors as unknown as ConnectorFull[]).find((c) => c.id === step.connector)
  const call = connector?.calls.find((c) => c.name === step.call)
  const params = (step.params || {}) as Record<string, string>
  return (
    <>
      <Field label="Call" hint={call?.kind === 'change' ? 'It changes something in the tool, and your Dispatch rules can refuse it.' : undefined}>
        <select value={(step.call as string) || ''} onChange={(e) => update((s) => (s.call = e.target.value))} className={inputClass}>
          <option value="">Pick a call</option>
          {(connector?.calls || []).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}, {c.kind === 'lookup' ? 'reads' : 'changes'}
            </option>
          ))}
        </select>
      </Field>
      {(call?.needs || []).map((name) => (
        <Field key={name} label={name} hint="You can use {{ticket}}, {{title}}, {{url}}, {{branch}} and {{report}}.">
          <input value={params[name] || ''} onChange={(e) => update((s) => (s.params = { ...((s.params as object) || {}), [name]: e.target.value }))} className={inputClass} />
        </Field>
      ))}
    </>
  )
}

type Tool = { name: string; description?: string; schema_hash?: string; read_only_hint?: boolean; input_schema?: { properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>; required?: string[] } }
const serverTools = new Map<string, { loading?: boolean; error?: string; tools: Tool[] }>()

function ToolFields({ step, update }: { step: Step; update: StepUpdate }) {
  const [, redraw] = useState(0)
  const server = step.server as string
  useEffect(() => {
    if (!server || serverTools.has(server)) return
    serverTools.set(server, { loading: true, tools: [] })
    api<{ tools: Tool[] }>('GET', `/api/settings/mcp/servers/${encodeURIComponent(server)}/tools`)
      .then((out) => serverTools.set(server, { tools: out.tools }))
      .catch((err) => serverTools.set(server, { error: err.message, tools: [] }))
      .finally(() => redraw((n) => n + 1))
  }, [server])
  const listed = server ? serverTools.get(server) || { loading: true, tools: [] } : { tools: [] }
  const tool = listed.tools.find((t) => t.name === step.tool)
  const properties = tool?.input_schema?.properties || {}
  const required = tool?.input_schema?.required || []
  const args = (step.arguments || {}) as Record<string, unknown>
  return (
    <>
      {(listed.error || listed.loading) && <p className={help}>{listed.error || 'Asking the server for its tools.'}</p>}
      <Field label="Tool" hint={tool?.description}>
        <select
          value={(step.tool as string) || ''}
          onChange={(e) =>
            update((s) => {
              const picked = listed.tools.find((t) => t.name === e.target.value)
              s.tool = e.target.value
              s.arguments = {}
              s.schema_hash = picked?.schema_hash || ''
              s.call_kind = picked?.read_only_hint ? 'lookup' : 'change'
            })
          }
          className={inputClass}
        >
          <option value="">Pick a tool</option>
          {listed.tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      {tool &&
        Object.entries(properties).map(([name, schema]) => {
          const hint = [required.includes(name) ? 'Required.' : '', schema.description || ''].filter(Boolean).join(' ')
          if (schema.type === 'string' && !schema.enum)
            return (
              <Field key={name} label={name} hint={hint}>
                <input
                  value={(args[name] as string) ?? ''}
                  placeholder="{{ticket}} fills in from the run"
                  onChange={(e) =>
                    update((s) => {
                      const a = { ...((s.arguments as object) || {}) } as Record<string, unknown>
                      if (e.target.value) a[name] = e.target.value
                      else delete a[name]
                      s.arguments = a
                    })
                  }
                  className={inputClass}
                />
              </Field>
            )
          return <JsonArgument key={name} name={name} hint={hint} value={args[name]} update={update} />
        })}
      {tool && (
        <Toggle
          label="Only reads"
          on={step.call_kind === 'lookup'}
          onChange={(on) => update((s) => (s.call_kind = on ? 'lookup' : 'change'))}
          hint="A tool's own label is only a hint, so check it. A step that changes things can be refused by your Dispatch rules."
        />
      )}
    </>
  )
}

function JsonArgument({ name, hint, value, update }: { name: string; hint: string; value: unknown; update: StepUpdate }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2))
  const [bad, setBad] = useState(false)
  return (
    <Field label={`${name} (JSON)`} hint={bad ? 'This is not valid JSON' : hint}>
      <textarea
        rows={3}
        spellCheck={false}
        value={text}
        aria-invalid={bad}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim()
          try {
            const parsed = t ? JSON.parse(t) : undefined
            setBad(false)
            update((s) => {
              const a = { ...((s.arguments as object) || {}) } as Record<string, unknown>
              if (parsed === undefined) delete a[name]
              else a[name] = parsed
              s.arguments = a
            })
          } catch {
            setBad(true)
          }
        }}
        className={cn(areaClass, 'font-mono text-xs', bad && 'border-destructive')}
      />
    </Field>
  )
}

// Typing a command is a person writing it, so it counts as approved. One an agent proposed stays
// unapproved until a person says so.
function CommandFields({ step, update, proposal }: { step: Step; update: StepUpdate; proposal: boolean }) {
  const waiting = step.command && step.approved !== step.command
  return (
    <>
      <Field
        label="Command"
        hint="Runs in your login shell in the run's worktree, on its machine. Exit 0 follows the pass line and anything else follows the fail line. The end of its output is the step's report, so a later step can read it with {report}. It takes no placeholders. Join several commands with &&, because only the last one's exit counts otherwise."
      >
        <textarea
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          value={(step.command as string) || ''}
          onChange={(e) =>
            update((s) => {
              s.command = e.target.value
              if (!proposal) s.approved = e.target.value
            })
          }
          className={cn(areaClass, 'font-mono text-xs')}
        />
      </Field>
      {waiting && (
        <div className="grid gap-2 rounded-md border border-status-warning/50 bg-status-warning/8 p-2.5">
          <p className={help}>Nobody has approved this command yet, so a run stops here and shows it to you first.{proposal ? ' You can accept it then.' : ''}</p>
          {!proposal && (
            <Button size="xs" variant="outline" className="w-fit" onClick={() => update((s) => (s.approved = s.command))}>
              Approve this command
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function UpdateFields({ step, data, draft, update }: { step: Step; data: Data; draft: Definition; update: StepUpdate }) {
  const t = draft.trigger
  const from = t.kind === 'connector' || (t.kind === 'schedule' && t.connector) ? (data.connectors as unknown as ConnectorFull[]).find((c) => c.id === t.connector) : undefined
  const hasStates = Boolean(from?.calls.some((c) => c.name === 'states'))
  const found = useChoices(hasStates ? from?.id : undefined, hasStates ? 'states' : undefined, from ? scopeOf(from, 'states', t.params as Record<string, string>) : {})
  return (
    <>
      <Field label="Action" hint="It uses whichever connection started the run. In Linear, a comment is drafted for you to post.">
        <select value={(step.action as string) || 'move'} onChange={(e) => update((s) => (s.action = e.target.value))} className={inputClass}>
          <option value="move">Move the ticket</option>
          <option value="comment">Comment with the run's report</option>
        </select>
      </Field>
      {step.action === 'move' &&
        (hasStates && found.list ? (
          <Field label="To the state">
            <select value={(step.state as string) || ''} onChange={(e) => update((s) => (s.state = e.target.value))} className={inputClass}>
              <option value="">Pick a state</option>
              {found.list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="To the state" hint="The state's name in Linear, or its id in another tool.">
            <input value={(step.state as string) || ''} onChange={(e) => update((s) => (s.state = e.target.value))} className={inputClass} />
          </Field>
        ))}
    </>
  )
}

const KIND_GROUPS: Record<string, string> = { plan: 'Machines', update: 'Ticket', checks: 'Checks', call: 'Connection', tool: 'Connection', command: 'Command', wait: 'Message' }

export function StepForm({ step, draft, data, update, proposal }: { step: Step; draft: Definition; data: Data; update: StepUpdate; proposal: boolean }) {
  const others = draft.steps.filter((s) => s.id !== step.id)
  const targets: [string, string][] = [
    ['end', 'End the run'],
    ['wait', 'Wait for me']
  ]
  const kindBody = () => {
    switch (step.kind) {
      case 'call':
        return !data.connectors.length && !data.mcp_servers.length ? (
          <NoConnections />
        ) : (
          <>
            <ConnectionField step={step} data={data} update={update} />
            <CallFields step={step} data={data} update={update} />
          </>
        )
      case 'tool':
        return (
          <>
            <ConnectionField step={step} data={data} update={update} />
            <ToolFields step={step} update={update} />
          </>
        )
      case 'plan':
        return (
          <Field label="Dispatch may pick from" hint="None ticked means any machine.">
            <Picks list={data.machines} chosen={(step.machines as string[]) || []} onChange={(list) => update((s) => (s.machines = list))} />
          </Field>
        )
      case 'update':
        return <UpdateFields step={step} data={data} draft={draft} update={update} />
      case 'command':
        return <CommandFields step={step} update={update} proposal={proposal} />
      case 'checks':
        return (
          <>
            <Toggle label="Also wait for an approval" on={Boolean(step.require_approval)} onChange={(on) => update((s) => (s.require_approval = on))} />
            <p className={help}>
              Follows pass when CI is green, and fail when a check fails or a reviewer asks for changes. Its report holds the failed logs and open comments, so a Fix step can use {'{report}'}. Stops for you if a check fails the same way on two commits, or checks fail on four
              commits in a row.
            </p>
          </>
        )
      case 'wait':
        return (
          <Field label="Message">
            <textarea rows={2} value={(step.message as string) || ''} onChange={(e) => update((s) => (s.message = e.target.value))} className={areaClass} />
          </Field>
        )
      default:
        return null
    }
  }
  return (
    <div data-step-form={step.id}>
      <Group title="Step">
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2.5">
          <Field label="Name">
            <input value={step.name} onChange={(e) => update((s) => rename(draft, s, e.target.value))} className={inputClass} />
          </Field>
          <Field label="Runs at most">
            <input type="number" min={1} max={10} value={String((step.max_runs as number) ?? 2)} onChange={(e) => update((s) => (s.max_runs = Number(e.target.value)))} className={inputClass} />
          </Field>
        </div>
        {(step.kind === 'agent' || step.kind === 'checks' || step.kind === 'command') && (
          <Field label={step.kind === 'command' ? 'Stop after minutes' : 'Minutes'}>
            <input
              type="number"
              min={step.kind === 'command' ? 1 : 10}
              max={1440}
              placeholder={step.kind === 'command' ? '10' : String(data.settings.minutes)}
              value={step.minutes == null ? '' : String(step.minutes)}
              onChange={(e) => update((s) => (s.minutes = e.target.value === '' ? null : Number(e.target.value)))}
              className={inputClass}
            />
          </Field>
        )}
      </Group>
      {step.kind === 'agent' ? <AgentFields step={step} others={others} data={data} draft={draft} update={update} /> : KIND_GROUPS[step.kind] ? <Group title={KIND_GROUPS[step.kind]}>{kindBody()}</Group> : null}
      <Group title="Then">
        {OUTCOMES.map((o) => (
          <Field key={o} label={o === 'pass' ? 'On pass' : o === 'fail' ? 'On fail' : 'On needs you'}>
            <StepSelect value={step.next[o]} others={others} extra={targets} onChange={(v) => update((s) => (s.next = { ...s.next, [o]: v }))} />
          </Field>
        ))}
      </Group>
    </div>
  )
}

// A renamed step keeps the {report:Name} placeholders that point at it.
function rename(d: Definition, step: Step, name: string) {
  const old = step.name.trim()
  step.name = name
  if (!old) return
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const placeholder = new RegExp(`\\{report:\\s*${escaped}\\s*\\}`, 'gi')
  for (const s of d.steps) {
    if (s.kind === 'agent' && s.instructions) s.instructions = (s.instructions as string).replace(placeholder, `{report:${name.trim()}}`)
  }
}

export function newTrigger(kind: string, data: Data): Trigger {
  if (kind === 'schedule') return { kind, schedule: '', state: '' }
  if (kind === 'linear') return { kind, assigned: true, states: [] }
  if (kind === 'gitlab_reviewer') return { kind, host: data.gitlab_hosts[0] || '' }
  if (kind === 'connector') return { kind, connector: data.connectors[0]?.id || '', params: {}, states: [] }
  if (kind === 'webhook') return { kind, map: {} }
  return { kind }
}

function ParamFields({ connector, params, setParam }: { connector?: ConnectorFull; params: Record<string, string>; setParam: (name: string, value: string) => void }) {
  const needed = connector?.calls?.find((c) => c.name === 'list')?.needs || []
  if (!connector) return null
  return (
    <>
      {connector.params.map((p) => (
        <ParamField key={p.name} connector={connector} p={p} params={params} needed={needed} setParam={setParam} />
      ))}
    </>
  )
}

function filterHelp(connector: ConnectorFull, p: { name: string; filter?: boolean }) {
  if (!p.filter) return ''
  return connector.filters?.[p.name] === 'source' ? `Optional. ${connector.name} filters on this itself.` : `Optional. ${connector.name} cannot filter on this, so Yardbell reads its list and keeps the matches.`
}

function ParamField({
  connector,
  p,
  params,
  needed,
  setParam
}: {
  connector: ConnectorFull
  p: ConnectorFull['params'][number]
  params: Record<string, string>
  needed: string[]
  setParam: (name: string, value: string) => void
}) {
  const waits = p.options ? (connector.calls.find((c) => c.name === p.options)?.needs || []).find((n) => !params[n]) : undefined
  const found = useChoices(p.options && !waits ? connector.id : undefined, p.options && !waits ? p.options : undefined, p.options ? scopeOf(connector, p.options, params) : {})
  if (!p.options)
    return (
      <Field label={p.label || p.name} hint={filterHelp(connector, p)}>
        <input defaultValue={params[p.name] || ''} onBlur={(e) => setParam(p.name, e.target.value.trim())} className={inputClass} />
      </Field>
    )
  const list = waits ? [] : found.list || []
  return (
    <Field label={p.label || p.name} hint={found.error ? 'The choices could not be read. Test the connection in Settings.' : filterHelp(connector, p)}>
      <select value={params[p.name] || ''} onChange={(e) => setParam(p.name, e.target.value)} className={inputClass}>
        <option value="">{needed.includes(p.name) && !p.filter ? 'Pick one' : 'Any'}</option>
        {params[p.name] && !list.some((o) => o.id === params[p.name]) && <option value={params[p.name]}>{params[p.name]}</option>}
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name || o.id}
          </option>
        ))}
      </select>
    </Field>
  )
}

function StatePicks({ t, connector, update }: { t: Trigger; connector: ConnectorFull; update: DefUpdate }) {
  const has = connector.calls.some((c) => c.name === 'states')
  const found = useChoices(has ? connector.id : undefined, has ? 'states' : undefined, scopeOf(connector, 'states', t.params as Record<string, string>))
  const states = (t.states as string[]) || []
  const set = (list: string[]) => update((d) => (d.trigger.states = list))
  const typed = (
    <Field label="In the states" hint="Empty means every item.">
      <input placeholder="Empty means every item" defaultValue={states.join(', ')} onBlur={(e) => set(csv(e.target.value))} className={inputClass} />
    </Field>
  )
  if (!has) return typed
  if (found.loading) return <p className={help}>Reading {connector.name}…</p>
  if (found.error)
    return (
      <>
        {typed}
        <p className={help}>The choices could not be read. Pick the other options first, or type the ids here.</p>
      </>
    )
  return (
    <Field label="In the states" hint="None ticked means every item.">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {(found.list || []).map((s) => (
          <label key={s.id} className="inline-flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={states.includes(s.id)} onChange={(e) => set(e.target.checked ? [...states, s.id] : states.filter((x) => x !== s.id))} className="size-3.5 accent-foreground" />
            {s.name}
          </label>
        ))}
      </div>
    </Field>
  )
}

type Preview = { key: string; loading?: boolean; error?: string; result?: { count: number; items: { id: string; title: string; url?: string }[]; how: string; note?: string } }

function TicketPreview({ t, data }: { t: Trigger; data: Data }) {
  const [shown, setShown] = useState<Preview | null>(null)
  const key = JSON.stringify(t)
  const connector = t.kind === 'connector' ? (data.connectors as unknown as ConnectorFull[]).find((c) => c.id === t.connector) : undefined
  const list = connector?.calls.find((c) => c.name === 'list')
  const filters = (connector?.params || []).filter((p) => p.filter).map((p) => p.name)
  const params = (t.params || {}) as Record<string, string>
  const waiting = (list?.needs || []).find((n) => !filters.includes(n) && !params[n])
  const waitingFor = connector?.params.find((p) => p.name === waiting)
  const current = shown?.key === key ? shown : null
  const preview = () => {
    setShown({ key, loading: true })
    api<Preview['result']>('POST', '/api/pipelines/trigger-preview', { trigger: t }).then(
      (result) => setShown({ key, result }),
      (err) => setShown({ key, error: err.message })
    )
  }
  return (
    <div className="grid gap-2">
      <Button size="xs" variant="outline" className="w-fit" disabled={Boolean(current?.loading || waiting || (t.kind === 'connector' && !connector))} onClick={preview}>
        See what matches now
      </Button>
      {waiting && <p className={help}>Pick the {waitingFor?.label || waiting} first.</p>}
      {current?.loading && <p className={help}>Reading the tickets…</p>}
      {current?.error && (
        <p role="alert" className="text-xs text-destructive">
          {current.error}
        </p>
      )}
      {current?.result && (
        <div aria-live="polite" className="grid gap-1 text-xs">
          <p>
            <strong>{current.result.count === 0 ? 'Nothing matches now.' : `${current.result.count} ${current.result.count === 1 ? 'ticket matches' : 'tickets match'} now.`}</strong> {current.result.how}
          </p>
          {current.result.count === 0 && <p className={help}>If you expected some, check the names. A tool does not say when a name does not exist.</p>}
          {current.result.items.length > 0 && (
            <ul className="grid gap-0.5">
              {current.result.items.map((i) => (
                <li key={i.id}>
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="underline">
                      {i.id}
                    </a>
                  ) : (
                    i.id
                  )}{' '}
                  {i.title}
                </li>
              ))}
            </ul>
          )}
          {current.result.count - current.result.items.length > 0 && <p className={help}>And {current.result.count - current.result.items.length} more.</p>}
          {current.result.note && <p className={help}>{current.result.note}</p>}
        </div>
      )}
      <p className={help}>
        The first check only notes what already matches, and the same goes for the first check after a filter changes, so old tickets never flood in. A run starts when a ticket comes to match after that, such as when it gets the label.
      </p>
    </div>
  )
}

function WebhookFields({ d, update }: { d: Definition; update: DefUpdate }) {
  const [address, setAddress] = useState<{ url?: string; token?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const map = ((d.trigger.map as Record<string, string>) || {}) as Record<string, string>
  const shown = address?.url || (address ? `/hooks/pipeline/${d.id}/${address.token}` : '')
  return (
    <>
      <div className="grid gap-1">
        <span className="text-xs font-medium">Address</span>
        <Button
          size="xs"
          variant="outline"
          className="w-fit"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              setAddress(await api('POST', `/api/pipelines/${encodeURIComponent(d.id)}/webhook-token`))
            } catch (e) {
              alert((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          New address
        </Button>
        <small className={help}>Yardbell listens on this machine and your mesh. An outside service cannot reach this address without a tunnel you set up. A new address replaces the old one.</small>
      </div>
      {shown && (
        <div className="grid gap-1 rounded-md border border-border bg-muted/40 p-2">
          <code className="font-mono text-[11px] break-all">{shown}</code>
          <p className={help}>Copy it now: it is shown only this once. It works once this is saved and switched on.</p>
        </div>
      )}
      <p className={help}>
        The body is JSON with <code>id</code> and <code>title</code>, and optional <code>url</code> and <code>description</code>. If yours differs, name where each one is:
      </p>
      {['id', 'title', 'url', 'description'].map((name) => (
        <Field key={name} label={name}>
          <input
            placeholder={name}
            defaultValue={map[name] || ''}
            autoCapitalize="off"
            spellCheck={false}
            onBlur={(e) =>
              update((def) => {
                const m = { ...((def.trigger.map as Record<string, string>) || {}) }
                if (e.target.value.trim()) m[name] = e.target.value.trim()
                else delete m[name]
                def.trigger.map = m
              })
            }
            className={inputClass}
          />
        </Field>
      ))}
    </>
  )
}

const TRIGGER_KINDS: [string, string][] = [
  ['manual', 'By hand'],
  ['schedule', 'On a schedule'],
  ['linear', 'New ticket from a connection'],
  ['webhook', 'A webhook'],
  ['github_review', 'A GitHub review request'],
  ['gitlab_reviewer', 'A GitLab merge request reviewer']
]

export function TriggerForm({ d, data, update }: { d: Definition; data: Data; update: DefUpdate }) {
  const t = d.trigger
  const connectors = data.connectors as unknown as ConnectorFull[]
  const connector = t.kind === 'connector' ? connectors.find((c) => c.id === t.connector) : undefined
  const params = (t.params || {}) as Record<string, string>
  const filter = (t.filter || {}) as Record<string, string[]>
  const setConnectorParam = (name: string, value: string) =>
    update((def) => {
      const tr = def.trigger
      const p = { ...((tr.params as Record<string, string>) || {}) }
      if (value) p[name] = value
      else delete p[name]
      const filters = (connector?.params || []).filter((x) => x.filter)
      if (!filters.some((x) => x.name === name)) {
        tr.states = []
        for (const x of filters) delete p[x.name]
      }
      tr.params = p
    })
  return (
    <>
      <Group title="Trigger">
        <Field label="Starts">
          <select value={t.kind === 'connector' ? 'linear' : t.kind} onChange={(e) => update((def) => (def.trigger = newTrigger(e.target.value, data)))} className={inputClass}>
            {TRIGGER_KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {(t.kind === 'linear' || t.kind === 'connector') && (
          <Field label="From">
            <select
              value={t.kind === 'linear' ? 'linear' : (t.connector as string)}
              onChange={(e) => update((def) => (def.trigger = e.target.value === 'linear' ? newTrigger('linear', data) : { kind: 'connector', connector: e.target.value, params: {}, states: [] }))}
              className={inputClass}
            >
              <option value="linear">Linear</option>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {t.kind === 'schedule' && (
          <>
            <Field label="Schedule">
              <input placeholder="weekdays 02:00" value={(t.schedule as string) || ''} onChange={(e) => update((def) => (def.trigger.schedule = e.target.value))} className={inputClass} />
            </Field>
            <Field label="With my open tickets in">
              <input placeholder="Todo, or empty for none" value={(t.state as string) || ''} onChange={(e) => update((def) => (def.trigger.state = e.target.value))} className={inputClass} />
            </Field>
            {connectors.length > 0 && (
              <Field label="Read them from">
                <select value={(t.connector as string) || ''} onChange={(e) => update((def) => (def.trigger.connector = e.target.value))} className={inputClass}>
                  <option value="">Linear</option>
                  {connectors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {Boolean(t.connector) && (
              <ParamFields
                connector={connectors.find((c) => c.id === t.connector)}
                params={params}
                setParam={(name, value) =>
                  update((def) => {
                    const p = { ...((def.trigger.params as Record<string, string>) || {}) }
                    if (value) p[name] = value
                    else delete p[name]
                    def.trigger.params = p
                  })
                }
              />
            )}
          </>
        )}
        {t.kind === 'connector' &&
          (!connectors.length ? (
            <NoConnections />
          ) : (
            <>
              <ParamFields connector={connector} params={params} setParam={setConnectorParam} />
              {connector && <StatePicks t={t} connector={connector} update={update} />}
              {connector && !connector.params.some((p) => p.filter) && (
                <p className={help}>
                  {connector.name} has no filters, so every item it lists can start a run. Add one in its Choices under{' '}
                  <a href="/settings#connections" className="underline">
                    Settings, Connections
                  </a>
                  .
                </p>
              )}
            </>
          ))}
        {t.kind === 'linear' && (
          <>
            <Field label="In the states" hint="Empty means when it is assigned to you.">
              <input placeholder="Todo, In Progress" defaultValue={((t.states as string[]) || []).join(', ')} onBlur={(e) => update((def) => (def.trigger.states = csv(e.target.value)))} className={inputClass} />
            </Field>
            <Toggle label="Only tickets assigned to me" on={Boolean(t.assigned)} onChange={(on) => update((def) => (def.trigger.assigned = on))} />
            {(
              [
                ['labels', 'With a label', 'bug, agent-ready'],
                ['teams', 'In a team', 'ENG or Web team'],
                ['projects', 'In a project', 'Billing']
              ] as const
            ).map(([key, label, placeholder]) => (
              <Field key={key} label={label}>
                <input
                  placeholder={placeholder}
                  defaultValue={(filter[key] || []).join(', ')}
                  onBlur={(e) =>
                    update((def) => {
                      const list = csv(e.target.value)
                      const next = { ...((def.trigger.filter as Record<string, string[]>) || {}) }
                      if (list.length) next[key] = list
                      else delete next[key]
                      if (Object.keys(next).length) def.trigger.filter = next
                      else delete def.trigger.filter
                    })
                  }
                  className={inputClass}
                />
              </Field>
            ))}
            <p className={help}>Optional. Linear filters on these itself. Names in one box mean any of them, and a ticket must match every box. Only your assigned tickets are read, so these narrow them further.</p>
          </>
        )}
        {t.kind === 'gitlab_reviewer' && (
          <Field label="GitLab host" hint={data.gitlab_hosts.length ? undefined : 'Add the host under Settings, GitHub and GitLab first.'}>
            {data.gitlab_hosts.length ? (
              <select value={(t.host as string) || ''} onChange={(e) => update((def) => (def.trigger.host = e.target.value))} className={inputClass}>
                {data.gitlab_hosts.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            ) : (
              <input value={(t.host as string) || ''} onChange={(e) => update((def) => (def.trigger.host = e.target.value))} className={inputClass} />
            )}
          </Field>
        )}
        <Field label="First step">
          <StepSelect value={d.start} others={d.steps} onChange={(v) => update((def) => (def.start = v))} />
        </Field>
      </Group>
      {t.kind === 'webhook' && (
        <Group title="Webhook">
          <WebhookFields d={d} update={update} />
        </Group>
      )}
      {(t.kind === 'linear' || t.kind === 'connector') && (
        <Group title="What matches">
          <TicketPreview t={t} data={data} />
        </Group>
      )}
    </>
  )
}

export function TokenLimitForm({ d, data, update }: { d: Definition; data: Data; update: DefUpdate }) {
  const fallback = data.settings.token_limit || 0
  const blind = limitOf(d, data) > 0 ? d.steps.filter((s) => s.kind === 'agent' && !reportsTokens(s.agent, data)) : []
  return (
    <Group title="Token limit">
      <Field
        label="Tokens one run may use"
        hint={`Past this the run starts no new step that uses tokens and waits for you. Pushes, ticket updates and connected tools go through. Empty uses the default in Settings, ${fallback ? `${tokens(fallback)} tokens` : 'no limit'}. 0 means no limit here.`}
      >
        <input
          type="number"
          min={0}
          placeholder={fallback ? tokens(fallback) : 'No limit'}
          value={d.token_limit == null ? '' : String(d.token_limit)}
          onChange={(e) => update((def) => (def.token_limit = e.target.value === '' ? null : Number(e.target.value)))}
          className={inputClass}
        />
      </Field>
      {blind.length > 0 && (
        <p role="status" className="text-[11.5px] text-status-warning-text">
          {blind.map((s) => s.name).join(', ')} cannot report tokens, because only Claude Code does. A run waits and asks you before starting {blind.length === 1 ? 'it' : 'each of them'}, then leaves what it uses out of the total.
        </p>
      )}
    </Group>
  )
}

export const kindLabel = (k: string) => KINDS[k] || k
export type { Data }
