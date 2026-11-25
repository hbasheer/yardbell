/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Bot, Brain, Check, ChevronDown, Copy, ExternalLink, GitBranch, ListChecks, Network, Pencil, Plus, ShieldAlert, ShieldCheck, ShieldX, SquareTerminal, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'
import type { SettingsData } from './Integrations'
import { saved } from './saved'
import { catalogFor } from '@/lib/agent-models'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { areaClass, EmptyState, Field, Group, inputClass, Pill, Row, Section, Segmented, type Tone } from './ui'

type Props = { data: SettingsData; reload: () => Promise<SettingsData | null> }
const D = (data: SettingsData) => data as any

export const MESH_LABELS: Record<string, string> = {
  nordvpn: 'NordVPN Meshnet',
  tailscale: 'Tailscale',
  headscale: 'Headscale',
  netbird: 'NetBird',
  zerotier: 'ZeroTier',
  none: 'None (plain network)'
}

const fail = (e: unknown) => toast.error((e as Error).message)

function copyText(text: string) {
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false
  )
}

function Minutes({ value, onChange, min, max, word = 'for' }: { value: number; onChange: (n: number) => void; min: number; max: number; word?: string }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {word}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(inputClass, 'w-20')}
      />
      minutes
    </label>
  )
}

function SaveFoot({ note, busy, onSave, label = 'Save' }: { note?: React.ReactNode; busy?: boolean; onSave: () => void; label?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <p className="text-xs text-muted-foreground">{note}</p>
      <Button size="sm" disabled={busy} onClick={onSave}>
        {label}
      </Button>
    </div>
  )
}

const PHONE_MAIN: [string, string][] = [
  ['session_ended', 'Session ended'],
  ['limit_reset', 'Usage limit reset'],
  ['machines', 'Machine down or back'],
  ['memory', 'Memory at 95%'],
  ['pipeline_waiting', 'Pipeline needs you'],
  ['pipeline_finished', 'Pipeline finished'],
  ['proposals', 'Proposals from MCP clients']
]
const PHONE_PULLS: [string, string][] = [
  ['pull_ci_failed', 'CI failed'],
  ['pull_conflicts', 'Merge conflicts'],
  ['pull_ready', 'Ready to merge'],
  ['pull_merged', 'Merged'],
  ['pull_closed', 'Closed without merging']
]

export function PhoneSection({ data, reload }: Props) {
  const [p, setP] = useState<any>(D(data).phone)
  const [busy, setBusy] = useState(false)
  useEffect(() => setP(D(data).phone), [data])
  if (!p) return null
  const flip = (key: string) => (on: boolean) => setP({ ...p, [key]: on })
  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { wait_minutes: Number(p.wait_minutes) }
      for (const [k] of [['agent_waiting'], ...PHONE_MAIN, ...PHONE_PULLS]) body[k] = Boolean(p[k])
      await api('POST', '/api/settings/phone', body)
      saved('Phone notifications updated.')
      reload()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Phone notifications" description="The Yardbell app for Android shows these while it is signed in to this server. Nothing else to install.">
      <Group>
        <Row
          label="Agent waiting"
          control={
            <span className="flex items-center gap-3">
              <Minutes word="after" value={p.wait_minutes} min={0} max={60} onChange={(n) => setP({ ...p, wait_minutes: n })} />
              <Switch checked={Boolean(p.agent_waiting)} onCheckedChange={flip('agent_waiting')} aria-label="Agent waiting" />
            </span>
          }
        />
        {PHONE_MAIN.map(([k, label]) => (
          <Row key={k} label={label} control={<Switch checked={Boolean(p[k])} onCheckedChange={flip(k)} aria-label={label} />} />
        ))}
      </Group>
      <Group title="Pull and merge requests of your sessions">
        {PHONE_PULLS.map(([k, label]) => (
          <Row key={k} label={label} control={<Switch checked={Boolean(p[k])} onCheckedChange={flip(k)} aria-label={label} />} />
        ))}
      </Group>
      <SaveFoot
        busy={busy}
        onSave={save}
        note={
          <span className={p.app_connected ? 'text-status-success-text' : undefined}>
            {p.app_connected
              ? 'The Yardbell app is connected and gets these.'
              : 'No phone has the Yardbell app connected right now. Pair one under Connect a phone.'}
          </span>
        }
      />
    </Section>
  )
}

export function PairSection() {
  const [pair, setPair] = useState<{ qr_svg: string; server: string; ends: number } | null>(null)
  const [left, setLeft] = useState(0)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!pair) return
    const tick = () => {
      const s = Math.round((pair.ends - Date.now()) / 1000)
      if (s <= 0) {
        setPair(null)
        setMessage('That code expired. Show a new one to pair.')
        return
      }
      setLeft(s)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [pair])
  const show = async () => {
    setBusy(true)
    try {
      const out = await api<{ qr_svg: string; server: string; expires_in: number }>('POST', '/api/settings/pair', {})
      setMessage('')
      setPair({ qr_svg: out.qr_svg, server: out.server, ends: Date.now() + out.expires_in * 1000 })
    } catch (e) {
      setPair(null)
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Connect a phone" description="Pair the Android app so it signs in without the passcode and gets notifications.">
      <div className="grid gap-6 rounded-xl border border-border bg-card p-5 md:grid-cols-[minmax(0,1fr)_15rem]">
        <ol className="grid content-start gap-4">
          {[
            [
              'Install the app',
              <>
                Get the Android app from the{' '}
                <a href="https://github.com/hbasheer/yardbell/releases/latest" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  latest release
                </a>
                .
              </>
            ],
            ['Join the mesh', 'The phone must be on the same mesh VPN as this server.'],
            [
              'Scan the code',
              <>
                In the app, tap <strong className="font-medium text-foreground">Scan a pairing code</strong> and point it at the code here. Each code works once, for five
                minutes.
              </>
            ]
          ].map(([title, text], i) => (
            <li key={i} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{i + 1}</span>
              <div className="grid gap-0.5">
                <span className="text-[13px] font-medium">{title}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{text}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className="grid content-start justify-items-center gap-3">
          {pair ? (
            <div className="size-56 rounded-lg bg-white p-3 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: pair.qr_svg }} />
          ) : (
            <div className="grid size-56 place-items-center rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
              {message || 'The pairing code shows here.'}
            </div>
          )}
          {pair && (
            <p role="status" className="text-xs text-muted-foreground tabular-nums">
              Pairs with {pair.server}. Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
            </p>
          )}
          <Button size="sm" variant={pair ? 'outline' : 'default'} disabled={busy} onClick={show}>
            {pair ? 'Show a new code' : 'Show pairing code'}
          </Button>
        </div>
      </div>
    </Section>
  )
}

export function MeshSection({ data, reload }: Props) {
  const current = D(data).mesh as string
  const [provider, setProvider] = useState(current)
  const [preview, setPreview] = useState<{ note: string; rows: { machine: string; old_ip?: string; new_ip?: string; peer?: string }[] } | null>(null)
  const [addresses, setAddresses] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => setProvider(current), [current])
  const check = async () => {
    setBusy(true)
    try {
      const res = await api<any>('POST', '/api/settings/mesh/preview', { provider })
      const found = res.proposals.filter((p: any) => p.new_ip).length
      setPreview({
        note: res.message
          ? `${res.message} Type the new addresses below.`
          : `${res.label} lists ${res.peers.length} peers. Matched ${found} of ${res.proposals.length} machines by name. Check each address; leave a field empty to keep it unchanged.`,
        rows: res.proposals
      })
      setAddresses(Object.fromEntries(res.proposals.map((p: any) => [p.machine, p.new_ip || ''])))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    const chosen = Object.fromEntries(
      Object.entries(addresses)
        .filter(([, a]) => a.trim())
        .map(([m, a]) => [m, a.trim()])
    )
    const count = Object.keys(chosen).length
    if (
      !(await confirmAction({
        title: `Switch Yardbell to ${MESH_LABELS[provider]}?`,
        body: `This updates ${count} ${count === 1 ? 'address' : 'addresses'}.`,
        confirm: 'Switch VPN'
      }))
    )
      return
    setBusy(true)
    try {
      const res = await api<any>('POST', '/api/settings/mesh/apply', { provider, addresses: chosen })
      const ssh = res.ssh_updated.length ? ` Updated ~/.ssh/config for ${res.ssh_updated.join(', ')}.` : ''
      const restart = res.restart_needed
        ? D(data).service_installed
          ? ' Restart Yardbell so your phone can reach it at the new address.'
          : ' Stop Yardbell and run yardbell serve again so your phone can reach it at the new address.'
        : ''
      saved(`Yardbell now uses ${MESH_LABELS[provider]}.${ssh}${restart}`, res.restart_needed)
      setPreview(null)
      reload()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Mesh VPN"
      description="The private network your machines and phone reach each other over."
    >
      <Group
        title="Provider"
        description="Switching VPN changes every machine's address. Yardbell looks each machine up in the new VPN's peer list so you can confirm the new addresses before anything is saved."
      >
        <div role="radiogroup" aria-label="Mesh VPN provider" className="grid grid-cols-2 gap-2 py-4 sm:grid-cols-3">
          {Object.entries(MESH_LABELS).map(([k, l]) => {
            const on = provider === k
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setProvider(k)
                  setPreview(null)
                }}
                className={cn('grid gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors', on ? 'border-foreground ring-2 ring-foreground/15' : 'border-border hover:border-foreground/30')}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <Network className="size-3.5 text-muted-foreground" />
                  {l}
                </span>
                <span className="text-[11px] text-muted-foreground">{k === current ? 'In use now' : k === 'none' ? 'Machines on one network' : 'Mesh VPN'}</span>
              </button>
            )
          })}
        </div>
        <Row
          label={provider === current ? `Using ${MESH_LABELS[current] || current}` : `Switch to ${MESH_LABELS[provider]}`}
          description={provider === current ? 'Check addresses again to compare each machine with the VPN peer list.' : 'Nothing changes until you confirm the new addresses.'}
          control={
            <span className="flex gap-2">
              <Button size="sm" variant={provider === current ? 'outline' : 'default'} disabled={busy} onClick={check}>
                Check addresses
              </Button>
            </span>
          }
        />
        {preview && (
          <div className="grid gap-3 py-4">
            <p className="text-xs text-muted-foreground">{preview.note}</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Machine</th>
                    <th className="px-3 py-2 font-medium">Current address</th>
                    <th className="px-3 py-2 font-medium">New address</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((p) => (
                    <tr key={p.machine} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{p.machine}</td>
                      <td className="px-3 py-2 font-mono text-xs">{p.old_ip || 'none'}</td>
                      <td className="px-3 py-2">
                        <input
                          value={addresses[p.machine] || ''}
                          onChange={(e) => setAddresses({ ...addresses, [p.machine]: e.target.value })}
                          placeholder="100.x.x.x"
                          autoCapitalize="off"
                          className={cn(inputClass, 'w-40 font-mono text-xs')}
                        />
                        {p.peer && <span className="ml-2 text-xs text-muted-foreground">matched {p.peer}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Saves <code className="font-mono">yardbell.yml</code> and updates the matching <code className="font-mono">HostName</code> lines in{' '}
                <code className="font-mono">~/.ssh/config</code>, with backups of both.
              </p>
              <Button size="sm" disabled={busy} onClick={apply}>
                Switch VPN
              </Button>
            </div>
          </div>
        )}
      </Group>
    </Section>
  )
}

const HEALTH: [string, string][] = [
  ['run_queued', 'A run stays queued'],
  ['run_waiting', 'A run stays waiting for you'],
  ['step_quiet', 'A step near its limit has an unchanged screen'],
  ['ci_pending', 'CI stays pending on a pull or merge request'],
  ['trigger_failing', 'A trigger keeps failing'],
  ['memory_short', 'A machine stays at 90% memory or more']
]

export function HealthSection({ data, reload }: Props) {
  const [h, setH] = useState<any>(D(data).health_checks)
  const [busy, setBusy] = useState(false)
  useEffect(() => setH(D(data).health_checks), [data])
  if (!h) return null
  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {}
      for (const [k] of HEALTH) {
        body[k] = Boolean(h[k])
        body[`${k}_minutes`] = Number(h[`${k}_minutes`])
      }
      await api('POST', '/api/settings/health', body)
      saved('Health checks updated.')
      reload()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Health checks"
      description="Plain checks on what Yardbell already reads, to tell you when automation is quietly stuck. They use no tokens, start nothing and change nothing. A problem shows on the dashboard and notifies your phone once, and again only after it clears and comes back."
    >
      <Group>
        {HEALTH.map(([k, label]) => (
          <Row
            key={k}
            label={label}
            control={
              <span className="flex items-center gap-3">
                <Minutes value={h[`${k}_minutes`]} min={5} max={10080} onChange={(n) => setH({ ...h, [`${k}_minutes`]: n })} />
                <Switch checked={Boolean(h[k])} onCheckedChange={(on) => setH({ ...h, [k]: on })} aria-label={label} />
              </span>
            }
          />
        ))}
      </Group>
      <SaveFoot busy={busy} onSave={save} note="Each time can be from 5 to 10080 minutes." />
    </Section>
  )
}

export function McpSection({ data, reload }: Props) {
  const m = D(data).mcp || {}
  const on = Boolean(m.token)
  const [busy, setBusy] = useState(false)
  const url = on ? m.urls.find((u: string) => !u.includes('//127.0.0.1:')) || m.urls[0] : ''
  // read -s keeps the token out of the line typed, so shell history never sees it.
  const command = `printf 'Yardbell token: ' && read -rs YB_TOKEN && echo && claude mcp add --transport http --scope user yardbell ${url} --header "Authorization: Bearer $YB_TOKEN"; unset YB_TOKEN`
  const act = async (path: string, message: string) => {
    setBusy(true)
    try {
      await api('POST', path, {})
      toast(message)
      reload()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Let agents use Yardbell"
      description="Let AI agents see your machines and sessions, and start, read and answer sessions, through an MCP server built into Yardbell."
      action={
        on && (
          <Button
            size="sm"
            variant="ghost-destructive"
            disabled={busy}
            onClick={async () => {
              if (
                await confirmAction({
                  title: 'Turn off the MCP server?',
                  body: "Agents lose access to Yardbell's tools. Turning it on again makes a new token.",
                  confirm: 'Turn off',
                  danger: true
                })
              )
                act('/api/settings/mcp/off', 'The MCP server is off.')
            }}
          >
            Turn off
          </Button>
        )
      }
    >
      {!on ? (
        <Group>
          <Row
            label="Yardbell's MCP server"
            description="Off. Turning it on makes a token for your agents."
            control={
              <Button size="sm" disabled={busy} onClick={() => act('/api/settings/mcp/on', 'The MCP server is on.')}>
                Turn on
              </Button>
            }
          />
        </Group>
      ) : (
        <Group>
          <div className="grid gap-2 py-4">
            <p className="text-[13px] font-medium">Add Yardbell to Claude Code</p>
            <p className="text-xs text-muted-foreground">On any machine on the mesh. Run this command, then paste the token when it asks for it.</p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-[11.5px] break-all">{command}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => ((await copyText(command)) ? toast('Command copied') : toast.error("Couldn't copy. Select the command and copy it."))}
              >
                <Copy /> Copy
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-muted px-3 py-2 font-mono text-[11.5px]">{m.token.slice(0, 7)}…</code>
              <Button
                size="sm"
                variant="outline"
                onClick={async () =>
                  (await copyText(m.token)) ? toast('Token copied. Paste it when the command asks for it.') : toast.error("Couldn't copy the token.")
                }
              >
                <Copy /> Copy token
              </Button>
            </div>
          </div>
          <Row
            label="Token"
            description={
              <>
                The token is read without showing it, so it stays out of your shell history and off the command you type. Claude Code keeps it in{' '}
                <code className="font-mono">~/.claude.json</code>. It lets an agent start and type into sessions on every machine, so keep it secret, and make a
                new one if it leaks: the old one stops working at once. Changes they ask for wait on the{' '}
                <a href="/ui/proposals" className="underline underline-offset-2">
                  Proposals
                </a>{' '}
                page.
              </>
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirmAction({
                      title: 'Make a new MCP token?',
                      body: 'Agents set up with the current token lose access until you add Yardbell again with the new command.',
                      confirm: 'Make new token'
                    })
                  )
                    act('/api/settings/mcp/on', 'New token made. Add Yardbell to your agents again.')
                }}
              >
                Make a new token
              </Button>
            }
          />
        </Group>
      )}
    </Section>
  )
}

const DIAGRAM_WORDS: Record<string, [Tone, string]> = {
  installed: ['connected', 'Installed'],
  not_installed: ['neutral', 'Not installed'],
  needs_node: ['attention', 'Needs Node 18 or later'],
  offline: ['bad', 'Did not answer']
}

export function DiagramsSection() {
  const [info, setInfo] = useState<{ version: string; machines: { name: string; state: string; problem?: string }[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const load = () => api<any>('GET', '/api/diagrams').then(setInfo, (e) => setError(e.message))
  useEffect(() => {
    load()
  }, [])
  const act = async (machine: string, removing: boolean) => {
    if (
      removing &&
      !(await confirmAction({
        title: `Remove Archify from ${machine}?`,
        body: 'Diagrams already drawn stay in their folders. You can install it again.',
        confirm: 'Remove',
        danger: true
      }))
    )
      return
    setBusy(machine)
    try {
      await api('POST', `/api/diagrams/${removing ? 'remove' : 'install'}`, { machine })
      saved(removing ? `Archify removed from ${machine}.` : `Archify installed on ${machine}.`)
    } catch (e) {
      fail(e)
    }
    setBusy('')
    load()
  }
  return (
    <Section
      title="Diagrams"
      description={
        <>
          Draw interactive maps of your repositories on the Diagrams page, with Archify. Yardbell downloads a fixed, checked version to each machine, in its own
          folder, and agents read it from there. Each machine needs Node 18 or later.
        </>
      }
    >
      <Group>
        {!info && <p className="py-4 text-xs text-muted-foreground">{error || 'Asking your machines…'}</p>}
        {info?.machines.map((m) => {
          const [tone, word] = DIAGRAM_WORDS[m.state] || ['neutral', m.state]
          return (
            <Row
              key={m.name}
              label={m.name}
              description={m.state === 'installed' ? `Archify ${info.version}` : m.problem}
              control={
                <span className="flex items-center gap-2">
                  <Pill tone={tone}>{word}</Pill>
                  {m.state === 'not_installed' && (
                    <Button size="xs" variant="outline" disabled={busy === m.name} onClick={() => act(m.name, false)}>
                      {busy === m.name ? 'Installing…' : 'Install'}
                    </Button>
                  )}
                  {m.state === 'installed' && (
                    <Button size="xs" variant="ghost" disabled={busy === m.name} onClick={() => act(m.name, true)}>
                      {busy === m.name ? 'Removing…' : 'Remove'}
                    </Button>
                  )}
                </span>
              }
            />
          )
        })}
      </Group>
    </Section>
  )
}

type Setup = { folder: string; machine: string; command: string; teardown?: string; timeout_seconds: number }

export function SetupSection({ data }: { data: SettingsData }) {
  const [setups, setSetups] = useState<Setup[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () =>
    api<{ setups: Setup[] }>('GET', '/api/settings/worktree-setup').then(
      (r) => setSetups((r.setups || []).map((x) => ({ ...x, machine: x.machine || 'any', timeout_seconds: x.timeout_seconds || 300 }))),
      () => setSetups([])
    )
  useEffect(() => {
    load()
  }, [])
  const set = (i: number, change: Partial<Setup>) => setSetups((list) => list!.map((x, j) => (j === i ? { ...x, ...change } : x)))
  const save = async () => {
    setBusy(true)
    try {
      await api('POST', '/api/settings/worktree-setup', { setups })
      saved('Worktree setup saved. It applies to the next worktree Yardbell creates.')
      load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Worktree setup"
      description={
        <>
          A command that runs in each new worktree Yardbell creates for a repository, before the agent starts, such as{' '}
          <code className="font-mono">bin/setup</code>, <code className="font-mono">npm ci</code> or{' '}
          <code className="font-mono">cp "$YARDBELL_MAIN_CHECKOUT/.env" .</code>. If it fails or runs past its timeout, the agent starts anyway, the session
          shows the output, and the agent is told.
        </>
      }
      action={
        <Button size="sm" variant="outline" onClick={() => setSetups([...(setups || []), { folder: '', machine: 'any', command: '', timeout_seconds: 300 }])}>
          <Plus /> Add command
        </Button>
      }
    >
      <p className="px-1 text-xs text-muted-foreground">
        The folder is the repository's main checkout, as in the folder list or as a path, and <code className="font-mono">*</code> matches any part of a name.
        Only commands saved here run. A repository's own script runs only when you name it here, like <code className="font-mono">.yardbell/setup</code>,
        because that script comes from whatever branch is checked out.
      </p>
      <Group>
        {setups && !setups.length && (
          <EmptyState
            icon={GitBranch}
            title="No setup commands"
            action={
              <Button size="sm" variant="outline" onClick={() => setSetups([{ folder: '', machine: 'any', command: '', timeout_seconds: 300 }])}>
                <Plus /> Add command
              </Button>
            }
          >
            New worktrees start the agent right away. Add a command to install dependencies or copy .env first.
          </EmptyState>
        )}
        {setups?.map((x, i) => (
          <div key={i} className="grid grid-cols-[1fr_9rem_auto] gap-2 py-3 max-sm:grid-cols-1">
            <input
              value={x.folder}
              onChange={(e) => set(i, { folder: e.target.value })}
              aria-label="Folder"
              placeholder="acme/web"
              autoCapitalize="off"
              spellCheck={false}
              className={inputClass}
            />
            <select value={x.machine} onChange={(e) => set(i, { machine: e.target.value })} aria-label="Machine" className={inputClass}>
              <option value="any">Any machine</option>
              {data.machines.map((m: any) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Remove command"
              onClick={() => setSetups(setups.filter((_, j) => j !== i))}
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <X className="size-4" />
            </button>
            <input
              value={x.command}
              onChange={(e) => set(i, { command: e.target.value })}
              aria-label="Command"
              placeholder="bin/setup"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(inputClass, 'font-mono text-xs')}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Timeout in seconds">
              <input
                type="number"
                min={1}
                max={3600}
                value={x.timeout_seconds}
                onChange={(e) => set(i, { timeout_seconds: Number(e.target.value) })}
                aria-label="Timeout in seconds"
                className={cn(inputClass, 'w-20')}
              />
              s
            </label>
            <span />
            <input
              value={x.teardown || ''}
              onChange={(e) => set(i, { teardown: e.target.value })}
              aria-label="When a run ends"
              title="Runs when a pipeline run that used this worktree ends"
              placeholder="When a run ends: docker compose down"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(inputClass, 'col-span-2 font-mono text-xs max-sm:col-span-1')}
            />
          </div>
        ))}
      </Group>
      <SaveFoot
        busy={busy || !setups}
        onSave={save}
        note={
          <>
            The command runs through your login shell in the new worktree, with the main checkout's path in{' '}
            <code className="font-mono">$YARDBELL_MAIN_CHECKOUT</code>.
          </>
        }
      />
    </Section>
  )
}

const RULE_STEPS: Record<string, string> = {
  any: 'Any step',
  call_connector: 'Call a connected tool',
  call_tool: 'Call an MCP tool',
  run_command: 'Run a command',
  save_connector: 'Save a connection',
  start_session: 'Start a session',
  stop_session: 'Stop a session',
  send_to_session: 'Type into a session',
  review_session: 'Start a review',
  scan_folder: 'Start a scan',
  remove_worktree: 'Remove a worktree',
  integrate_branches: 'Integrate branches',
  push_branch: 'Push a branch',
  merge_pull: 'Merge a pull request',
  move_session: 'Move a session',
  change_settings: 'Change settings',
  save_task: 'Save a prompt',
  run_trigger: 'Run a trigger',
  save_pipeline: 'Save a pipeline',
  set_pipeline_enabled: 'Turn a pipeline on or off',
  run_pipeline: 'Run a pipeline',
  answer_run: 'Answer a run',
  remember: "Change Dispatch's memory"
}
const UNPLACED = new Set([
  'save_connector',
  'call_connector',
  'call_tool',
  'remember',
  'change_settings',
  'save_task',
  'run_trigger',
  'save_pipeline',
  'set_pipeline_enabled',
  'run_pipeline',
  'answer_run'
])
type Rule = { action: string; machine: string; folder: string; approval: string }

const APPROVALS: { value: string; label: string; detail: string; icon: React.ComponentType<{ className?: string }>; tone: string }[] = [
  { value: 'prompt', label: 'Ask first', detail: 'Each step waits as a card you approve, edit or reject.', icon: ShieldCheck, tone: 'text-foreground' },
  { value: 'allow', label: 'Go ahead', detail: 'Steps run at once. Memory changes still ask.', icon: ShieldAlert, tone: 'text-amber-600 dark:text-amber-400' },
  { value: 'deny', label: 'Refuse', detail: 'Every step is refused unless a rule allows it.', icon: ShieldX, tone: 'text-destructive' }
]
type ModelChoice = { id: string; label: string; description?: string }
function ModelMenu({ agent, value, models, allowCustom, onChange, defaultChoice, search = 'models' }: { agent: string; value: string; models: ModelChoice[]; allowCustom?: boolean; onChange: (id: string) => void; defaultChoice?: ModelChoice; search?: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const all: ModelChoice[] = [defaultChoice || { id: '', label: 'Default', description: `Whatever ${agent} picks on its own` }, ...models]
  if (value && !all.some((m) => m.id === value)) all.push({ id: value, label: value, description: 'Typed in' })
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter((m) => terms.every((t) => `${m.id} ${m.label} ${m.description || ''}`.toLowerCase().includes(t)))
  const current = all.find((m) => m.id === value) || all[0]
  const pick = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }
  const typed = query.trim()
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), setQuery(''))}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(inputClass, 'flex h-auto min-h-8 w-72 items-center gap-2 py-1.5 text-left')}>
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-[13px]">{current.label}</span>
            {current.description && <span className="truncate text-[11px] text-muted-foreground">{current.description}</span>}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col p-0">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) pick(shown[0].id)
            else if (e.key === 'Enter' && allowCustom && typed) pick(typed)
          }}
          placeholder={allowCustom ? `Search or type a ${search.replace(/s$/, '')}…` : `Search ${search}…`}
          aria-label="Search models"
          className="h-9 border-0 border-b border-border/60 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div role="listbox" aria-label="Models" className="scrollbar-sleek max-h-72 overflow-y-auto p-1">
          {shown.map((m) => (
            <button
              key={m.id || 'default'}
              type="button"
              role="option"
              aria-selected={m.id === value}
              onClick={() => pick(m.id)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/10"
            >
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm">{m.label}</span>
                {m.description && <span className="truncate text-xs text-muted-foreground">{m.description}</span>}
              </span>
              <span className="mt-0.5 flex size-3.5 shrink-0">{m.id === value && <Check className="size-3.5 text-muted-foreground" />}</span>
            </button>
          ))}
          {allowCustom && typed && !all.some((m) => m.id === typed) && (
            <button type="button" onClick={() => pick(typed)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/10">
              <Plus className="size-3.5 text-muted-foreground" /> Use <span className="font-mono">{typed}</span>
            </button>
          )}
          {!shown.length && !(allowCustom && typed) && <p className="px-2 py-3 text-center text-xs text-muted-foreground">Nothing matches.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const RULE_THEN: [string, string][] = [
  ['allow', 'Allow'],
  ['prompt', 'Ask'],
  ['deny', 'Deny']
]

export function DispatchSection({ data, reload }: Props) {
  const d = D(data).dispatch || {}
  const agents = (D(data).agents || []) as { name: string; label: string }[]
  const runsOnList = ((D(data).dispatch_runs_on || ['claude']) as string[]).map((name) => agents.find((a) => a.name === name) || { name, label: name })
  const initial = () => ({
    instructions: d.instructions || '',
    agent: d.agent || '',
    runs_on: d.runs_on || 'claude',
    model: d.model || '',
    codex_model: d.codex_model || '',
    approval: ({ ask: 'prompt', auto: 'allow' } as Record<string, string>)[d.approval] || d.approval || 'prompt'
  })
  const initialRules = (): Rule[] =>
    (d.rules || []).map((r: Partial<Rule>) => ({ approval: 'prompt', ...r, action: r.action || 'any', machine: r.machine || 'any', folder: r.folder || '' }))
  const [v, setV] = useState(initial)
  const [rules, setRules] = useState<Rule[]>(initialRules)
  const [installedOn, setInstalledOn] = useState<Record<string, string[]> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    Promise.all(
      data.machines.map((m) =>
        api<{ installed: string[] }>('GET', `/machines/${encodeURIComponent(m.name)}/agents`).then(
          (r): [string, string[]] => [m.name, r.installed],
          () => null
        )
      )
    ).then((found) => {
      const ok = found.filter(Boolean) as [string, string[]][]
      if (ok.length) setInstalledOn(Object.fromEntries(ok))
    })
  }, [])
  const where = (a: { name: string }) => (installedOn ? Object.keys(installedOn).filter((m) => installedOn[m].includes(a.name)) : [])
  const fallback = agents.find((a) => a.name === D(data).default_agent)
  const here = data.machines.find((m: any) => m.local)
  const known = here && installedOn?.[here.name]
  const runsName = runsOnList.find((a) => a.name === v.runs_on)?.label || v.runs_on
  const codexListed = (D(data).codex_models || []) as string[]
  const codexNote = v.runs_on === 'codex' && v.codex_model.trim() && codexListed.length && !codexListed.includes(v.codex_model.trim())
  const claudeModels = catalogFor('claude')?.models || []
  const modelName =
    v.runs_on === 'codex' ? v.codex_model.trim() || "Codex's default model" : claudeModels.find((m) => m.id === v.model)?.label || v.model || "Claude Code's default model"
  const approval = APPROVALS.find((x) => x.value === v.approval) || APPROVALS[0]
  const dirty = JSON.stringify([v, rules]) !== JSON.stringify([initial(), initialRules()])
  const missing = known && !known.includes(v.runs_on)
  const setRule = (i: number, change: Partial<Rule>) =>
    setRules((list) =>
      list.map((r, j) => {
        if (j !== i) return r
        const next = { ...r, ...change }
        if (change.action && UNPLACED.has(change.action)) Object.assign(next, { machine: 'any', folder: '' })
        return next
      })
    )
  const save = async () => {
    setBusy(true)
    try {
      await api('POST', '/api/settings/dispatch', { ...v, codex_model: v.codex_model.trim(), rules: rules.map((r) => ({ ...r, folder: r.folder.trim() })) })
      const before = d.runs_on || 'claude'
      saved(
        v.runs_on === before
          ? 'Dispatch settings saved. They apply from the next message.'
          : `Dispatch settings saved. New conversations start on ${runsName}, and open ones carry on where they started.`
      )
      reload()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const discard = () => {
    setV(initial())
    setRules(initialRules())
  }
  const follow = (path: string) => {
    history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  const ApprovalIcon = approval.icon

  return (
    <Section title="Dispatch" description="The agent you talk to on the Dispatch page. It reads your machines and sessions and proposes the steps they take.">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Bot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">
            {runsName} <span className="font-normal text-muted-foreground">· {modelName}</span>
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ApprovalIcon className={cn('size-3.5', approval.tone)} /> {approval.label}: {approval.detail}
            {rules.length > 0 && <span>· {rules.length === 1 ? '1 rule' : `${rules.length} rules`}</span>}
          </p>
          {missing && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="size-3.5" /> {runsName} is not installed on {here!.name}, where Dispatch runs, so it cannot answer until it is.
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => follow('/ui/dispatch')}>
          <ExternalLink /> Open Dispatch
        </Button>
      </div>

      <Group title="Agent" description="Dispatch only uses Yardbell's own tools, whichever agent it runs on. A conversation stays on the agent it started on; a new model applies from the next message.">
        <div className="grid gap-2 py-4 sm:grid-cols-2">
          {runsOnList.map((a) => {
            const on = v.runs_on === a.name
            const absent = known && !known.includes(a.name)
            return (
              <button
                key={a.name}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setV({ ...v, runs_on: a.name })}
                className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors', on ? 'border-foreground ring-2 ring-foreground/15' : 'border-border hover:border-foreground/30')}
              >
                <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
                <span className="grid min-w-0 flex-1">
                  <span className="text-[13px] font-medium">{a.label}</span>
                  <span className={cn('text-[11px]', absent ? 'text-destructive' : 'text-muted-foreground')}>
                    {!known ? 'Checking this machine…' : absent ? `Not found on ${here!.name}` : `Installed on ${here!.name}`}
                  </span>
                </span>
                {on && <Check className="size-4 shrink-0" />}
              </button>
            )
          })}
        </div>
        <Row
          label="Model"
          description={v.runs_on === 'codex' ? 'Pick one Codex lists for your account, or type another.' : 'The model Dispatch thinks with. Sessions it starts pick their own.'}
          control={
            <ModelMenu
              agent={runsName}
              value={v.runs_on === 'codex' ? v.codex_model : v.model}
              models={
                v.runs_on === 'codex'
                  ? [...(catalogFor('codex')?.models || []).map((m) => ({ id: m.id, label: m.label, description: m.description })), ...codexListed.filter((id) => !catalogFor('codex')?.models.some((m) => m.id === id)).map((id) => ({ id, label: id, description: 'Listed by Codex for your account' }))]
                  : claudeModels.map((m) => ({ id: m.id, label: m.label, description: m.description }))
              }
              allowCustom={v.runs_on === 'codex'}
              onChange={(id) => setV(v.runs_on === 'codex' ? { ...v, codex_model: id } : { ...v, model: id })}
            />
          }
        />
        {codexNote && (
          <p className="flex items-center gap-1.5 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle className="size-3.5" /> Codex does not list {v.codex_model.trim()} for your account, so it may refuse it.
          </p>
        )}
        <Row
          label="Agent for new sessions"
          description="What Dispatch starts when you don't name an agent."
          control={
            <ModelMenu
              agent=""
              search="agents"
              value={v.agent}
              defaultChoice={{ id: '', label: `Default agent${fallback ? ` (${fallback.label})` : ''}`, description: "Yardbell's default for new sessions" }}
              models={agents
                .filter((a) => !installedOn || where(a).length || a.name === v.agent)
                .map((a) => {
                  const on = where(a)
                  return { id: a.name, label: a.label, description: !installedOn ? undefined : on.length ? `Installed on ${on.join(', ')}` : 'Not installed anywhere' }
                })}
              onChange={(agent) => setV({ ...v, agent })}
            />
          }
        />
      </Group>

      <Group title="Approvals" description="What happens when Dispatch wants to start, stop or type into a session, push, merge or run anything. Each step shows up in the conversation as a card.">
        <div role="radiogroup" aria-label="Approvals" className="grid gap-2 py-4 sm:grid-cols-3">
          {APPROVALS.map((x) => {
            const on = v.approval === x.value
            const Icon = x.icon
            return (
              <button
                key={x.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setV({ ...v, approval: x.value })}
                className={cn('grid gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors', on ? 'border-foreground ring-2 ring-foreground/15' : 'border-border hover:border-foreground/30')}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <Icon className={cn('size-4', x.tone)} /> {x.label}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">{x.detail}</span>
              </button>
            )
          })}
        </div>
      </Group>

      <Group
        title="Rules"
        description="Exceptions to the approval above, for particular steps, machines or folders. Deny always wins; otherwise the most specific rule wins. A folder is a name from the folder list, like acme/web, or a path, and * matches any part of a name."
        action={
          <Button size="sm" variant="outline" onClick={() => setRules([...rules, { action: 'stop_session', machine: 'any', folder: '', approval: 'deny' }])}>
            <Plus /> Add rule
          </Button>
        }
      >
        {!rules.length && (
          <EmptyState icon={ListChecks} title="No rules">
            Every step follows the approval above. A rule can, say, always allow starting sessions on one machine, or always refuse stopping them.
          </EmptyState>
        )}
        {rules.map((r, i) => {
          const placed = !UNPLACED.has(r.action)
          return (
            <div key={i} className="group/rule flex items-start gap-3 py-3 text-[13px]">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
                <span className="flex items-center gap-2">
                  <span className="whitespace-nowrap text-muted-foreground">When Dispatch wants to</span>
                  <select value={r.action} onChange={(e) => setRule(i, { action: e.target.value })} aria-label="Step" className={cn(inputClass, 'w-44')}>
                    {Object.entries(RULE_STEPS).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </span>
                {placed && (
                  <>
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">on</span>
                      <select value={r.machine} onChange={(e) => setRule(i, { machine: e.target.value })} aria-label="Machine" className={cn(inputClass, 'w-32')}>
                        <option value="any">any machine</option>
                        {data.machines.map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">in</span>
                      <input value={r.folder} onChange={(e) => setRule(i, { folder: e.target.value })} aria-label="Folder" placeholder="any folder" autoCapitalize="off" spellCheck={false} className={cn(inputClass, 'w-32 font-mono')} />
                    </span>
                  </>
                )}
              </div>
              <span className="flex shrink-0 items-center gap-1.5">
                <Segmented label="Then" value={r.approval} onChange={(approval) => setRule(i, { approval })} options={RULE_THEN} />
                <button
                  type="button"
                  aria-label="Remove rule"
                  title="Remove rule"
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </span>
            </div>
          )
        })}
      </Group>

      <Group title="Instructions" description="Added to Dispatch's prompt for every conversation, and followed before its own defaults.">
        <div className="grid gap-1.5 py-4">
          <textarea
            rows={6}
            maxLength={4000}
            value={v.instructions}
            onChange={(e) => setV({ ...v, instructions: e.target.value })}
            placeholder={'acme/web work goes to devbox unless it is down.\nStart frontend tasks with codex.\nAlways create a branch named after the ticket, like eng-1234-short-name.'}
            className={cn(areaClass, 'font-mono text-[12.5px] leading-relaxed')}
          />
          <p className="flex justify-between gap-3 text-[11px] text-muted-foreground">
            <span>Where repositories live, which machine suits which work, branch naming, and anything you find yourself repeating.</span>
            <span className="shrink-0 tabular-nums">{v.instructions.length} / 4000</span>
          </p>
        </div>
      </Group>

      <Memory />

      {dirty && (
        <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-xl border border-border bg-popover/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <span className="size-2 rounded-full bg-amber-500" />
          <span className="flex-1 text-[13px]">Unsaved changes to Dispatch</span>
          <Button size="sm" variant="ghost" onClick={discard}>
            Discard
          </Button>
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </Section>
  )
}

type MemoryData = {
  file?: string
  bytes: number
  max_bytes: number
  omitted: number
  entries: string[]
  history: { change: string; old?: string; entry?: string; at: string; by: string; reason?: string }[]
  error?: string
}
const MEMORY_DID: Record<string, string> = { add: 'Added', replace: 'Changed', forget: 'Forgot' }
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

function Memory() {
  const [m, setM] = useState<MemoryData | null>(null)
  const [form, setForm] = useState<{ old: string | null; entry: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    api<MemoryData>('GET', '/dispatch/memory').then((x) => {
      if (x.error) toast.error(x.error)
      setM(x)
    }, fail)
  }, [])
  useEffect(() => {
    if (form) box.current?.focus()
  }, [Boolean(form)])
  const change = async (body: Record<string, unknown>, done: string) => {
    setM(await api<MemoryData>('POST', '/dispatch/memory', body))
    toast(done)
  }
  if (!m) return null
  const pct = Math.min(100, Math.round((m.bytes / m.max_bytes) * 100))
  return (
    <Group
      title="Memory"
      description={
        <>
          What Dispatch has learned: where repositories live, conventions and your corrections. It reads this every turn; your instructions win when they disagree.
          Kept in <code className="font-mono">{m.file || 'memory.md'}</code>, which only your account can read.
        </>
      }
      action={
        <Button size="sm" variant="outline" onClick={() => setForm({ old: null, entry: '' })}>
          <Plus /> Add entry
        </Button>
      }
    >
      <div className="flex items-center gap-3 py-3 text-xs text-muted-foreground">
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-status-warning' : 'bg-status-success')}
            style={{ width: `${Math.max(pct, 1)}%` }}
          />
        </div>
        {kb(m.bytes)} of {kb(m.max_bytes)} used
      </div>
      {m.omitted > 0 && (
        <p className="py-3 text-xs text-status-warning-text">
          <strong>The memory is over its size cap.</strong> Dispatch reads only the first entries that fit, and leaves out the last{' '}
          {m.omitted === 1 ? 'one' : m.omitted}. Delete or shorten some.
        </p>
      )}
      {form && (
        <div className="grid gap-2 py-3">
          <Field label={form.old === null ? 'New entry' : 'Entry'} hint="One short sentence each. Up to 500 characters.">
            <textarea
              ref={box}
              rows={2}
              maxLength={500}
              value={form.entry}
              onChange={(e) => setForm({ ...form, entry: e.target.value })}
              placeholder="Always use the shared docker stack on hp."
              className={areaClass}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !form.entry.trim()}
              onClick={async () => {
                setBusy(true)
                try {
                  await change(
                    form.old === null ? { change: 'add', entry: form.entry.trim() } : { change: 'replace', old: form.old, entry: form.entry.trim() },
                    'Saved. Dispatch reads it from the next message.'
                  )
                  setForm(null)
                } catch (e) {
                  fail(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Save entry
            </Button>
          </div>
        </div>
      )}
      {!m.entries.length && !form && (
        <EmptyState icon={Brain} title="Nothing remembered yet">
          When you correct Dispatch or tell it something that lasts, it proposes an entry for you to approve.
        </EmptyState>
      )}
      {m.entries.map((entry) => (
        <div key={entry} className="group/mem flex items-start gap-3 py-2.5">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed">{entry}</p>
          <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover/mem:opacity-100 focus-within:opacity-100">
            <button type="button" aria-label="Edit entry" title="Edit" onClick={() => setForm({ old: entry, entry })} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete entry"
              title="Delete"
              onClick={async () => {
                if (!(await confirmAction({ title: 'Delete this entry?', body: `Dispatch stops reading "${entry}" from the next message. The history keeps a record of it.`, confirm: 'Delete', danger: true }))) return
                change({ change: 'forget', old: entry }, 'Deleted.').catch(fail)
              }}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </span>
        </div>
      ))}
      {m.history.length > 0 && (
        <details className="py-3">
          <summary className="cursor-pointer text-xs font-medium">History of changes ({m.history.length})</summary>
          <ol className="mt-2 grid gap-3">
            {m.history.map((h, i) => (
              <li key={i} className="grid gap-1 text-xs">
                <p className="text-muted-foreground">
                  {MEMORY_DID[h.change] || 'Changed'} {new Date(h.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                  {h.by === 'you' ? 'by you, here' : 'proposed by Dispatch, approved by you'}
                </p>
                {h.change !== 'add' && h.old && (
                  <del className="rounded bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive no-underline">- {h.old}</del>
                )}
                {h.change !== 'forget' && h.entry && (
                  <ins className="rounded bg-status-success/10 px-2 py-1 font-mono text-[11px] text-status-success-text no-underline">+ {h.entry}</ins>
                )}
                {h.reason && <p className="text-muted-foreground">{h.reason}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </Group>
  )
}
