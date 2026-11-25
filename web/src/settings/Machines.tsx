/* eslint-disable @typescript-eslint/no-explicit-any */
// The machine list and its add form follow Orca's SSH hosts pane (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Copy, ExternalLink, Folder, Loader2, MoreHorizontal, Pencil, PlugZap, Plus, Server, SquareTerminal, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { later } from '@/components/ui/menu-items'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'
import type { SettingsData } from './Integrations'
import { MESH_LABELS } from './Sections'
import { saved } from './saved'
import { Field, inputClass, Section } from './ui'

type Props = { data: SettingsData; reload: () => Promise<SettingsData | null> }
type Live = { name: string; up: boolean; reason?: string | null; local?: boolean; last_seen?: string }
const fail = (e: unknown) => toast.error((e as Error).message)

function useLive() {
  const [live, setLive] = useState<Live[]>([])
  const load = () =>
    fetch('/state', { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((s) => setLive(s.machines || []))
      .catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])
  return { live, load }
}

function statusOf(l?: Live) {
  if (!l) return { dot: 'bg-muted-foreground/40', word: 'Not checked' }
  if (l.up) return { dot: 'bg-status-success', word: l.local ? 'This machine' : 'Connected' }
  const why = (l.reason || 'unreachable').replace(/^ssh\b/, 'SSH')
  return { dot: 'bg-destructive', word: `${why[0].toUpperCase()}${why.slice(1)}` }
}

export function MachinesSection({ data, reload }: Props) {
  const { live, load } = useLive()
  const [editing, setEditing] = useState<any>(null)
  const [adding, setAdding] = useState(() => new URLSearchParams(location.search).has('add'))
  const [testing, setTesting] = useState('')
  const machines: any[] = data.machines as any[]

  const test = async (name: string) => {
    setTesting(name)
    try {
      await api('POST', '/refresh', {})
      await load()
    } catch (e) {
      fail(e)
    }
    setTesting('')
  }
  const remove = async (m: any) => {
    if (!(await confirmAction({ title: `Remove ${m.name} from Yardbell?`, body: 'Its sessions keep running and its tunnels close. ~/.ssh/config is not changed.', confirm: 'Remove', danger: true }))) return
    try {
      const res = await api<{ ok?: boolean; message: string }>('POST', `/machines/${encodeURIComponent(m.name)}/remove`)
      if (res.ok === false) throw new Error(res.message)
      toast(res.message)
      reload()
      load()
    } catch (e) {
      fail(e)
    }
  }
  const shell = async (m: any) => {
    try {
      const res = await api<{ name: string }>('POST', `/machines/${encodeURIComponent(m.name)}/shell`)
      window.open(`/term/${encodeURIComponent(m.name)}/${encodeURIComponent(res.name)}`, '_blank', 'noopener')
    } catch (e) {
      fail(e)
    }
  }

  return (
    <Section
      title="Machines"
      description="The computers Yardbell watches over SSH, where their projects live and which ports their apps open on."
      action={
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus /> Add machine
        </Button>
      }
    >
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30 divide-y divide-border/40">
        {machines.map((m) => {
          const l = live.find((x) => x.name === m.name)
          const st = statusOf(l)
          const endpoint = m.local ? m.mesh_ip || 'runs Yardbell' : m.ssh || m.name
          return (
            <div key={m.name} className="group/row flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40">
              <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  {m.local && <span className="self-center rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">Yardbell host</span>}
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    <span className="font-mono">{endpoint}</span>
                    {m.mesh_ip && !m.local && (
                      <>
                        {' '}
                        <span className="px-0.5">·</span> <span className="font-mono">{m.mesh_ip}</span>
                      </>
                    )}
                    {m.port_prefix ? (
                      <>
                        {' '}
                        <span className="px-0.5">·</span> ports {m.port_prefix}xxxx
                      </>
                    ) : null}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={m.root}>
                  <Folder className="mr-1 inline size-3 align-[-1px]" />
                  {m.root || 'No project folder yet'}
                  {m.mesh && <span> · {MESH_LABELS[m.mesh] || m.mesh}</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {testing === m.name ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Testing…
                  </span>
                ) : (
                  <span className="flex max-w-56 items-center gap-1.5 truncate text-xs text-muted-foreground" title={st.word}>
                    <span className={cn('size-1.5 shrink-0 rounded-full', st.dot)} />
                    <span className="truncate">{st.word}</span>
                  </span>
                )}
                <span className="opacity-0 transition-opacity group-hover/row:opacity-100 [.group\/row:has(:focus-visible)_&]:opacity-100">
                  <Button variant="ghost" size="xs" onClick={() => setEditing(m)}>
                    Edit
                  </Button>
                </span>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={`More actions for ${m.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-48">
                    <DropdownMenuItem disabled={Boolean(testing)} onSelect={() => later(() => test(m.name))}>
                      <PlugZap /> Test connection
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => later(() => setEditing(m))}>
                      <Pencil /> Edit…
                    </DropdownMenuItem>
                    {l?.up && (
                      <DropdownMenuItem onSelect={() => later(() => shell(m))}>
                        <SquareTerminal /> Open a shell
                      </DropdownMenuItem>
                    )}
                    {!m.local && (
                      <DropdownMenuItem
                        onSelect={() =>
                          later(() =>
                            navigator.clipboard.writeText(`ssh ${m.ssh || m.name}`).then(
                              () => toast('Copied the ssh command'),
                              () => toast(`ssh ${m.ssh || m.name}`)
                            )
                          )
                        }
                      >
                        <Copy /> Copy ssh command
                      </DropdownMenuItem>
                    )}
                    {!m.local && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => later(() => remove(m))}>
                          <Trash2 /> Remove…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
        {!machines.length && (
          <div className="grid justify-items-center gap-2 px-4 py-8 text-center">
            <Server className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No machines yet</p>
            <p className="text-xs text-muted-foreground">Add a computer on your mesh to watch its agent sessions.</p>
          </div>
        )}
      </div>
      {editing && <EditMachine m={editing} data={data} onClose={() => setEditing(null)} onSaved={reload} />}
      {adding && (
        <AddMachine
          known={machines.map((m) => m.name)}
          onClose={() => setAdding(false)}
          onSaved={() => {
            reload()
            load()
          }}
        />
      )}
    </Section>
  )
}

function Modal({ title, description, onClose, children, wide }: { title: string; description?: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn('max-h-[calc(100vh-2rem)] gap-4 overflow-y-auto', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription className="text-xs leading-relaxed">{description}</DialogDescription>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function EditMachine({ m, data, onClose, onSaved }: { m: any; data: SettingsData; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ ssh: m.ssh || '', mesh_ip: m.mesh_ip || '', port_prefix: String(m.port_prefix || ''), root: m.root || '', mesh: m.mesh || '' })
  const [busy, setBusy] = useState(false)
  const host = (data.machines as any[]).find((x) => x.local)?.name || 'the host'
  const prefix = Number(v.port_prefix)
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value })
  const save = async () => {
    setBusy(true)
    try {
      await api('POST', `/api/settings/machines/${encodeURIComponent(m.name)}`, {
        ssh: v.ssh.trim() || null,
        mesh_ip: v.mesh_ip.trim() || null,
        port_prefix: m.local ? null : Number(v.port_prefix) || null,
        root: v.root.trim(),
        mesh: v.mesh || null
      })
      saved(`${m.name} updated.`)
      onSaved()
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`Edit ${m.name}`} description={m.local ? 'Yardbell runs on this machine, so it is reached directly, not over SSH.' : 'How Yardbell reaches this machine over SSH, and where its projects live.'} onClose={onClose}>
      <div className="grid gap-4">
        {!m.local && (
          <Field label="SSH host or alias" hint="A Host from ~/.ssh/config on this machine, or user@address.">
            <input value={v.ssh} onChange={set('ssh')} placeholder={m.name} autoCapitalize="off" spellCheck={false} className={inputClass} />
          </Field>
        )}
        <Field label="Mesh address" hint={m.local ? 'Where your phone and other machines reach Yardbell.' : 'Its address on the mesh VPN, used for tunnels.'}>
          <input value={v.mesh_ip} onChange={set('mesh_ip')} placeholder="100.x.x.x" autoCapitalize="off" spellCheck={false} className={inputClass} />
        </Field>
        <Field label="Project folder" hint="Sessions start in its subfolders.">
          <input value={v.root} onChange={set('root')} placeholder="~/Projects" autoCapitalize="off" spellCheck={false} className={inputClass} />
        </Field>
        <details className="group rounded-lg border border-border/60 px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Advanced
          </summary>
          <div className="mt-3 grid gap-4">
            {!m.local && (
              <Field
                label="Port prefix"
                hint={prefix ? `Apps on ${m.name} open on ${host} at the prefix times 10000 plus their port, so port 3000 opens at ${prefix * 10000 + 3000}.` : `Apps on ${m.name} open on ${host} once it has a port prefix.`}
              >
                <select value={v.port_prefix} onChange={set('port_prefix')} className={inputClass}>
                  {!v.port_prefix && <option value="">None yet</option>}
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="VPN">
              <select value={v.mesh} onChange={set('mesh')} className={inputClass}>
                <option value="">Same as Yardbell</option>
                {Object.entries(MESH_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !v.root.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

type Peer = { ip: string; hostname: string; nickname?: string; os: string; online: boolean; suggested_name: string }
type StepState = { key: string; label: string; state: 'run' | 'ok' | 'bad'; message?: string; extra?: React.ReactNode }
type Answer = { ok: boolean; message?: string; data?: any }

function AddMachine({ known, onClose, onSaved }: { known: string[]; onClose: () => void; onSaved: () => void }) {
  const [peers, setPeers] = useState<{ list: Peer[]; phones: number; note?: string } | null>(null)
  const [form, setForm] = useState({ name: '', user: '', ip: '', root: '' })
  const [steps, setSteps] = useState<StepState[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const formRef = useRef(form)
  formRef.current = form
  const waiter = useRef<((v: unknown) => void) | null>(null)

  useEffect(() => {
    api<Answer>('GET', '/onboarding/peers').then(
      (r) => {
        if (!r.ok) return setPeers({ list: [], phones: 0, note: r.message })
        const mobile = (p: Peer) => ['android', 'ios'].includes(String(p.os).toLowerCase())
        const all: Peer[] = r.data.peers
        setPeers({ list: all.filter((p) => !mobile(p)).sort((a, b) => Number(b.online) - Number(a.online)), phones: all.filter(mobile).length })
      },
      (e) => setPeers({ list: [], phones: 0, note: e.message })
    )
  }, [])

  const wait = () => new Promise((r) => (waiter.current = r))
  const go = () => waiter.current?.(null)
  const put = (s: StepState) => setSteps((list) => [...list.filter((x) => x.key !== s.key), s])
  const step = async (key: string, label: string): Promise<Answer> => {
    put({ key, label, state: 'run' })
    let out: Answer
    try {
      out = await api<Answer>('POST', `/onboarding/${key}`, formRef.current)
    } catch (e) {
      out = { ok: false, message: (e as Error).message }
    }
    put({ key, label, state: out.ok ? 'ok' : 'bad', message: out.message })
    return out
  }

  const run = async () => {
    setSteps([])
    setRunning(true)
    try {
      if (!(await step('reachable', 'Reachable on the mesh')).ok) return
      for (;;) {
        const r = await step('key_auth', 'SSH key login')
        if (r.ok) break
        if (!r.data?.terminal_url) return
        put({
          key: 'key_auth',
          label: 'SSH key login',
          state: 'bad',
          message: r.message,
          extra: (
            <div className="grid gap-2">
              <p>Open the terminal and follow it. When it says done, come back and check again.</p>
              <div className="flex gap-2">
                <Button size="xs" variant="outline" asChild>
                  <a href={r.data.terminal_url} target="_blank" rel="noopener">
                    <ExternalLink /> Open terminal
                  </a>
                </Button>
                <Button size="xs" onClick={go}>
                  Check again
                </Button>
              </div>
            </div>
          )
        })
        await wait()
      }
      const preview = await step('ssh_config_preview', 'SSH config entry')
      if (!preview.ok) return
      if (!preview.data.reuse) {
        put({
          key: 'ssh_config_preview',
          label: 'SSH config entry',
          state: 'ok',
          message: preview.message,
          extra: (
            <div className="grid gap-2">
              <pre className="overflow-x-auto rounded-md border border-border/50 bg-muted/50 px-3 py-2 font-mono text-[11px]">{preview.data.block}</pre>
              <div>
                <Button size="xs" onClick={go}>
                  Add this to ~/.ssh/config
                </Button>
              </div>
            </div>
          )
        })
        await wait()
        put({ key: 'ssh_config_preview', label: 'SSH config entry', state: 'ok', message: preview.message })
        if (!(await step('write_ssh_config', 'Write SSH config')).ok) return
      }
      const detect = await step('detect', 'Check the machine')
      if (!detect.ok) return
      const d = detect.data
      setForm((f) => ({ ...f, root: d.root || '~' }))
      put({
        key: 'detect',
        label: 'Check the machine',
        state: 'ok',
        message: detect.message,
        extra: (
          <div className="grid gap-2">
            {(d.missing || []).length > 0 && (
              <ul className="grid gap-0.5">
                {d.missing.map((m: any) => (
                  <li key={m.tool}>
                    <code className="font-mono">{m.tool}</code> missing: <code className="font-mono">{m.hint}</code>
                  </li>
                ))}
              </ul>
            )}
            <p>Pick the folder that holds your projects. Sessions start in its subfolders.</p>
            <FolderPicker name={formRef.current.name} start={d.root || '~'} onPath={(root) => setForm((f) => ({ ...f, root }))} onUse={go} />
          </div>
        )
      })
      await wait()
      put({ key: 'detect', label: 'Check the machine', state: 'ok', message: detect.message })
      const save = await step('save', 'Save to Yardbell')
      if (save.ok) {
        setDone(true)
        onSaved()
        saved(`${formRef.current.name} added. Its sessions show in the sidebar once Yardbell checks it.`)
      }
    } finally {
      setRunning(false)
    }
  }

  const valid = /^[a-z0-9-]+$/.test(form.name) && form.user.trim() && form.ip.trim() && !known.includes(form.name)
  const shown = peers?.list.filter((p) => !known.includes(p.suggested_name)) || []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="shrink-0 border-b border-border/60 px-6 pt-6 pr-12 pb-4">
          <DialogTitle>Add machine</DialogTitle>
          <DialogDescription className="mt-1.5 text-xs leading-relaxed">
            Yardbell reaches each machine over SSH on your mesh VPN. It checks the connection, sets up key login and the SSH config entry, then asks where your projects are.
          </DialogDescription>
          <button type="button" aria-label="Close" onClick={onClose} className="absolute top-5 right-5 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="scrollbar-sleek min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {!steps.length && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Computers on your mesh</p>
              {!peers && <p className="text-xs text-muted-foreground">Looking for mesh peers…</p>}
              {peers && !shown.length && <p className="text-xs text-muted-foreground">{peers.note || 'Every computer on the mesh is already in Yardbell. Type an address below to add another.'}</p>}
              {shown.length > 0 && (
                <div className="grid max-h-44 gap-1.5 overflow-y-auto sm:grid-cols-2">
                  {shown.map((p) => {
                    const on = form.ip === p.ip
                    return (
                      <button
                        key={p.ip}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setForm((f) => ({ ...f, ip: p.ip, name: f.name || p.suggested_name }))}
                        className={cn('flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left', on ? 'border-foreground/40 bg-accent' : 'border-border/60 hover:bg-accent/50')}
                      >
                        <span className={cn('size-1.5 shrink-0 rounded-full', p.online ? 'bg-status-success' : 'bg-muted-foreground/40')} />
                        <span className="grid min-w-0">
                          <span className="truncate text-[13px] font-medium">{p.nickname || p.hostname}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {p.ip} · {p.os}
                            {p.online ? '' : ' · offline'}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {peers && peers.phones > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {peers.phones} {peers.phones === 1 ? 'phone or tablet' : 'phones and tablets'} hidden. They can open Yardbell in a browser but cannot run sessions.
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="block text-xs font-medium">Label *</span>
              <input value={form.name} disabled={running || done} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="pro" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'w-full')} />
            </label>
            <label className="space-y-1.5">
              <span className="block text-xs font-medium">Username *</span>
              <input value={form.user} disabled={running || done} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="you" autoCapitalize="off" autoComplete="off" spellCheck={false} className={cn(inputClass, 'w-full')} />
            </label>
            <label className="col-span-2 space-y-1.5">
              <span className="block text-xs font-medium">Host or address *</span>
              <input value={form.ip} disabled={running || done} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="100.x.x.x or studio-mini" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'w-full font-mono')} />
              <p className="text-[11px] text-muted-foreground">Its mesh IP or hostname. Pick a computer above to fill it in.</p>
            </label>
            <label className="col-span-2 space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Folder className="size-3.5" /> Project folder
              </span>
              <input value={form.root} readOnly placeholder="Picked after the check" className={cn(inputClass, 'w-full font-mono text-muted-foreground')} />
            </label>
            {known.includes(form.name) && <p className="col-span-2 text-[11px] text-destructive">A machine named {form.name} is already in Yardbell.</p>}
          </div>
          {steps.length > 0 && (
            <ol className="grid gap-2 rounded-lg border border-border/60 bg-card/30 p-3">
              {steps.map((s) => (
                <li key={s.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-[13px]">
                  <span className="mt-0.5">
                    {s.state === 'run' ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : s.state === 'ok' ? (
                      <Check className="size-4 text-status-success-text" />
                    ) : (
                      <X className="size-4 text-destructive" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <span className="font-medium">{s.label}</span> <span className={cn('text-xs', s.state === 'bad' ? 'text-destructive' : 'text-muted-foreground')}>{s.message}</span>
                    {s.extra && <div className="mt-2 text-xs text-muted-foreground">{s.extra}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 bg-muted/10 px-6 py-4">
          <Button variant="ghost" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done && (
            <Button disabled={!valid || running} onClick={run}>
              {running ? 'Checking…' : steps.length ? 'Check again' : 'Check and add'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FolderPicker({ name, start, onPath, onUse }: { name: string; start: string; onPath: (p: string) => void; onUse: () => void }) {
  const [at, setAt] = useState<{ path: string; entries: { name: string }[] } | null>(null)
  const [error, setError] = useState('')
  const show = async (path: string) => {
    setError('')
    try {
      const l = await api<{ path: string; entries: { name: string }[] }>('GET', `/onboarding/browse?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`)
      setAt(l)
      onPath(l.path)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    show(start)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const parts = at ? at.path.split('/').filter(Boolean) : []
  return (
    <div className="grid gap-2 text-foreground">
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-0.5 text-xs">
        <button type="button" onClick={() => show('~')} className="rounded px-1 hover:bg-accent">
          Home
        </button>
        <span className="text-muted-foreground">·</span>
        <button type="button" onClick={() => show('/')} className="rounded px-1 font-mono hover:bg-accent">
          /
        </button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-muted-foreground">/</span>}
            <button type="button" onClick={() => show(`/${parts.slice(0, i + 1).join('/')}`)} className={cn('rounded px-1 font-mono hover:bg-accent', i === parts.length - 1 && 'font-semibold')}>
              {p}
            </button>
          </span>
        ))}
      </nav>
      <ul className="max-h-48 overflow-y-auto rounded-md border border-border/60">
        {error && <li className="px-3 py-2 text-destructive">{error}</li>}
        {!at && !error && <li className="px-3 py-2 text-muted-foreground">Loading…</li>}
        {at && parts.length > 0 && (
          <li>
            <button type="button" onClick={() => show(`/${parts.slice(0, -1).join('/')}`)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono hover:bg-accent">
              ..
            </button>
          </li>
        )}
        {at?.entries.map((e) => (
          <li key={e.name}>
            <button type="button" onClick={() => show(`${at.path.replace(/\/$/, '')}/${e.name}`)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent">
              <Folder className="size-3.5 text-muted-foreground" /> {e.name}
            </button>
          </li>
        ))}
        {at && !at.entries.length && <li className="px-3 py-2 text-muted-foreground">No subfolders</li>}
      </ul>
      <div>
        <Button size="xs" disabled={!at} onClick={onUse}>
          Use {at ? at.path : 'this folder'} and save
        </Button>
      </div>
    </div>
  )
}
