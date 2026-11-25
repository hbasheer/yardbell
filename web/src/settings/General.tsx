import { useEffect, useState } from 'react'
import { Bell, Copy, ExternalLink, KeyRound, Laptop, Moon, RefreshCw, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { api } from '@/pipelines/model'
import { ALL_ITEMS, readItems, setStatusItems, type Item } from '@/shell/StatusBar'
import { setThemeChoice, themeChoice, type Theme } from '@/shell/theme'
import { setTreeOptions, useTreeOptions } from '@/shell/tree-options'
import { MODE_EVENT, setWorkspaceMode, workspaceMode, type Mode } from '@/workspace/layout'
import { Field, Group, inputClass, Row, Section, Segmented, SwitchRow } from './ui'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'

const ZOOM_KEY = 'yardbell.ui.zoom'
const MOTION_KEY = 'yardbell.ui.reduceMotion'

// The interface size zooms the app root and, by CSS, each menu and dialog inside its own portal. Zooming
// the body instead puts menus in the wrong place, because they are measured zoomed and then zoomed again.
// The app's height is divided by the same amount so a larger size never pushes it past the window.
export function applyDisplayPrefs() {
  const zoom = Number(localStorage.getItem(ZOOM_KEY) || '1') || 1
  const still = localStorage.getItem(MOTION_KEY) === '1'
  document.body.style.zoom = ''
  const root = document.getElementById('root')
  if (root) root.style.zoom = zoom === 1 ? '' : String(zoom)
  document.documentElement.style.setProperty('--ui-zoom', String(zoom))
  const docs = [
    document,
    ...[...document.querySelectorAll('iframe')].map((f) => {
      try {
        return f.contentDocument
      } catch {
        return null
      }
    })
  ].filter(Boolean) as Document[]
  for (const d of docs) d.documentElement.classList.toggle('reduce-motion', still)
}

function ThemeTile({
  value,
  current,
  label,
  icon: Icon,
  onPick
}: {
  value: Theme
  current: Theme
  label: string
  icon: typeof Sun
  onPick: (t: Theme) => void
}) {
  const dark = value === 'dark'
  return (
    <button
      type="button"
      role="radio"
      aria-checked={current === value}
      onClick={() => onPick(value)}
      className={cn(
        'grid w-36 gap-2 rounded-lg border p-2 text-left transition-colors',
        current === value ? 'border-foreground ring-2 ring-foreground/15' : 'border-border hover:border-foreground/30'
      )}
    >
      <span
        className={cn(
          'grid h-16 grid-cols-[30%_1fr] overflow-hidden rounded-md border',
          value === 'system'
            ? 'border-border bg-[linear-gradient(135deg,#fafafa_50%,#171717_50%)]'
            : dark
              ? 'border-white/10 bg-[#0a0a0a]'
              : 'border-black/10 bg-white'
        )}
      >
        {value !== 'system' && (
          <>
            <span className={dark ? 'bg-[#1c1c1c]' : 'bg-[#f5f5f5]'} />
            <span className="grid content-start gap-1 p-1.5">
              <span className={cn('h-1.5 w-3/4 rounded-full', dark ? 'bg-white/30' : 'bg-black/20')} />
              <span className={cn('h-1.5 w-1/2 rounded-full', dark ? 'bg-white/15' : 'bg-black/10')} />
            </span>
          </>
        )}
      </span>
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5 text-muted-foreground" /> {label}
      </span>
    </button>
  )
}

export function Appearance() {
  const [theme, setTheme] = useState<Theme>(themeChoice)
  const [zoom, setZoom] = useState(() => localStorage.getItem(ZOOM_KEY) || '1')
  const [still, setStill] = useState(() => localStorage.getItem(MOTION_KEY) === '1')
  const [items, setItems] = useState<Item[]>(readItems)
  const [mode, setMode] = useState<Mode>(workspaceMode)
  const o = useTreeOptions()
  useEffect(() => {
    const heard = () => setMode(workspaceMode())
    window.addEventListener(MODE_EVENT, heard)
    return () => window.removeEventListener(MODE_EVENT, heard)
  }, [])

  const pickTheme = (t: Theme) => {
    setTheme(t)
    setThemeChoice(t)
  }
  const pickZoom = (z: string) => {
    setZoom(z)
    localStorage.setItem(ZOOM_KEY, z)
    applyDisplayPrefs()
  }

  return (
    <Section title="Appearance" description="How Yardbell looks on this device. These are kept in this browser, so your phone and computer can differ.">
      <Group title="Interface">
        <div className="py-3">
          <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-3">
            <ThemeTile value="system" current={theme} label="System" icon={Laptop} onPick={pickTheme} />
            <ThemeTile value="light" current={theme} label="Light" icon={Sun} onPick={pickTheme} />
            <ThemeTile value="dark" current={theme} label="Dark" icon={Moon} onPick={pickTheme} />
          </div>
        </div>
        <Row
          label="Interface size"
          description="Makes text and controls larger or smaller on this device."
          control={
            <Segmented
              label="Interface size"
              value={zoom}
              onChange={pickZoom}
              options={[
                ['0.9', '90%'],
                ['1', '100%'],
                ['1.1', '110%'],
                ['1.25', '125%']
              ]}
            />
          }
        />
        <SwitchRow
          label="Reduce motion"
          description="Turns off spinners that move, fades and other animation."
          checked={still}
          onChange={(on) => {
            setStill(on)
            localStorage.setItem(MOTION_KEY, on ? '1' : '0')
            applyDisplayPrefs()
          }}
        />
      </Group>

      <Group title="Window & sidebar">
        <Row
          label="Workspace"
          description="One set of tabs for every session, or a set for each folder as in Orca."
          control={
            <Segmented
              label="Workspace"
              value={mode}
              onChange={(m) => setWorkspaceMode(m)}
              options={[
                ['shared', 'One for everything'],
                ['folder', 'One per folder']
              ]}
            />
          }
        />
        <Row
          label="Group sessions by"
          control={
            <Segmented
              label="Group sessions by"
              value={o.group}
              onChange={(group) => setTreeOptions({ group })}
              options={[
                ['machine', 'Machine'],
                ['status', 'Status']
              ]}
            />
          }
        />
        <Row
          label="Sort by"
          control={
            <select value={o.sort} onChange={(e) => setTreeOptions({ sort: e.target.value as typeof o.sort })} className={cn(inputClass, 'w-44')}>
              <option value="manual">Manual</option>
              <option value="name">Name</option>
              <option value="activity">Agent activity</option>
            </select>
          }
        />
        <Row
          label="Card style"
          control={
            <Segmented
              label="Card style"
              value={o.compact ? 'compact' : 'comfortable'}
              onChange={(v) => setTreeOptions({ compact: v === 'compact' })}
              options={[
                ['comfortable', 'Comfortable'],
                ['compact', 'Compact']
              ]}
            />
          }
        />
      </Group>

      <Group title="Status bar" description="What the bar at the bottom shows. Right-clicking the bar changes this too.">
        {ALL_ITEMS.map((i) => (
          <SwitchRow
            key={i.id}
            label={i.label}
            checked={items.includes(i.id)}
            onChange={(on) => {
              const next = on ? [...items, i.id] : items.filter((x) => x !== i.id)
              setItems(next)
              setStatusItems(next)
            }}
          />
        ))}
      </Group>
    </Section>
  )
}

const AWAKE: [string, string, string][] = [
  ['on', 'On', 'Keep this computer awake continuously'],
  ['agent', 'While agents work', 'Stay awake while an agent is working on this computer'],
  ['off', 'Off', 'Let the computer sleep as usual']
]

export function Power({ awake, reload }: { awake?: { mode: string; holding: boolean; error?: string | null; tool?: string }; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const set = async (mode: string) => {
    setBusy(true)
    try {
      await api('POST', '/api/settings/keep-awake', { mode })
      toast('Saved')
      reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Power" description="Stops the computer Yardbell runs on from sleeping, so sessions keep going and stay reachable from your phone.">
      <Group>
        <Row
          label="Keep computer awake"
          description={awake ? `${awake.holding ? 'Holding it awake now' : 'Not holding it awake now'}${awake.tool ? `, with ${awake.tool}` : ''}.` : undefined}
          control={
            <Segmented label="Keep computer awake" value={awake?.mode || 'off'} onChange={(m) => !busy && set(m)} options={AWAKE.map(([v, l]) => [v, l])} />
          }
        />
        {awake?.error && <p className="py-3 text-xs text-destructive">{awake.error}</p>}
      </Group>
    </Section>
  )
}

export function Security() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const close = () => {
    setOpen(false)
    setCurrent('')
    setNext('')
    setRepeat('')
  }
  const change = async () => {
    if (next !== repeat) return toast.error('The two new passcodes do not match')
    setBusy(true)
    try {
      await api('POST', '/api/settings/passcode', { current, new: next })
      setCurrent('')
      setNext('')
      setRepeat('')
      setOpen(false)
      toast('Passcode changed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Security" description="How phones and browsers log in to this server.">
      <Group title="Passcode">
        <Row
          label={
            <span className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" /> Passcode
            </span>
          }
          description="What every phone and browser types to log in. Devices already logged in stay logged in."
          control={
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Change…
            </Button>
          }
        />
      </Group>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Change passcode</DialogTitle>
          <DialogDescription className="text-xs">Use at least 6 characters. Devices already logged in stay logged in; log them out below if you need to.</DialogDescription>
          <div className="grid gap-3">
            <Field label="Current passcode">
              <input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} />
            </Field>
            <Field label="New passcode">
              <input type="password" autoComplete="new-password" minLength={6} value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Repeat new passcode" hint={repeat && next !== repeat ? <span className="text-destructive">The two new passcodes do not match.</span> : undefined}>
              <input type="password" autoComplete="new-password" minLength={6} value={repeat} onChange={(e) => setRepeat(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || !current || next.length < 6 || next !== repeat} onClick={change}>
              {busy ? 'Changing…' : 'Change passcode'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Group title="Devices">
        <Row
          label="Log out everywhere"
          description="Signs out every phone and browser, except this one."
          control={
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                if (
                  !(await confirmAction({
                    title: 'Sign out every other phone and browser?',
                    body: 'They need the passcode to log in again.',
                    confirm: 'Log out everywhere',
                    danger: true
                  }))
                )
                  return
                try {
                  await api('POST', '/api/settings/logout-all', {})
                  toast('Every other device is signed out')
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
            >
              Log out everywhere
            </Button>
          }
        />
      </Group>
    </Section>
  )
}

type About = {
  version: string
  build: string
  machine: string
  address: string
  os: string
  arch: string
  container?: boolean
  uptime_secs: number
  started_at: number
  config: string
  state: string
  links: { release: string; changelog: string; docs: string }
}

const uptime = (secs: number) => {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return (
    [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} hour${h === 1 ? '' : 's'}`, !d && `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(', ') ||
    'just started'
  )
}

export function AboutSection() {
  const [a, setA] = useState<About | null>(null)
  const [update, setUpdate] = useState<{ state: string; latest?: string; url?: string; reason?: string } | null>(null)
  const check = () => {
    setUpdate(null)
    api<{ state: string; latest?: string; url?: string; reason?: string }>('GET', '/app/about/updates').then(setUpdate, (e) =>
      setUpdate({ state: 'unknown', reason: e.message })
    )
  }
  useEffect(() => {
    api<About>('GET', '/app/about').then(setA, (e) => toast.error(e.message))
    check()
  }, [])
  if (!a) return <p className="text-sm text-muted-foreground">Reading…</p>
  const facts: [string, React.ReactNode][] = [
    ['Build', <code key="b">{a.build}</code>],
    [
      'Machine',
      <>
        {a.machine} <code>{a.address}</code>
      </>
    ],
    ['System', `${a.os} · ${a.arch}${a.container ? ' · in a container' : ''}`],
    ['Running for', uptime(a.uptime_secs)],
    ['Config', <code key="c">{a.config}</code>],
    ['State', <code key="s">{a.state}</code>]
  ]
  const copyDetails = () => {
    const text = [`Yardbell ${a.version}`, `Build ${a.build}`, `${a.os} · ${a.arch}${a.container ? ' · in a container' : ''}`, `Running for ${uptime(a.uptime_secs)}`].join('\n')
    navigator.clipboard.writeText(text).then(
      () => toast('Copied the version details'),
      () => toast(text)
    )
  }
  const status = !update ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <RefreshCw className="size-3 animate-spin" /> Checking for updates…
    </span>
  ) : update.state === 'available' ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
      <span className="size-1.5 rounded-full bg-sky-500" /> {update.latest} is available
    </span>
  ) : update.state === 'up_to_date' ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-status-success-border bg-status-success-background px-2 py-0.5 text-[11px] font-medium text-status-success">
      <span className="size-1.5 rounded-full bg-status-success" /> Up to date
    </span>
  ) : (
    <span className="text-xs text-muted-foreground" title={update.reason}>
      Couldn't check for updates
    </span>
  )
  return (
    <Section title="About" description="The version running on this server, and where it keeps its settings and state.">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-foreground text-background">
          <Bell className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">Yardbell</span>
            <span className="font-mono text-sm text-muted-foreground">{a.version}</span>
          </div>
          <div className="mt-1">{status}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {update?.state === 'available' && (
            <Button size="sm" asChild>
              <a href={update.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Get {update.latest}
              </a>
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!update} onClick={check}>
            <RefreshCw /> Check for updates
          </Button>
        </div>
      </div>
      <Group title="This server">
        {facts.map(([k, v]) => (
          <Row key={k} label={k} control={<span className="max-w-[28rem] text-right text-[13px] break-all [&_code]:font-mono [&_code]:text-xs">{v}</span>} />
        ))}
        <div className="flex justify-end py-3">
          <Button size="sm" variant="ghost" onClick={copyDetails}>
            <Copy /> Copy details
          </Button>
        </div>
      </Group>
      <Group title="Learn more">
        {(
          [
            [a.links.release, `Release notes for ${a.version}`, 'What changed in this version.'],
            [a.links.changelog, 'Changelog', 'Every release, newest first.'],
            [a.links.docs, 'Documentation', 'Setting up machines, Dispatch, pipelines and the phone app.']
          ] as const
        ).map(([href, text, about]) => (
          <Row
            key={text}
            label={text}
            description={about}
            control={
              <Button size="sm" variant="ghost" asChild>
                <a href={href} target="_blank" rel="noopener noreferrer">
                  Open <ExternalLink />
                </a>
              </Button>
            }
          />
        ))}
      </Group>
    </Section>
  )
}
