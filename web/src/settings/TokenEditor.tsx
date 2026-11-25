/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react'
import { ArrowLeft, ChevronRight, ClipboardPaste, Copy, KeyRound, LoaderCircle, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { api } from '@/pipelines/model'
import { areaClass, Field, inputClass } from './ui'

export type TokenConnector = {
  id: string
  name: string
  about?: string
  host?: string
  server?: string
  base_url?: string
  enabled: boolean
  allow_private?: boolean
  headers?: Record<string, string>
  missing: string[]
  calls?: Record<string, any>
  params?: { name: string; label?: string; options?: string; filter?: boolean }[]
}
export type TokenStart = { view: 'pick' } | { view: 'edit'; conn: TokenConnector; was: string } | { view: 'import' } | { view: 'test'; conn: TokenConnector } | { view: 'share'; conn: TokenConnector }

type Pair = { key: string; value: string }
type Call = { name: string; method: string; path: string; query: Pair[]; body: string; items: string; map: Pair[]; changes: boolean; extra: Record<string, any> }
type Choice = { name: string; label: string; options: string; filter: boolean }

const CALL_WORDS: Record<string, string> = {
  list: 'Lists items',
  read: 'Reads one item',
  states: 'Lists states',
  move: 'Moves an item',
  comment: 'Adds a comment',
  close: 'Closes an item',
  create: 'Creates an item',
  update: 'Updates an item'
}
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const SECRET_NAME = /authori[sz]ation|token|secret|api[-_]?key|password|private/i
const toPairs = (o?: Record<string, any>): Pair[] => Object.entries(o || {}).map(([key, value]) => ({ key, value: String(value) }))
const fromPairs = (pairs: Pair[]) => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]))
const slugOf = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
const secretLabel = (name: string) => {
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function callFromSaved(name: string, saved: any): Call {
  const { request, map, items, kind, tool, arguments: args, ...extra } = saved || {}
  if (tool) extra.tool = tool
  if (args !== undefined) extra.arguments = args
  const method = request?.method || 'GET'
  const body = request?.body
  return {
    name,
    method,
    path: request?.path || '',
    query: toPairs(request?.query),
    body: body === undefined || body === null ? '' : JSON.stringify(body, null, 2),
    items: items || '',
    map: toPairs(map),
    changes: kind ? kind === 'change' : method !== 'GET',
    extra
  }
}

function callsToSave(calls: Call[]) {
  const out: Record<string, any> = {}
  for (const call of calls) {
    const name = call.name.trim()
    if (!name) throw new Error('Every action needs a name.')
    if (!call.path.trim() && !call.extra.tool) throw new Error(`The action ${name} needs a path.`)
    if (Object.hasOwn(out, name)) throw new Error(`There are two actions called ${name}.`)
    const saved: any = { ...call.extra, kind: call.changes ? 'change' : 'lookup' }
    if (!call.extra.tool) {
      const request: any = { method: call.method, path: call.path.trim() }
      const query = fromPairs(call.query)
      if (Object.keys(query).length) request.query = query
      if (call.body.trim() && call.method !== 'GET') {
        try {
          request.body = JSON.parse(call.body)
        } catch {
          throw new Error(`The body of ${name} is not valid JSON.`)
        }
      }
      saved.request = request
    }
    const map = fromPairs(call.map)
    if (Object.keys(map).length) saved.map = map
    if (call.items.trim()) saved.items = call.items.trim()
    out[name] = saved
  }
  return out
}

async function keep(taken: Set<string>, wanted: string, value: string) {
  const base = wanted
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 60)
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  await api('POST', '/api/settings/secrets', { name, value })
  taken.add(name)
  return `\${secret:${name}}`
}

function Pairs({ list, onChange, keyHint, valueHint }: { list: Pair[]; onChange: (l: Pair[]) => void; keyHint: string; valueHint: string }) {
  const set = (i: number, patch: Partial<Pair>) => onChange(list.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="grid gap-1.5">
      {list.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-1.5">
          <input aria-label={keyHint} placeholder={keyHint} value={p.key} onChange={(e) => set(i, { key: e.target.value })} autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono text-xs')} />
          <input aria-label={valueHint} placeholder={valueHint} value={p.value} onChange={(e) => set(i, { value: e.target.value })} autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono text-xs')} />
          <button type="button" aria-label="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, { key: '', value: '' }])} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Plus className="size-3.5" /> Add
      </button>
    </div>
  )
}

function ActionCard({ call, open, onToggle, onChange, onRemove }: { call: Call; open: boolean; onToggle: () => void; onChange: (c: Call) => void; onRemove: () => void }) {
  const set = (patch: Partial<Call>) => onChange({ ...call, ...patch })
  return (
    <div className="rounded-lg border border-border/70">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="w-12 shrink-0 font-mono text-[10.5px] font-semibold text-muted-foreground">{call.extra.tool ? 'TOOL' : call.method}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{CALL_WORDS[call.name] || call.name || 'New action'}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">{call.extra.tool || call.path || 'No path yet'}</span>
        </span>
        <span
          className={cn(
            'rounded-full border px-1.5 text-[10px] leading-4',
            call.changes ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-border text-muted-foreground'
          )}
        >
          {call.changes ? 'Changes' : 'Reads'}
        </span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-border/50 px-3 py-3">
          <Field label="Name">
            <input value={call.name} onChange={(e) => set({ name: e.target.value })} placeholder="list" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono')} />
          </Field>
          {call.extra.tool ? (
            <p className="text-xs text-muted-foreground">
              Calls the tool <code className="font-mono">{call.extra.tool}</code> with <code className="font-mono">{JSON.stringify(call.extra.arguments || {})}</code>.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-[7rem_1fr] gap-2">
                <Field label="Method">
                  <select value={call.method} onChange={(e) => set({ method: e.target.value, changes: e.target.value !== 'GET' })} className={inputClass}>
                    {METHODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Path" hint="Values like {{board}} fill in from the run. It is added to the connection's address.">
                  <input value={call.path} onChange={(e) => set({ path: e.target.value })} placeholder="/boards/{{board}}/cards" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono')} />
                </Field>
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium">Query</span>
                <Pairs list={call.query} onChange={(query) => set({ query })} keyHint="Field" valueHint="Value" />
              </div>
              {call.method !== 'GET' && (
                <Field label="Body, as JSON">
                  <textarea rows={4} value={call.body} onChange={(e) => set({ body: e.target.value })} spellCheck={false} className={cn(areaClass, 'font-mono text-xs')} />
                </Field>
              )}
            </>
          )}
          <Field label="Where the list is in the reply">
            <input value={call.items} onChange={(e) => set({ items: e.target.value })} placeholder="Leave empty if the reply is the list" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono')} />
          </Field>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Reply fields to keep</span>
            <span className="text-[11.5px] text-muted-foreground">The name Yardbell uses, then where it is in the reply. Test after saving shows the reply's fields.</span>
            <Pairs list={call.map} onChange={(map) => set({ map })} keyHint="item_id" valueHint="id" />
          </div>
          <label className="inline-flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={call.changes} onChange={(e) => set({ changes: e.target.checked })} className="size-3.5 accent-foreground" />
            Changes something in the tool, so your Dispatch rules can refuse it
          </label>
          {(call.extra.page || call.extra.before?.length) && (
            <p className="text-[11.5px] text-muted-foreground">
              It also {[call.extra.page && 'reads page by page', call.extra.before?.length && 'asks something first'].filter(Boolean).join(' and ')}, which stays as it is.
            </p>
          )}
          <button type="button" onClick={onRemove} className="inline-flex w-fit items-center gap-1 text-xs text-destructive hover:underline">
            <Trash2 className="size-3.5" /> Remove action
          </button>
        </div>
      )}
    </div>
  )
}

function Editor({ conn, was, list, secrets, onBack, onDone }: { conn: TokenConnector; was: string; list: TokenConnector[]; secrets: string[]; onBack?: () => void; onDone: (saved?: string) => void }) {
  const known = Object.keys(CALL_WORDS)
  const rank = (n: string) => (known.includes(n) ? known.indexOf(n) : known.length)
  const blank = !Object.keys(conn.calls || {}).length
  const [name, setName] = useState(conn.name || '')
  const [id, setId] = useState(was ? conn.id : '')
  const [baseUrl, setBaseUrl] = useState(conn.base_url || '')
  const [enabled, setEnabled] = useState(conn.enabled !== false)
  const [allowPrivate, setAllowPrivate] = useState(Boolean(conn.allow_private))
  const [headers, setHeaders] = useState<Pair[]>(toPairs(conn.headers))
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [calls, setCalls] = useState<Call[]>(() =>
    Object.entries(conn.calls || {})
      .map(([n, s]) => callFromSaved(n, s))
      .sort((a, b) => rank(a.name) - rank(b.name))
  )
  const [choices, setChoices] = useState<Choice[]>((conn.params || []).map((p) => ({ name: p.name, label: p.label || '', options: p.options || '', filter: Boolean(p.filter) })))
  const [more, setMore] = useState(blank)
  const [tab, setTab] = useState<'actions' | 'choices' | 'headers'>('actions')
  const [opened, setOpened] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const server = conn.server || ''
  const missing = conn.missing || []

  const freeId = (wanted: string) => {
    if (was || !list.some((c) => c.id === wanted)) return wanted
    const base = `${wanted}-token`
    let out = base
    for (let n = 2; list.some((c) => c.id === out); n++) out = `${base}-${n}`
    return out
  }

  const save = async () => {
    setNote('')
    let saved
    try {
      saved = callsToSave(calls)
    } catch (e) {
      setMore(true)
      setTab('actions')
      return setNote((e as Error).message)
    }
    const kept = choices
      .filter((c) => c.name.trim())
      .map((c) => ({ name: c.name.trim(), label: c.label, ...(c.options ? { options: c.options } : {}), ...(c.filter ? { filter: true } : {}) }))
    const theId = freeId(id.trim() || slugOf(name))
    setBusy(true)
    try {
      if (!theId) throw new Error('Give the connection a name.')
      if (!server && !/^https?:\/\/[^\s/]+/.test(baseUrl.trim())) throw new Error("Type the tool's address, starting with https://")
      const taken = new Set(secrets)
      const outHeaders: Record<string, string> = {}
      for (const { key, value: raw } of headers) {
        const k = key.trim()
        const value = raw.trim()
        if (!k) continue
        if (!value || value.includes('${secret:') || !SECRET_NAME.test(k)) {
          outHeaders[k] = value
          continue
        }
        const scheme = value.match(/^(Bearer|Basic|token)\s+(.+)$/i)
        const ref = await keep(taken, `${theId}_${k}`, scheme ? scheme[2] : value)
        outHeaders[k] = scheme ? `${scheme[1]} ${ref}` : ref
      }
      setHeaders(toPairs(outHeaders))
      await api('POST', '/api/settings/connectors', {
        was,
        id: theId,
        name: name.trim(),
        base_url: server ? '' : baseUrl.trim(),
        server,
        enabled,
        allow_private: allowPrivate,
        headers: outHeaders,
        params_yaml: kept.length ? JSON.stringify(kept) : '',
        calls_yaml: JSON.stringify(saved)
      })
      const entered = Object.entries(typed).filter(([, v]) => v)
      for (const [n, value] of entered) await api('POST', '/api/settings/secrets', { name: n, value })
      if (entered.length && entered.length === missing.length && enabled) api('POST', `/api/settings/connectors/${encodeURIComponent(theId)}/test`, {}).catch(() => {})
      toast(`${name.trim() || theId} saved.`)
      onDone(theId)
    } catch (e) {
      const msg = (e as Error).message
      setNote(msg)
      if (/call|param|header/i.test(msg)) setMore(true)
    } finally {
      setBusy(false)
    }
  }

  const about = was ? '' : missing.length ? `${conn.about || ''} Create what it asks for in ${conn.name}, then paste it here. Yardbell keeps it in secrets and never shows it again.` : blank ? "Describe the tool's API under More options." : conn.about || ''

  return (
    <>
      <Head title={was ? `Edit ${conn.name}` : conn.name ? `Connect ${conn.name}` : 'New connection'} onBack={onBack} onClose={() => onDone()} />
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <div className="grid gap-4">
          {about.trim() && <p className="text-xs leading-relaxed text-muted-foreground">{about.trim()}</p>}
          {missing.length > 0 && (
            <div className="grid gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              {missing.map((n, i) => (
                <Field key={n} label={secretLabel(n)}>
                  <input
                    autoFocus={i === 0}
                    type="password"
                    placeholder="Paste it here"
                    value={typed[n] || ''}
                    onChange={(e) => setTyped({ ...typed, [n]: e.target.value })}
                    autoComplete="new-password"
                    autoCapitalize="off"
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <Field label="Name">
              <input autoFocus={!missing.length} value={name} onChange={(e) => setName(e.target.value)} placeholder="Trello" className={inputClass} />
            </Field>
            <Field label="ID" hint={was ? 'Pipelines name it by this.' : 'Taken from the name if left empty.'}>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder={slugOf(name) || 'trello'} autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono')} />
            </Field>
          </div>
          {!server && (
            <Field label="Address" hint="The base address of the tool's web API. Every action's path is added to it.">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" placeholder="https://api.trello.com/1" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono')} />
            </Field>
          )}
          <div className="divide-y divide-border/50 rounded-lg border border-border/70">
            <label className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="grid">
                <span className="text-[13px] font-medium">Switched on</span>
                <span className="text-[11.5px] text-muted-foreground">Pipelines and Dispatch can use it.</span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Switched on" />
            </label>
            {!server && (
              <label className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="grid">
                  <span className="text-[13px] font-medium">Allow private addresses</span>
                  <span className="text-[11.5px] text-muted-foreground">For a tool on this machine or your mesh.</span>
                </span>
                <Switch checked={allowPrivate} onCheckedChange={setAllowPrivate} aria-label="Allow private addresses" />
              </label>
            )}
          </div>

          <div className="rounded-lg border border-border/70">
            <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium">
              <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', more && 'rotate-90')} />
              More options
              <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">
                {calls.length} {calls.length === 1 ? 'action' : 'actions'} · {headers.filter((h) => h.key.trim()).length} headers
              </span>
            </button>
            {more && (
              <div className="grid gap-3 border-t border-border/50 p-3">
                <div className="flex gap-4 border-b border-border/40">
                  {(
                    [
                      ['actions', 'Actions'],
                      ['headers', 'Login headers'],
                      ['choices', 'Choices']
                    ] as const
                  ).map(([k, l]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={tab === k}
                      onClick={() => setTab(k)}
                      className={cn('-mb-px border-b-2 pb-2 text-[13px]', tab === k ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                {tab === 'actions' && (
                  <div className="grid gap-2">
                    {!calls.length && <p className="text-xs text-muted-foreground">No actions yet. An action is one call to the tool's API, like listing cards.</p>}
                    {calls.map((c, i) => (
                      <ActionCard
                        key={i}
                        call={c}
                        open={opened.has(i)}
                        onToggle={() => {
                          const next = new Set(opened)
                          if (next.has(i)) next.delete(i)
                          else next.add(i)
                          setOpened(next)
                        }}
                        onChange={(nc) => setCalls(calls.map((x, j) => (j === i ? nc : x)))}
                        onRemove={() => (setCalls(calls.filter((_, j) => j !== i)), setOpened(new Set()))}
                      />
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit"
                      onClick={() => {
                        setCalls([...calls, callFromSaved('', { request: { method: 'GET', path: '' } })])
                        setOpened(new Set([...opened, calls.length]))
                      }}
                    >
                      <Plus /> Add action
                    </Button>
                  </div>
                )}
                {tab === 'headers' && (
                  <div className="grid gap-1.5">
                    <span className="text-[11.5px] text-muted-foreground">
                      Sent with every call. A token typed here is moved into secrets when you save, and the header keeps only its name.
                    </span>
                    <Pairs list={headers} onChange={setHeaders} keyHint="Authorization" valueHint="Bearer ${secret:my_token}" />
                  </div>
                )}
                {tab === 'choices' && (
                  <div className="grid gap-2">
                    <span className="text-[11.5px] text-muted-foreground">What a pipeline asks for when it uses this connection, like which board. Options can come from an action.</span>
                    {choices.map((c, i) => {
                      const set = (patch: Partial<Choice>) => setChoices(choices.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                      return (
                        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto_auto] items-center gap-1.5 max-sm:grid-cols-2">
                          <input aria-label="Name" placeholder="board" value={c.name} onChange={(e) => set({ name: e.target.value })} autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'font-mono text-xs')} />
                          <input aria-label="Label" placeholder="Board" value={c.label} onChange={(e) => set({ label: e.target.value })} className={inputClass} />
                          <select aria-label="Options from" value={c.options} onChange={(e) => set({ options: e.target.value })} className={inputClass}>
                            <option value="">Typed in</option>
                            {calls
                              .filter((x) => x.name)
                              .map((x) => (
                                <option key={x.name} value={x.name}>
                                  From {x.name}
                                </option>
                              ))}
                          </select>
                          <label title="Optional. It narrows which items start a run." className="inline-flex items-center gap-1.5 text-xs">
                            <input type="checkbox" checked={c.filter} onChange={(e) => set({ filter: e.target.checked })} className="size-3.5 accent-foreground" />
                            Filter
                          </label>
                          <button type="button" aria-label="Remove" onClick={() => setChoices(choices.filter((_, j) => j !== i))} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive">
                            <X className="size-3.5" />
                          </button>
                        </div>
                      )
                    })}
                    <button type="button" onClick={() => setChoices([...choices, { name: '', label: '', options: '', filter: false }])} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      <Plus className="size-3.5" /> Add choice
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <Foot note={note}>
        <Button variant="ghost" onClick={() => (onBack ? onBack() : onDone())}>
          {onBack ? 'Back' : 'Cancel'}
        </Button>
        <Button disabled={busy} onClick={save}>
          {busy && <LoaderCircle className="animate-spin" />} Save
        </Button>
      </Foot>
    </>
  )
}

function Head({ title, onBack, onClose, description }: { title: string; onBack?: () => void; onClose: () => void; description?: string }) {
  return (
    <div className="flex shrink-0 items-start gap-2 px-6 pt-5 pb-4">
      {onBack && (
        <button type="button" aria-label="Back" onClick={onBack} className="-ml-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="size-4" />
        </button>
      )}
      <div className="grid min-w-0 flex-1 gap-1">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <DialogDescription className={cn('text-xs', !description && 'sr-only')}>{description || title}</DialogDescription>
      </div>
      <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="size-4" />
      </button>
    </div>
  )
}

function Foot({ note, children }: { note?: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/50 px-6 py-3">
      <p role={note ? 'alert' : undefined} className="min-w-0 flex-1 text-xs text-destructive">
        {note}
      </p>
      {children}
    </div>
  )
}

function Picker({ starters, onPick, onImport, onClose }: { starters: [string, TokenConnector][]; onPick: (c: TokenConnector) => void; onImport: () => void; onClose: () => void }) {
  return (
    <>
      <Head title="Connect with a token" description="For a tool with no MCP server to sign in to, or when you would rather use an API key. Each one lists the calls Yardbell may make." onClose={onClose} />
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {starters.map(([key, c]) => (
          <button key={key} type="button" onClick={() => onPick(c)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent/50">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted text-sm font-semibold">{c.name.charAt(0)}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{c.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{c.about}</span>
            </span>
            <span className="text-xs text-muted-foreground">Set up</span>
          </button>
        ))}
        <button type="button" onClick={() => onPick({ id: '', name: '', enabled: true, headers: {}, missing: [] })} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent/50">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashed border-border text-muted-foreground">
            <Plus className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Start blank</span>
            <span className="block text-xs text-muted-foreground">Any tool with a web API.</span>
          </span>
        </button>
        <button type="button" onClick={onImport} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent/50">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground">
            <ClipboardPaste className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Paste a shared connection</span>
            <span className="block text-xs text-muted-foreground">What someone copied from Share. It holds no secret values.</span>
          </span>
        </button>
      </div>
    </>
  )
}

function Import({ onBack, onClose, onDone }: { onBack: () => void; onClose: () => void; onDone: (msg: string) => void }) {
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  return (
    <>
      <Head title="Paste a shared connection" onBack={onBack} onClose={onClose} />
      <div className="min-h-0 flex-1 px-6 pb-4">
        <textarea autoFocus rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste it here" spellCheck={false} className={cn(areaClass, 'h-full font-mono text-xs')} />
      </div>
      <Foot note={note}>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={!text.trim()}
          onClick={async () => {
            try {
              const out = await api<{ id: string; host?: string; secrets: string[] }>('POST', '/api/settings/connectors/import', { text })
              const needs = out.secrets.length ? ` It needs the secret ${out.secrets.join(', ')}.` : ''
              onDone(`${out.id} imported, switched off. It can reach ${out.host || 'its address'}.${needs} Read its actions, then switch it on with Edit.`)
            } catch (e) {
              setNote((e as Error).message)
            }
          }}
        >
          Import
        </Button>
      </Foot>
    </>
  )
}

function TestView({ conn, onClose }: { conn: TokenConnector; onClose: () => void }) {
  const [out, setOut] = useState<any>(null)
  const [error, setError] = useState('')
  const [asked, setAsked] = useState(false)
  if (!asked) {
    setAsked(true)
    api('POST', `/api/settings/connectors/${encodeURIComponent(conn.id)}/test`, {}).then(setOut, (e) => setError(e.message))
  }
  return (
    <>
      <Head title={`Test ${conn.name}`} description="It runs the list action once. Nothing is changed." onClose={onClose} />
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        {!out && !error && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Reading {conn.name}…
          </p>
        )}
        {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
        {out && (
          <div className="grid gap-3">
            <p className="text-[13px]">
              <strong>{out.count} items.</strong> {out.cut_off && <span className="text-amber-700 dark:text-amber-400">{out.cut_off}</span>}
            </p>
            <ul className="divide-y divide-border/50 rounded-lg border border-border/70 text-xs">
              {out.skipped.map((s: string) => (
                <li key={s} className="px-3 py-1.5 text-destructive">
                  Skipped: {s}
                </li>
              ))}
              {out.items.map((i: any) => (
                <li key={i.id} className="flex gap-2 px-3 py-1.5">
                  <code className="shrink-0 font-mono text-muted-foreground">{i.id}</code>
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="text-muted-foreground">{i.state}</span>
                </li>
              ))}
            </ul>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">Fields you can keep</span>
              <div className="flex flex-wrap gap-1">
                {out.paths.map((p: string) => (
                  <code key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {p}
                  </code>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <Foot>
        <Button onClick={onClose}>Done</Button>
      </Foot>
    </>
  )
}

function ShareView({ conn, onClose }: { conn: TokenConnector; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [asked, setAsked] = useState(false)
  if (!asked) {
    setAsked(true)
    api<{ text: string }>('GET', `/api/settings/connectors/${encodeURIComponent(conn.id)}/share`).then((r) => setText(r.text), (e) => setError(e.message))
  }
  return (
    <>
      <Head title={`Share ${conn.name}`} description="This holds no secret values, only their names. Someone pastes it under Paste a shared connection." onClose={onClose} />
      <div className="min-h-0 flex-1 px-6 pb-4">
        {error ? <p className="text-xs text-destructive">{error}</p> : <textarea readOnly rows={14} value={text ?? 'Reading…'} spellCheck={false} className={cn(areaClass, 'h-full font-mono text-xs')} />}
      </div>
      <Foot>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        <Button disabled={!text} onClick={() => navigator.clipboard.writeText(text!).then(() => toast('Copied'))}>
          <Copy /> Copy
        </Button>
      </Foot>
    </>
  )
}

export function TokenDialog({
  start,
  list,
  starters,
  secrets,
  onClose
}: {
  start: TokenStart
  list: TokenConnector[]
  starters: Record<string, TokenConnector>
  secrets: string[]
  onClose: () => void
}) {
  const [view, setView] = useState<TokenStart | { view: 'done'; message: string }>(start)
  const toPick = start.view === 'pick' ? () => setView({ view: 'pick' }) : undefined
  const tall = view.view === 'edit' || view.view === 'pick'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn('flex max-h-[calc(100vh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl', tall && 'h-[min(46rem,calc(100vh-2rem))]')}>
        {view.view === 'pick' && <Picker starters={Object.entries(starters)} onPick={(c) => setView({ view: 'edit', conn: c, was: '' })} onImport={() => setView({ view: 'import' })} onClose={onClose} />}
        {view.view === 'edit' && <Editor conn={view.conn} was={view.was} list={list} secrets={secrets} onBack={view.was ? undefined : toPick} onDone={onClose} />}
        {view.view === 'import' && <Import onBack={() => setView({ view: 'pick' })} onClose={onClose} onDone={(message) => setView({ view: 'done', message })} />}
        {view.view === 'test' && <TestView conn={view.conn} onClose={onClose} />}
        {view.view === 'share' && <ShareView conn={view.conn} onClose={onClose} />}
        {view.view === 'done' && (
          <>
            <Head title="Imported" onClose={onClose} />
            <p className="flex items-start gap-2 px-6 pb-4 text-[13px]">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> {view.message}
            </p>
            <Foot>
              <Button onClick={onClose}>Done</Button>
            </Foot>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
