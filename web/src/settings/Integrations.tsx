// Integrations laid out as Orca lays them out (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, FlaskConical, MoreHorizontal, Share2, Check, CheckCircle2, Link2, ExternalLink, Github, Gitlab as GitlabIcon, KeyRound, LoaderCircle, Plug, Plus, Search, SquareKanban, Terminal, Trash2, Unlink, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'
import { TokenDialog, type TokenConnector, type TokenStart } from './TokenEditor'
import { areaClass, Field, Group, inputClass, Pill, Row, Section, type Tone } from './ui'

type Server = {
  name: string
  url: string
  command: string
  headers?: Record<string, string>
  env?: Record<string, string>
  machines?: string[]
  allow_private?: boolean
}
type Gitlab = { host: string; url?: string; token?: string }
export type SettingsData = {
  machines: { name: string }[]
  mcp_servers: Server[]
  mcp_auth: Record<string, string>
  secrets: { file?: string; list: { name: string; used_by: string[]; updated?: string }[]; missing: { server: string; name: string }[] }
  pull_requests: {
    value: {
      enabled: boolean
      cards: boolean
      review_sessions?: string
      poll_seconds: number
      merge_method?: string
      use_github?: boolean
      use_gitlab?: boolean
      github_via?: string
      github_token?: string
      gitlab_via?: string
      gitlab?: Gitlab[]
    }
    status: { github_checked: boolean; github_problem: string | null; hosts: Record<string, string | null>; machines: Record<string, string | null> }
  }
  keep_awake?: { mode: string; holding: boolean; error?: string | null; tool?: string }
  [k: string]: unknown
}
type Place = { label: string; template: string; default: string; choices: string[]; hint: string }
type Tool = {
  id: string
  name: string
  about: string
  url: string
  needs_client?: boolean
  tested?: boolean
  template?: boolean
  category?: string
  place?: Place | null
}
type Connector = TokenConnector
type Connectors = { list: Connector[]; sign_in: Tool[]; starters: Record<string, Connector>; status: Record<string, { ok: boolean; message?: string }> }

const secretRef = (name: string) => `\${secret:${name}}`
const SECRET_NAME = /authori[sz]ation|token|secret|api[-_]?key|password|private/i

function ProviderRow({
  icon,
  name,
  description,
  tone,
  status,
  actions,
  children
}: {
  icon: React.ReactNode
  name: string
  description: React.ReactNode
  tone: Tone
  status: string
  actions?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1 basis-[16rem] space-y-0.5">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {actions}
          <Pill tone={tone}>{status}</Pill>
        </div>
      </div>
      {children}
    </div>
  )
}

function Details({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 space-y-2 border-t border-border/60 pt-4">{children}</div>
}
const subRow = 'flex items-center gap-3 border-t border-border/40 py-2 text-xs first:border-t-0'
function CommandRow({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-3 py-2 font-mono text-xs">
      <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
      {command}
    </div>
  )
}
const open = (url: string) => window.open(url, '_blank', 'noopener')
type LinearAccount = { ok: boolean; connected: boolean; name?: string; email?: string; organization?: string; error?: string }

function Modal({
  title,
  description,
  onClose,
  children,
  wide,
  onBack
}: {
  title: string
  description?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
  onBack?: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn('max-h-[calc(100vh-2rem)] gap-4 overflow-y-auto', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <div className="flex items-start justify-between gap-3">
          {onBack && (
            <button
              type="button"
              aria-label="Back"
              onClick={onBack}
              className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <div className="grid min-w-0 flex-1 gap-1">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription className="text-xs leading-relaxed">{description}</DialogDescription>}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

async function keepSecret(data: SettingsData, name: string, value: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 60)
  const taken = new Set(data.secrets.list.map((s) => s.name))
  let clean = base
  for (let n = 2; taken.has(clean); n++) clean = `${base}-${n}`
  await api('POST', '/api/settings/secrets', { name: clean, value })
  return secretRef(clean)
}

function GithubDialog({ data, onClose, onSaved }: { data: SettingsData; onClose: () => void; onSaved: () => void }) {
  const v = data.pull_requests.value
  const s = data.pull_requests.status
  const [use, setUse] = useState(v.use_github !== false)
  const [via, setVia] = useState(v.github_via || 'gh')
  const [token, setToken] = useState(v.github_token || '')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      let chosen = token
      if (paste.trim()) {
        await api('POST', '/api/settings/secrets', { name: 'github_pr', value: paste.trim() })
        chosen = secretRef('github_pr')
      }
      await api('POST', '/api/settings/pull-requests', { ...pullBody(data), use_github: use, github_via: via, github_token: chosen })
      toast('GitHub updated')
      onSaved()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="GitHub" description="Pull requests and CI on sessions, and what pipelines push." onClose={onClose}>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        Show GitHub pull requests on sessions <Switch checked={use} onCheckedChange={setUse} />
      </label>
      <div role="radiogroup" aria-label="How it connects" className="grid gap-2">
        {(
          [
            [
              'gh',
              'Local gh',
              <>
                Yardbell asks <code>gh</code> on each session's machine. Each machine needs it installed and signed in with <code>gh auth login</code>.
              </>
            ],
            ['token', 'A token', "Yardbell asks GitHub's API from here, so machines need nothing installed. For github.com only."]
          ] as const
        ).map(([value, label, help]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={via === value}
            onClick={() => setVia(value)}
            className={cn(
              'grid gap-0.5 rounded-lg border p-3 text-left',
              via === value ? 'border-foreground ring-2 ring-foreground/10' : 'border-border hover:border-foreground/30'
            )}
          >
            <span className="text-[13px] font-medium">{label}</span>
            <span className="text-xs text-muted-foreground [&_code]:font-mono">{help}</span>
          </button>
        ))}
      </div>
      {via === 'token' ? (
        <div className="grid gap-3">
          <Field label="Saved secret">
            <select value={token} onChange={(e) => setToken(e.target.value)} className={inputClass}>
              <option value="">{data.secrets.list.length ? 'Pick a saved secret' : 'No saved secrets yet'}</option>
              {data.secrets.list.map((x) => (
                <option key={x.name} value={secretRef(x.name)}>
                  {secretRef(x.name)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Or paste a new token"
            hint="Saved as the secret github_pr. It needs read access to pull requests, checks and actions, and write access to pull requests if a pipeline opens drafts."
          >
            <input
              type="password"
              autoComplete="new-password"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Paste a token"
              className={inputClass}
            />
          </Field>
        </div>
      ) : (
        <ul className="grid gap-1 rounded-lg border border-border p-3 text-xs">
          {data.machines.map((m) => {
            const seen = Object.hasOwn(s.machines, m.name)
            const problem = s.machines[m.name]
            return (
              <li key={m.name} className="flex gap-2">
                <span
                  className={cn('mt-1 size-1.5 shrink-0 rounded-full', problem ? 'bg-destructive' : seen ? 'bg-status-success' : 'bg-muted-foreground/40')}
                />
                <span>
                  <b className="font-medium">{m.name}</b> <span className="text-muted-foreground">{problem || (seen ? 'gh works' : 'Not checked yet')}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={save}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

function pullBody(data: SettingsData) {
  const v = data.pull_requests.value
  return {
    enabled: v.enabled,
    cards: v.cards,
    review_sessions: v.review_sessions || 'off',
    use_github: v.use_github !== false,
    use_gitlab: v.use_gitlab !== false,
    poll_seconds: v.poll_seconds,
    merge_method: v.merge_method || 'merge',
    github_via: v.github_via || 'gh',
    github_token: v.github_token || '',
    gitlab_via: v.gitlab_via || 'token',
    gitlab: (v.gitlab || []).map((g) => ({ host: g.host, ...(g.url ? { url: g.url } : {}), token: g.token }))
  }
}

function GitlabDialog({ data, onClose, onSaved }: { data: SettingsData; onClose: () => void; onSaved: () => void }) {
  const v = data.pull_requests.value
  const status = data.pull_requests.status.hosts
  const [use, setUse] = useState(v.use_gitlab !== false)
  const [via, setVia] = useState(v.gitlab_via || 'token')
  const [hosts, setHosts] = useState<(Gitlab & { paste?: string })[]>((v.gitlab || []).map((g) => ({ host: g.host, url: g.url || '', token: g.token })))
  const [busy, setBusy] = useState(false)
  const set = (i: number, change: Partial<Gitlab & { paste?: string }>) => setHosts((h) => h.map((x, j) => (j === i ? { ...x, ...change } : x)))
  const save = async () => {
    setBusy(true)
    try {
      const out: Gitlab[] = []
      for (const g of hosts) {
        let token = g.token
        if (g.paste?.trim()) token = await keepSecret(data, `gitlab_${g.host.trim()}`, g.paste.trim())
        out.push({ host: g.host.trim(), ...(g.url?.trim() ? { url: g.url.trim() } : {}), token })
      }
      await api('POST', '/api/settings/pull-requests', { ...pullBody(data), use_gitlab: use, gitlab_via: via, gitlab: out })
      toast('GitLab updated')
      onSaved()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="GitLab" description="Merge requests and CI on sessions, for each GitLab server your folders use." onClose={onClose} wide>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        Show GitLab merge requests on sessions <Switch checked={use} onCheckedChange={setUse} />
      </label>
      <div role="radiogroup" aria-label="How it connects" className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        {(
          [
            [
              'token',
              'A token for each host',
              <>
                Yardbell asks GitLab's API from here. The token needs <code>read_api</code>; opening or merging merge requests needs <code>api</code>.
              </>
            ],
            [
              'glab',
              'Local glab',
              <>
                Yardbell asks <code>glab</code> on each session's machine, signed in with <code>glab auth login</code>.
              </>
            ]
          ] as const
        ).map(([value, label, help]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={via === value}
            onClick={() => setVia(value)}
            className={cn(
              'grid gap-0.5 rounded-lg border p-3 text-left',
              via === value ? 'border-foreground ring-2 ring-foreground/10' : 'border-border hover:border-foreground/30'
            )}
          >
            <span className="text-[13px] font-medium">{label}</span>
            <span className="text-xs text-muted-foreground [&_code]:font-mono">{help}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">Hosts</span>
        <Button size="xs" variant="outline" onClick={() => setHosts([...hosts, { host: '', url: '', token: '' }])}>
          <Plus /> Add GitLab host
        </Button>
      </div>
      {!hosts.length && <p className="text-xs text-muted-foreground">No GitLab hosts yet, so merge requests do not show.</p>}
      {hosts.map((g, i) => {
        const key = g.host.trim().toLowerCase()
        const problem = status[key]
        return (
          <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
            <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
              <Field label="Host, as in the remote address">
                <input
                  value={g.host}
                  onChange={(e) => set(i, { host: e.target.value })}
                  placeholder="git.example.com"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <Field label="Address, only if it differs">
                <input
                  value={g.url}
                  onChange={(e) => set(i, { url: e.target.value })}
                  placeholder="https://git.example.com:8443"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              {via === 'token' && (
                <>
                  <Field label="Saved token">
                    <select value={g.token || ''} onChange={(e) => set(i, { token: e.target.value })} className={inputClass}>
                      <option value="">{data.secrets.list.length ? 'Pick a saved secret' : 'No saved secrets yet'}</option>
                      {g.token && !data.secrets.list.some((x) => secretRef(x.name) === g.token) && (
                        <option value={g.token}>{g.token === '(hidden)' ? 'Typed into yardbell.yml, kept' : g.token}</option>
                      )}
                      {data.secrets.list.map((x) => (
                        <option key={x.name} value={secretRef(x.name)}>
                          {secretRef(x.name)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Or paste a token">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={g.paste || ''}
                      onChange={(e) => set(i, { paste: e.target.value })}
                      placeholder="Saved as a secret"
                      className={inputClass}
                    />
                  </Field>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className={problem ? 'text-destructive' : 'text-muted-foreground'}>
                {problem || (Object.hasOwn(status, key) ? 'The token works' : 'Not checked yet')}
              </span>
              <Button size="xs" variant="ghost-destructive" onClick={() => setHosts(hosts.filter((_, j) => j !== i))}>
                Remove host
              </Button>
            </div>
          </div>
        )
      })}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={save}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

function LinearDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title="Linear"
      description="Pipelines and triggers read and move Linear tickets with a personal API key. Make one in Linear under Settings, Security and access. Yardbell checks it with Linear before saving it."
      onClose={onClose}
    >
      <Field label="Personal API key" hint="Saved as the secret linear.">
        <input
          type="password"
          autoComplete="new-password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="lin_api_..."
          className={inputClass}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || !key.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              const who = await api<LinearAccount>('POST', '/api/settings/linear/check', { key: key.trim() })
              if (!who.ok) throw new Error(who.error || 'Linear refused this API key')
              await api('POST', '/api/settings/secrets', { name: 'linear', value: key.trim() })
              toast(`Linear connected: ${who.organization}`)
              onSaved()
              onClose()
            } catch (e) {
              toast.error((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Checking…' : 'Connect'}
        </Button>
      </div>
    </Modal>
  )
}

const serverPath = (name: string, action: string) => `/api/settings/mcp/servers/${encodeURIComponent(name)}/${action}`
const signsInHere = () => ['127.0.0.1', 'localhost'].includes(location.hostname)

type Flow =
  | { step: 'pick' }
  | { step: 'server' }
  | { step: 'place'; tool: Tool }
  | { step: 'finding'; name: string }
  | { step: 'client'; name: string; host: string; redirect: string }
  | { step: 'sign-in'; name: string; host: string; url: string }
  | { step: 'checking'; name: string }
  | { step: 'tools'; name: string; tools: { name: string; description: string }[]; error?: string }

function ConnectFlow({
  data,
  connectors,
  start,
  onClose,
  onToken,
  reload
}: {
  data: SettingsData
  connectors: Connectors | null
  start: Flow
  onClose: () => void
  onToken: (id: string) => void
  reload: () => Promise<SettingsData | null>
}) {
  const [flow, setFlow] = useState<Flow>(start)
  const [find, setFind] = useState('')
  const [error, setError] = useState('')
  const [address, setAddress] = useState('')
  const [client, setClient] = useState({ id: '', secret: '' })
  const [server, setServer] = useState({
    url: '',
    name: '',
    token: '',
    pairs: '',
    machines: [] as string[],
    allowPrivate: false,
    kind: 'url' as 'url' | 'command',
    command: ''
  })
  const polling = useRef<number | null>(null)
  useEffect(() => () => void (polling.current && clearInterval(polling.current)), [])
  // Opened at a server's sign-in or test, that step starts at once.
  useEffect(() => {
    if (start.step === 'finding') signIn(start.name).catch((e) => setError(e.message))
    if (start.step === 'checking') showTools(start.name)
  }, [])

  const showTools = async (name: string) => {
    setFlow({ step: 'checking', name })
    try {
      const out = await api<{ tools: { name: string; description: string }[] }>('POST', serverPath(name, 'test'))
      setFlow({ step: 'tools', name, tools: out.tools })
    } catch (e) {
      setFlow({ step: 'tools', name, tools: [], error: (e as Error).message })
    }
    reload()
  }

  const signIn = async (name: string, withClient?: { client_id: string; client_secret: string }) => {
    setError('')
    if (!withClient) setFlow({ step: 'finding', name })
    const out = await api<{ needs_sign_in?: boolean; needs_client?: boolean; sign_in_host: string; redirect: string; url: string }>(
      'POST',
      serverPath(name, 'sign-in'),
      withClient || {}
    )
    if (out.needs_sign_in === false) return showTools(name)
    if (out.needs_client) return setFlow({ step: 'client', name, host: out.sign_in_host, redirect: out.redirect })
    setFlow({ step: 'sign-in', name, host: out.sign_in_host, url: out.url })
    if (polling.current) clearInterval(polling.current)
    polling.current = window.setInterval(async () => {
      const fresh = await reload()
      if (fresh?.mcp_auth?.[name] === 'signed_in') {
        clearInterval(polling.current!)
        polling.current = null
        showTools(name)
      }
    }, 3000)
  }

  const connect = async (tool: Tool, place?: string) => {
    setError('')
    if (tool.place && place === undefined) return setFlow({ step: 'place', tool })
    try {
      const out = await api<{ signed_in: boolean; server: string }>('POST', '/api/settings/connectors/connect', { template: tool.id, place })
      await reload()
      if (out.signed_in) showTools(out.server)
      else await signIn(out.server)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const addServer = async () => {
    setError('')
    try {
      const isUrl = server.kind === 'url'
      if (isUrl && !/^https?:\/\/[^\s/]+/.test(server.url.trim())) throw new Error('Paste a full address, starting with https://')
      if (!isUrl && !server.command.trim()) throw new Error('Type the command that starts the server.')
      const taken = new Set(data.mcp_servers.map((s) => s.name))
      let name = server.name.trim()
      if (!name) {
        const base = isUrl
          ? (new URL(server.url.trim()).hostname.split('.').filter((w) => !['mcp', 'api', 'www'].includes(w))[0] || 'server').replace(/[^A-Za-z0-9_-]/g, '-')
          : server.command
              .trim()
              .split(/\s+/)
              .pop()!
              .replace(/[^A-Za-z0-9_-]/g, '-')
        name = base
        for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
      }
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('A name can only hold letters, digits, - and _.')
      const pairs: Record<string, string> = {}
      for (const line of server.pairs.split('\n')) {
        if (!line.trim()) continue
        const at = line.indexOf('=')
        if (at < 1) throw new Error(`"${line.trim()}" needs to look like NAME=value`)
        const k = line.slice(0, at).trim()
        const value = line.slice(at + 1).trim()
        pairs[k] = SECRET_NAME.test(k) && value && !value.includes('${secret:') ? await keepSecret(data, `${name}_${k}`, value) : value
      }
      if (isUrl && server.token.trim()) pairs.Authorization = `Bearer ${await keepSecret(data, `${name}_token`, server.token.trim())}`
      const entry: Server = {
        name,
        command: isUrl ? '' : server.command.trim(),
        url: isUrl ? server.url.trim() : '',
        env: isUrl ? {} : pairs,
        headers: isUrl ? pairs : {},
        machines: server.machines,
        allow_private: isUrl && server.allowPrivate
      }
      await api('POST', '/api/settings/mcp/servers', { servers: [...data.mcp_servers, entry] })
      await reload()
      if (isUrl && !Object.keys(pairs).length) await signIn(name)
      else showTools(name)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (flow.step === 'pick')
    return (
      <Catalog
        data={data}
        tools={connectors?.sign_in || []}
        error={error}
        onClose={onClose}
        onAdd={(t) => connect(t)}
        onSignIn={(name) => signIn(name).catch((e) => setError(e.message))}
        onTools={showTools}
        onByUrl={() => (setError(''), setFlow({ step: 'server' }))}
        onToken={onToken}
      />
    )
  const back = ['server', 'place', 'client', 'sign-in'].includes(flow.step) ? () => (setError(''), setFlow({ step: 'pick' })) : undefined
  const title =
    flow.step === 'server'
      ? 'Add by URL'
      : flow.step === 'place'
        ? `Add ${flow.tool.name}`
        : flow.step === 'tools'
          ? `Connected to ${flow.name}`
          : `Sign in to ${flow.name}`
  return (
    <Modal title={title} onClose={onClose} onBack={back} wide>
      {flow.step === 'place' && <PlaceStep tool={flow.tool} onCancel={back!} onAdd={(v) => connect(flow.tool, v)} />}
      {flow.step === 'server' && (
        <div className="grid gap-3">
          <div className="flex gap-2">
            {(
              [
                ['url', 'At a web address'],
                ['command', 'As a command on the machine']
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setServer({ ...server, kind: k })}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs',
                  server.kind === k ? 'border-foreground bg-accent' : 'border-border text-muted-foreground'
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {server.kind === 'url' ? (
            <Field label="Address" hint="Paste the address from the tool's docs. You will sign in next if it needs it.">
              <input
                value={server.url}
                onChange={(e) => setServer({ ...server, url: e.target.value })}
                inputMode="url"
                placeholder="https://mcp.linear.app/mcp"
                autoCapitalize="off"
                spellCheck={false}
                className={inputClass}
              />
            </Field>
          ) : (
            <Field label="Command" hint="Yardbell starts this command on the machine, and passes it the environment below.">
              <input
                value={server.command}
                onChange={(e) => setServer({ ...server, command: e.target.value })}
                placeholder="npx -y @modelcontextprotocol/server-github"
                autoCapitalize="off"
                spellCheck={false}
                className={inputClass}
              />
            </Field>
          )}
          <details className="grid gap-3 rounded-lg border border-border p-3 [&[open]>summary]:mb-3">
            <summary className="cursor-pointer text-xs font-medium">More options</summary>
            <div className="grid gap-3">
              <Field label="Name">
                <input
                  value={server.name}
                  onChange={(e) => setServer({ ...server, name: e.target.value })}
                  placeholder="Taken from the address"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              {server.kind === 'url' && (
                <Field label="Token" hint="Leave this empty to sign in through your browser. A token is saved as a secret and sent as Authorization: Bearer.">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={server.token}
                    onChange={(e) => setServer({ ...server, token: e.target.value })}
                    placeholder="Only if the tool gave you one"
                    className={inputClass}
                  />
                </Field>
              )}
              <Field
                label={server.kind === 'url' ? 'Headers' : 'Environment variables'}
                hint="One per line, as NAME=value. A token here is saved as a secret by itself."
              >
                <textarea
                  rows={3}
                  value={server.pairs}
                  onChange={(e) => setServer({ ...server, pairs: e.target.value })}
                  placeholder="GITHUB_TOKEN=paste it here"
                  spellCheck={false}
                  className={cn(areaClass, 'font-mono text-xs')}
                />
              </Field>
              <div className="grid gap-1">
                <span className="text-xs font-medium">Machines</span>
                <div className="flex flex-wrap gap-3">
                  {data.machines.map((m) => (
                    <label key={m.name} className="inline-flex items-center gap-1.5 text-[13px]">
                      <input
                        type="checkbox"
                        checked={server.machines.includes(m.name)}
                        onChange={(e) =>
                          setServer({ ...server, machines: e.target.checked ? [...server.machines, m.name] : server.machines.filter((x) => x !== m.name) })
                        }
                        className="size-3.5 accent-foreground"
                      />
                      {m.name}
                    </label>
                  ))}
                </div>
                <small className="text-[11.5px] text-muted-foreground">
                  Agent sessions on these machines get this connection. None picked means every machine.
                </small>
              </div>
              {server.kind === 'url' && (
                <label className="inline-flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={server.allowPrivate}
                    onChange={(e) => setServer({ ...server, allowPrivate: e.target.checked })}
                    className="size-3.5 accent-foreground"
                  />
                  Allow private addresses, for a server on this machine or your mesh
                </label>
              )}
            </div>
          </details>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
            <Button onClick={addServer}>Add</Button>
          </div>
        </div>
      )}
      {(flow.step === 'finding' || flow.step === 'checking') && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />{' '}
          {flow.step === 'finding' ? `Finding where ${flow.name} signs you in. This can take a few seconds.` : 'Checking what it can do.'}
        </p>
      )}
      {flow.step === 'client' && (
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            {flow.host} does not let Yardbell register itself. Make an app in its developer console with this redirect address, then enter what it gives you.
          </p>
          <code className="rounded-md bg-muted p-2 font-mono text-[11px] break-all">{flow.redirect}</code>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Client ID">
              <input
                value={client.id}
                onChange={(e) => setClient({ ...client, id: e.target.value })}
                autoCapitalize="off"
                spellCheck={false}
                className={inputClass}
              />
            </Field>
            <Field label="Client secret">
              <input
                type="password"
                value={client.secret}
                onChange={(e) => setClient({ ...client, secret: e.target.value })}
                autoComplete="new-password"
                className={inputClass}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => signIn(flow.name, { client_id: client.id, client_secret: client.secret }).catch((e) => setError(e.message))}>
              Continue
            </Button>
          </div>
        </div>
      )}
      {flow.step === 'sign-in' && (
        <div className="grid gap-3">
          <p className="text-[13px]">You will sign in at {flow.host}. Yardbell notices when you are done.</p>
          {!signsInHere() && (
            <>
              <p className="text-xs text-muted-foreground">
                You are on another device. {flow.host} sends you back to 127.0.0.1, which on this device is not Yardbell, so that page will not load. Copy its
                address and paste it here.
              </p>
              <Field label="Address of the page that did not load">
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  inputMode="url"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <a
              href={flow.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm font-medium',
                signsInHere() ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border border-border hover:bg-accent'
              )}
            >
              Continue <ExternalLink className="size-3.5" />
            </a>
            {!signsInHere() && (
              <Button
                disabled={!address.trim()}
                onClick={async () => {
                  try {
                    await api('POST', serverPath(flow.name, 'finish'), { address })
                    showTools(flow.name)
                  } catch (e) {
                    setError((e as Error).message)
                  }
                }}
              >
                Finish signing in
              </Button>
            )}
          </div>
        </div>
      )}
      {flow.step === 'tools' && (
        <div className="grid gap-3">
          {flow.error ? (
            <p className="text-xs text-destructive">It did not answer the check: {flow.error}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                It offers {flow.tools.length} {flow.tools.length === 1 ? 'tool' : 'tools'}. None were called.
              </p>
              <ul className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border border-border p-2 text-xs">
                {flow.tools.map((t) => (
                  <li key={t.name} className="grid gap-0.5 px-1 py-1">
                    <code className="font-mono font-medium">{t.name}</code>
                    <span className="text-muted-foreground">{t.description}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </Modal>
  )
}

const CATEGORIES: [string, string][] = [
  ['coding', 'Coding'],
  ['docs', 'Docs and projects'],
  ['chat', 'Chat'],
  ['monitoring', 'Monitoring'],
  ['sales', 'Sales and support'],
  ['design', 'Design']
]
const BRAND: Record<string, string> = {
  trello: '#0C66E4',
  jira: '#1868DB',
  linear: '#5E6AD2',
  github: '#24292F',
  gitlab: '#E24329',
  notion: '#191919',
  slack: '#4A154B',
  asana: '#F06A6A',
  clickup: '#7B68EE',
  monday: '#FF3D57',
  sentry: '#362D59',
  datadog: '#632CA6',
  pagerduty: '#06AC38',
  posthog: '#F54E00',
  vercel: '#000000',
  supabase: '#3ECF8E',
  stripe: '#635BFF',
  figma: '#A259FF',
  hubspot: '#FF7A59',
  intercom: '#1F8DED',
  airtable: '#18BFFF',
  zapier: '#FF4F00',
  dropbox: '#0061FE'
}

function ToolLogo({ id, name }: { id?: string; name: string }) {
  const color = id ? BRAND[id] : undefined
  return (
    <span
      aria-hidden="true"
      style={color ? { background: color } : undefined}
      className={cn('grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold', color ? 'text-white' : 'border border-border bg-muted text-muted-foreground')}
    >
      {color ? name.charAt(0).toUpperCase() : <Link2 className="size-4" />}
    </span>
  )
}

function Catalog({
  data,
  tools,
  error,
  onClose,
  onAdd,
  onSignIn,
  onTools,
  onByUrl,
  onToken
}: {
  data: SettingsData
  tools: Tool[]
  error: string
  onClose: () => void
  onAdd: (t: Tool) => void
  onSignIn: (server: string) => void
  onTools: (server: string) => void
  onByUrl: () => void
  onToken: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all')
  const [busy, setBusy] = useState('')
  const serverOf = (t: Tool) => data.mcp_servers.find((s) => s.url === t.url || (t.place && s.name === t.id))
  const own = data.mcp_servers.filter((s) => !tools.some((t) => serverOf(t)?.name === s.name))
  const q = query.trim().toLowerCase()
  const match = (text: string) => !q || text.toLowerCase().includes(q)
  const shown = tools.filter((t) => match(`${t.name} ${t.about}`) && (view === 'all' || (view === 'added' ? serverOf(t) : t.category === view)))
  const ownShown = view === 'all' || view === 'added' ? own.filter((s) => match(`${s.name} ${s.url} ${s.command}`)) : []
  const added = tools.filter(serverOf).length + own.length
  const chip = (on: boolean) =>
    cn('inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-3 text-xs transition-colors', on ? 'border-foreground/25 bg-accent font-medium text-foreground' : 'border-border text-muted-foreground hover:text-foreground')
  const run = async (key: string, fn: () => unknown) => {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy('')
    }
  }
  const state = (server?: Server) => {
    if (!server) return null
    const st = data.mcp_auth?.[server.name]
    if (server.command || Object.keys(server.headers || {}).length || st === 'signed_in') return 'ready'
    return st === 'expired' ? 'expired' : 'signin'
  }
  const action = (key: string, server: Server | undefined, add?: () => void) => {
    const st = state(server)
    if (st === 'ready')
      return (
        <Button size="xs" variant="ghost" onClick={() => onTools(server!.name)} className="text-emerald-700 dark:text-emerald-400">
          <Check /> Added
        </Button>
      )
    if (st)
      return (
        <Button size="xs" variant="outline" disabled={busy === key} onClick={() => run(key, () => onSignIn(server!.name))}>
          {busy === key && <LoaderCircle className="animate-spin" />} {st === 'expired' ? 'Sign in again' : 'Sign in'}
        </Button>
      )
    return (
      <Button size="xs" variant="outline" disabled={busy === key} onClick={() => run(key, add!)}>
        {busy === key ? <LoaderCircle className="animate-spin" /> : <Plus />} Add
      </Button>
    )
  }
  const groups = view === 'all' ? CATEGORIES.map(([k, l]) => [l, shown.filter((t) => t.category === k)] as const).filter(([, l]) => l.length) : [['', shown] as const]
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(44rem,calc(100vh-2rem))] flex-col gap-0 p-0 sm:max-w-3xl">
        <div className="flex h-16 shrink-0 items-center gap-2 pr-4 pl-6">
          <DialogTitle className="min-w-0 flex-1">Connect a tool</DialogTitle>
          <DialogDescription className="sr-only">Tools your agent sessions and pipelines can use, signed in with your own account.</DialogDescription>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="grid shrink-0 gap-3 px-6">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tools"
                aria-label="Search tools"
                className="h-9 w-full rounded-md border border-input bg-background pr-2 pl-8.5 text-[13px] outline-none"
              />
            </div>
            <Button variant="outline" className="h-9" onClick={onByUrl}>
              <Plus /> Add by URL
            </Button>
          </div>
          <div className="scrollbar-sleek -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')} className={chip(view === 'all')}>
              All
            </button>
            <button type="button" aria-pressed={view === 'added'} onClick={() => setView('added')} className={chip(view === 'added')}>
              Added {added > 0 && <span className="tabular-nums text-muted-foreground">{added}</span>}
            </button>
            {CATEGORIES.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)} className={chip(view === k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p role="alert" className="mx-6 mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="scrollbar-sleek mt-1 min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {ownShown.length > 0 && (
            <section className="mt-3">
              <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Added by you</h3>
              {ownShown.map((s) => (
                <div key={s.name} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/40">
                  <ToolLogo name={s.name} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{s.name}</p>
                    <p className="truncate font-mono text-[11.5px] text-muted-foreground">{s.url || s.command}</p>
                  </div>
                  {action(`own-${s.name}`, s)}
                </div>
              ))}
            </section>
          )}
          {groups.map(([label, list]) => (
            <section key={label || 'list'} className="mt-3">
              {label && <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>}
              {list.map((t) => {
                const server = serverOf(t)
                return (
                  <div key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/40">
                    <ToolLogo id={t.id} name={t.name} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-[13px] font-medium">
                        {t.name}
                        {t.needs_client && !server && (
                          <span title="Needs an app made in its developer console first" className="rounded-full border border-border px-1.5 text-[10px] leading-4 font-normal text-muted-foreground">
                            Own app
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{t.about}</p>
                    </div>
                    {t.template && !server && (
                      <button type="button" onClick={() => onToken(t.id)} className="shrink-0 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                        Use a token
                      </button>
                    )}
                    {action(t.id, server, () => onAdd(t))}
                  </div>
                )
              })}
            </section>
          ))}
          {!shown.length && !ownShown.length && (
            <div className="grid justify-items-center gap-2 py-12 text-center">
              <p className="text-[13px] font-medium">{view === 'added' && !q ? 'Nothing added yet' : `No tool matches "${query}"`}</p>
              <p className="max-w-sm text-xs text-muted-foreground">Any tool with an MCP server can be added by its address or the command that starts it.</p>
              <Button size="sm" variant="outline" onClick={onByUrl}>
                <Plus /> Add by URL
              </Button>
            </div>
          )}
        </div>
        <p className="shrink-0 border-t border-border/50 px-6 py-2.5 text-[11.5px] text-muted-foreground">
          You sign in in your browser with your own account. Agent sessions get every tool added here and sign in on their own machine.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function PlaceStep({ tool, onCancel, onAdd }: { tool: Tool; onCancel: () => void; onAdd: (place: string) => void }) {
  const p = tool.place!
  const [value, setValue] = useState(p.default)
  const url = p.template.replace('{}', value.trim() || p.default)
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <ToolLogo id={tool.id} name={tool.name} />
        <p className="text-xs text-muted-foreground">{tool.about}</p>
      </div>
      <Field label={p.label} hint={p.hint}>
        {p.choices.length ? (
          <select value={value} onChange={(e) => setValue(e.target.value)} className={inputClass}>
            {p.choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="off" spellCheck={false} className={inputClass} />
        )}
      </Field>
      <p className="truncate font-mono text-[11.5px] text-muted-foreground">{url}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button onClick={() => onAdd(value.trim())}>Add</Button>
      </div>
    </div>
  )
}

function SecretDialog({ name, onClose, onSaved }: { name?: string; onClose: () => void; onSaved: () => void }) {
  const [n, setN] = useState(name || '')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={name ? `Replace ${name}` : 'Add secret'}
      description="A value is never shown again, and only your account can read secrets.yml."
      onClose={onClose}
    >
      <Field label="Name">
        <input
          value={n}
          disabled={Boolean(name)}
          onChange={(e) => setN(e.target.value)}
          pattern="[A-Za-z0-9_\-]+"
          maxLength={64}
          placeholder="linear"
          autoCapitalize="off"
          spellCheck={false}
          className={inputClass}
        />
      </Field>
      <Field label="Value">
        <input
          type="password"
          autoFocus={Boolean(name)}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || !/^[A-Za-z0-9_-]+$/.test(n) || !value}
          onClick={async () => {
            setBusy(true)
            try {
              await api('POST', '/api/settings/secrets', { name: n, value })
              toast(`Saved ${n}`)
              onSaved()
              onClose()
            } catch (e) {
              toast.error((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Save secret
        </Button>
      </div>
    </Modal>
  )
}

export function Integrations({ data, reload }: { data: SettingsData; reload: () => Promise<SettingsData | null> }) {
  const [connectors, setConnectors] = useState<Connectors | null>(null)
  const [dialog, setDialog] = useState<null | 'github' | 'gitlab' | 'linear' | { token: TokenStart } | { flow: Flow } | { secret?: string }>(null)
  const [folders, setFolders] = useState<{
    folders: { machine: string; folder: string; service: string; host?: string | null }[]
    unreachable: { machine: string; why: string }[]
  } | null>(null)
  const [busy, setBusy] = useState('')
  const loadConnectors = () => api<Connectors>('GET', '/api/settings/connectors').then(setConnectors, () => setConnectors(null))
  useEffect(() => {
    loadConnectors()
    api<typeof folders>('GET', '/api/settings/pull-requests/folders').then(setFolders, (e) =>
      setFolders({ folders: [], unreachable: [{ machine: 'Yardbell', why: e.message }] })
    )
  }, [])
  const refresh = async () => {
    await reload()
    loadConnectors()
  }
  const [linear, setLinear] = useState<LinearAccount | null>(null)
  const [linearTest, setLinearTest] = useState<'' | 'testing' | 'ok'>('')
  const hasLinear = data.secrets.list.some((x) => x.name === 'linear')
  useEffect(() => {
    if (!hasLinear) return setLinear(null)
    api<LinearAccount>('POST', '/api/settings/linear/check', {}).then(setLinear, (e) => setLinear({ ok: false, connected: true, error: e.message }))
  }, [hasLinear])

  const v = data.pull_requests.value
  const s = data.pull_requests.status
  const githubToken = v.github_via === 'token'
  const githubProblem = githubToken ? s.github_problem : Object.values(s.machines).find(Boolean) || null
  const githubChecked = githubToken ? s.github_checked : Object.keys(s.machines).length > 0
  const hosts = v.gitlab || []
  const gitlabProblem = hosts.length ? Object.values(s.hosts).find(Boolean) || null : null
  const linearKey = data.secrets.list.some((x) => x.name === 'linear')
  const forge = (on: boolean, problem: string | null, checked: boolean, missing?: string): [Tone, string] =>
    missing
      ? ['attention', missing]
      : !on
        ? ['neutral', 'Switched off']
        : problem
          ? /not installed or not signed in/.test(problem)
            ? ['attention', 'Not authenticated']
            : ['bad', 'Failing']
          : checked
            ? ['connected', 'Connected']
            : ['neutral', 'Not checked']
  const [ghTone, ghWord] = forge(v.use_github !== false, githubProblem, githubChecked)
  const [glTone, glWord] = forge(v.use_gitlab !== false, gitlabProblem, Object.keys(s.hosts).length > 0, hosts.length ? undefined : 'No hosts')

  const savePull = async (change: Record<string, unknown>) => {
    try {
      await api('POST', '/api/settings/pull-requests', { ...pullBody(data), ...change })
      toast('Saved')
      reload()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await work()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
      refresh()
    }
  }

  const authTone = (name: string): [Tone, string] => {
    const st = data.mcp_auth?.[name]
    if (st === 'signed_in') return ['connected', 'Signed in']
    if (st === 'sign_in_again') return ['bad', 'Sign in again']
    if (st === 'not_signed_in') return ['attention', 'Not signed in']
    return ['neutral', 'Not checked']
  }
  const own = (connectors?.list || []).filter((c) => !c.server)
  const recheck = () => act('recheck', () => api('POST', '/refresh', {}))
  const testLinear = async () => {
    setLinearTest('testing')
    const who = await api<LinearAccount>('POST', '/api/settings/linear/check', {}).catch((e) => ({ ok: false, connected: true, error: e.message }) as LinearAccount)
    setLinear(who)
    setLinearTest(who.ok ? 'ok' : '')
  }

  return (
    <Section title="Integrations" description="The code hosts, trackers and tools Yardbell, its pipelines and your agent sessions can reach.">
      <Group title="Review providers" description="The source hosts Yardbell uses for pull requests, merge requests, checks and review status on sessions, and what pipelines push.">
        <ProviderRow
          icon={<Github className="size-5" />}
          name="GitHub"
          description={
            githubToken ? (
              'Pull requests, checks and reviews through a token, asked from this machine.'
            ) : (
              <>
                Pull requests, checks and reviews via the <span className="font-mono text-[11px]">gh</span> CLI on each session's machine.
              </>
            )
          }
          tone={ghTone}
          status={ghWord}
          actions={
            <Button size="sm" variant="outline" onClick={() => setDialog('github')}>
              Set up
            </Button>
          }
        >
          {v.use_github !== false && (
            <Details>
              {githubToken ? (
                <div className={subRow}>
                  <KeyRound className="size-3.5 text-muted-foreground" />
                  <span className="flex-1">Token {v.github_token ? <code className="font-mono">{v.github_token}</code> : 'not set'}</span>
                  {s.github_problem ? <span className="text-destructive">{s.github_problem}</span> : s.github_checked ? <span className="text-status-success-text">Working</span> : null}
                </div>
              ) : (
                <>
                  <div>
                    {Object.keys(s.machines).length === 0 && <p className="text-xs text-muted-foreground">Not checked yet. Yardbell asks gh when a session has a branch.</p>}
                    {Object.entries(s.machines).map(([m, why]) => (
                      <div key={m} className={subRow}>
                        <span className="w-28 shrink-0 truncate font-medium">{m}</span>
                        {why ? (
                          <span className="flex min-w-0 items-center gap-1 text-destructive">
                            <AlertCircle className="size-3.5 shrink-0" />
                            <span className="truncate">{why}</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-status-success-text">
                            <CheckCircle2 className="size-3.5" /> gh signed in
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  {githubProblem && (
                    <>
                      <p className="text-xs text-muted-foreground">Install the GitHub CLI on that machine, then sign it in. Run this in a terminal there:</p>
                      <CommandRow command="gh auth login" />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => open('https://cli.github.com')}>
                          <ExternalLink /> Install GitHub CLI
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => open('https://cli.github.com/manual/gh_auth_login')}>
                          <ExternalLink /> Learn more
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy === 'recheck'} onClick={recheck}>
                          Re-check
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
            </Details>
          )}
        </ProviderRow>
        <ProviderRow
          icon={<GitlabIcon className="size-5" />}
          name="GitLab"
          description="Merge requests, pipelines and approvals for each GitLab server your folders push to."
          tone={glTone}
          status={glWord}
          actions={
            <Button size="sm" variant={hosts.length ? 'outline' : 'default'} onClick={() => setDialog('gitlab')}>
              {hosts.length ? 'Set up' : 'Add a host'}
            </Button>
          }
        >
          {hosts.length > 0 && v.use_gitlab !== false && (
            <Details>
              <div>
                {hosts.map((h) => {
                  const why = s.hosts[h.host]
                  const checked = h.host in s.hosts
                  return (
                    <div key={h.host} className={subRow}>
                      <span className="w-40 shrink-0 truncate font-medium">{h.host}</span>
                      {why ? (
                        <span className="flex min-w-0 items-center gap-1 text-destructive">
                          <AlertCircle className="size-3.5 shrink-0" />
                          <span className="truncate">{why}</span>
                        </span>
                      ) : checked ? (
                        <span className="flex items-center gap-1 text-status-success-text">
                          <CheckCircle2 className="size-3.5" /> Working
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not checked yet</span>
                      )}
                    </div>
                  )
                })}
              </div>
              {gitlabProblem && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setDialog('gitlab')}>
                    Replace token
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === 'recheck'} onClick={recheck}>
                    Re-check
                  </Button>
                </div>
              )}
            </Details>
          )}
        </ProviderRow>
      </Group>

      <Group title="Task providers" description="The issue trackers Yardbell reads tickets from to start pipelines and triggers, and that steps move or comment on.">
        <ProviderRow
          icon={<SquareKanban className="size-5" />}
          name="Linear"
          description={
            linear?.ok
              ? '1 workspace connected'
              : linearKey && !linear
                ? 'Checking Linear access…'
                : 'Add Linear access so pipelines and triggers can read and move tickets.'
          }
          tone={linear?.ok ? 'connected' : linearKey && !linear ? 'neutral' : linearKey ? 'bad' : 'attention'}
          status={linear?.ok ? 'Connected' : linearKey && !linear ? 'Checking' : linearKey ? 'Key refused' : 'Not connected'}
          actions={
            <Button size="sm" variant={linearKey ? 'outline' : 'default'} onClick={() => setDialog('linear')}>
              {linearKey ? 'Replace key' : 'Add Linear access'}
            </Button>
          }
        >
          {linearKey && linear && (
            <Details>
              <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{linear.organization || 'Linear'}</p>
                  <p className="truncate text-xs text-muted-foreground">{linear.ok ? [linear.name, linear.email].filter(Boolean).join(' · ') : linear.error}</p>
                </div>
                {linearTest === 'ok' && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-status-success-text">
                    <CheckCircle2 className="size-3.5" /> Verified
                  </span>
                )}
                <Button variant="outline" size="sm" disabled={linearTest === 'testing'} onClick={testLinear}>
                  {linearTest === 'testing' ? (
                    <>
                      <LoaderCircle className="animate-spin" /> Testing…
                    </>
                  ) : (
                    'Test'
                  )}
                </Button>
                <button
                  type="button"
                  aria-label="Disconnect Linear"
                  title="Disconnect Linear"
                  onClick={async () => {
                    if (!(await confirmAction({ title: 'Disconnect Linear?', body: 'Deletes the saved key linear. Pipelines and triggers that read Linear stop until you add one again.', confirm: 'Disconnect', danger: true }))) return
                    await act('linear-off', () => api('POST', '/api/settings/secrets/delete', { name: 'linear' }))
                    setLinear(null)
                  }}
                  className="rounded-md p-1 text-muted-foreground/60 hover:text-destructive"
                >
                  <Unlink className="size-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/80">The key is kept in Yardbell's secrets file on this machine. Pipelines, triggers and Dispatch use the same key.</p>
            </Details>
          )}
        </ProviderRow>
      </Group>

      <Group
        title="Connected tools"
        description="MCP servers your agent sessions and pipeline steps can use. Agents sign in to each one themselves, on their own machine."
        action={
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setDialog({ token: { view: 'pick' } })}>
              <KeyRound /> Token tools
            </Button>
            <Button size="sm" onClick={() => setDialog({ flow: { step: 'pick' } })}>
              <Plus /> Connect a tool
            </Button>
          </div>
        }
      >
        {!data.mcp_servers.length && !own.length && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nothing connected yet. Connect a tool to sign in with your account, with no token to create.
          </p>
        )}
        {data.mcp_servers.map((srv) => {
          const [tone, word] = authTone(srv.name)
          const st = data.mcp_auth?.[srv.name]
          let where = srv.command
          try {
            if (srv.url) where = new URL(srv.url).host
          } catch {
            where = srv.url
          }
          return (
            <ProviderRow
              key={srv.name}
              icon={<Plug className="size-5" />}
              name={srv.name}
              description={`${where}${srv.machines?.length ? ` · ${srv.machines.join(', ')}` : ' · every machine'}`}
              tone={tone}
              status={word}
              actions={
                <>
                  {(st === 'not_signed_in' || st === 'sign_in_again') && (
                    <Button size="sm" onClick={() => setDialog({ flow: { step: 'finding', name: srv.name } })}>
                      {st === 'sign_in_again' ? 'Sign in again' : 'Sign in'}
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" disabled={busy === srv.name}>
                        Manage
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setDialog({ flow: { step: 'checking', name: srv.name } })}>Test</DropdownMenuItem>
                      {(st === 'signed_in' || st === 'sign_in_again') && (
                        <DropdownMenuItem onSelect={() => act(srv.name, () => api('POST', serverPath(srv.name, 'sign-out')))}>Sign out</DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={async () => {
                          if (
                            !(await confirmAction({
                              title: `Remove ${srv.name}?`,
                              body: 'Agent sessions stop getting it. Its saved sign-in goes.',
                              confirm: 'Remove',
                              danger: true
                            }))
                          )
                            return
                          act(srv.name, () => api('POST', '/api/settings/mcp/servers', { servers: data.mcp_servers.filter((x) => x !== srv) }))
                        }}
                      >
                        <Trash2 /> Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            />
          )
        })}
        {own.map((c) => {
          const status = connectors?.status[c.id]
          const [tone, word]: [Tone, string] = c.missing.length
            ? ['attention', 'Needs a secret']
            : !c.enabled
              ? ['neutral', 'Switched off']
              : !status
                ? ['neutral', 'Not checked']
                : status.ok
                  ? ['connected', 'Working']
                  : ['bad', 'Failing']
          return (
            <ProviderRow
              key={c.id}
              icon={<KeyRound className="size-5" />}
              name={c.name}
              description={
                c.missing.length ? `Save the secret ${c.missing.join(', ')}` : status && !status.ok ? status.message : `${c.host || ''} · with a token`
              }
              tone={tone}
              status={word}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => setDialog({ token: { view: 'edit', conn: c, was: c.id } })}>
                    Edit
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label={`More for ${c.name}`} disabled={busy === c.id}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={Boolean(c.missing.length)} onSelect={() => setDialog({ token: { view: 'test', conn: c } })}>
                        <FlaskConical /> Test
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDialog({ token: { view: 'share', conn: c } })}>
                        <Share2 /> Share
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={async () => {
                          if (!(await confirmAction({ title: `Delete ${c.name}?`, body: 'A pipeline using it waits until it has another. Its secrets stay.', confirm: 'Delete', danger: true })))
                            return
                          act(c.id, () => api('DELETE', `/api/settings/connectors/${encodeURIComponent(c.id)}`))
                        }}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            />
          )
        })}
      </Group>

      <Group title="Pull and merge requests">
        <Row
          label="Show them on sessions"
          description="A session shows its branch's pull or merge request, with its state and CI."
          control={<Switch checked={v.enabled} onCheckedChange={(on) => savePull({ enabled: on })} aria-label="Show them on sessions" />}
        />
        <Row
          label="Post a card in Dispatch"
          description="When CI fails or a reviewer comments."
          control={<Switch checked={v.cards} onCheckedChange={(on) => savePull({ cards: on })} aria-label="Post a card in Dispatch" />}
        />
        <Row
          label="Review my sessions' pull requests"
          description="When a pull or merge request opens or gets new commits, a read-only reviewer runs the tests and its findings come back in Dispatch. Each review uses your agent's tokens."
          control={
            <select value={v.review_sessions || 'off'} onChange={(e) => savePull({ review_sessions: e.target.value })} className={cn(inputClass, 'w-44')}>
              <option value="off">Off</option>
              <option value="ask">Ask me first</option>
              <option value="auto">Automatically</option>
            </select>
          }
        />
        <Row
          label="Merge with"
          description="What Merge on a ready session and Dispatch's merge step use. GitLab merges as each project is set up, and can only be told to squash."
          control={
            <select value={v.merge_method || 'merge'} onChange={(e) => savePull({ merge_method: e.target.value })} className={cn(inputClass, 'w-44')}>
              <option value="merge">A merge commit</option>
              <option value="squash">Squash</option>
              <option value="rebase">Rebase</option>
            </select>
          }
        />
        <Row
          label="Check every"
          description="How often Yardbell asks about each branch."
          control={
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="number"
                min={30}
                step={10}
                defaultValue={v.poll_seconds}
                onBlur={(e) => Number(e.target.value) !== v.poll_seconds && savePull({ poll_seconds: Number(e.target.value) })}
                className={cn(inputClass, 'w-24')}
              />
              seconds
            </span>
          }
        />
      </Group>

      <Group title="Your folders" description="Which service each folder's origin remote is on.">
        {!folders ? (
          <p className="py-4 text-xs text-muted-foreground">Asking your machines…</p>
        ) : (
          <>
            {folders.folders.map((f) => (
              <Row
                key={`${f.machine}:${f.folder}`}
                label={
                  <span className="font-mono text-xs font-normal" title={f.folder}>
                    {f.folder.split('/').slice(-2).join('/')}
                  </span>
                }
                description={f.machine}
                control={
                  <span className="text-xs text-muted-foreground">
                    {f.service === 'none' ? 'No remote' : f.service === 'unknown' ? 'Not known' : f.host || f.service}
                  </span>
                }
              />
            ))}
            {folders.unreachable.map((u) => (
              <p key={u.machine} className="py-3 text-xs text-destructive">
                {u.machine}: {u.why}
              </p>
            ))}
            {!folders.folders.length && !folders.unreachable.length && <p className="py-4 text-xs text-muted-foreground">No folders with a git remote yet.</p>}
          </>
        )}
      </Group>

      <Group
        title="Secrets"
        description={`Tokens are saved here by themselves when you paste one into a connection. Only your account can read ${data.secrets.file || 'secrets.yml'}.`}
        action={
          <Button size="sm" variant="outline" onClick={() => setDialog({})}>
            <Plus /> Add secret
          </Button>
        }
      >
        {data.secrets.missing.length > 0 && (
          <p className="py-3 text-xs text-status-warning-text">
            {data.secrets.missing.map((x) => `${x.server} uses ${secretRef(x.name)}, which is not set.`).join(' ')} Add it here.
          </p>
        )}
        {!data.secrets.list.length && <p className="py-4 text-xs text-muted-foreground">No secrets yet.</p>}
        {data.secrets.list.map((x) => (
          <Row
            key={x.name}
            label={<code className="font-mono text-xs">{x.name}</code>}
            description={`${x.used_by.length ? `Used by ${x.used_by.join(', ')}` : 'Not used'}${x.updated ? ` · saved ${new Date(x.updated).toLocaleDateString([], { dateStyle: 'medium' })}` : ''}`}
            control={
              <div className="flex gap-1.5">
                <Button size="xs" variant="outline" onClick={() => setDialog({ secret: x.name })}>
                  Replace
                </Button>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={async () => {
                    if (
                      !(await confirmAction({
                        title: `Delete the secret ${x.name}?`,
                        body: x.used_by.length ? `${x.used_by.join(', ')} use it and stop working until it is set again.` : 'Nothing uses it.',
                        confirm: 'Delete',
                        danger: true
                      }))
                    )
                      return
                    act(x.name, () => api('POST', '/api/settings/secrets/delete', { name: x.name }))
                  }}
                >
                  Delete
                </Button>
              </div>
            }
          />
        ))}
      </Group>

      {dialog === 'github' && <GithubDialog data={data} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'gitlab' && <GitlabDialog data={data} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'linear' && <LinearDialog onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog && typeof dialog === 'object' && 'token' in dialog && (
        <TokenDialog
          start={dialog.token}
          list={connectors?.list || []}
          starters={connectors?.starters || {}}
          secrets={data.secrets.list.map((x) => x.name)}
          onClose={() => (setDialog(null), refresh())}
        />
      )}
      {dialog && typeof dialog === 'object' && 'flow' in dialog && (
        <ConnectFlow data={data} connectors={connectors} start={dialog.flow} onClose={() => (setDialog(null), refresh())} onToken={(id) => {
            const conn = connectors?.starters?.[id]
            setDialog({ token: conn ? { view: 'edit', conn, was: '' } : { view: 'pick' } })
          }} reload={reload} />
      )}
      {dialog && typeof dialog === 'object' && !('flow' in dialog) && !('token' in dialog) && <SecretDialog name={dialog.secret} onClose={() => setDialog(null)} onSaved={refresh} />}
    </Section>
  )
}
