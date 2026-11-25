// Settings laid out as Orca lays it out (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bell,
  Bot,
  Boxes,
  Cable,
  GitBranch,
  Info,
  Mic,
  Network,
  Palette,
  Plug,
  Power as PowerIcon,
  Search,
  Server,
  Shield,
  Smartphone,
  SquareTerminal,
  Globe,
  Workflow,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/class-names'
import { api } from '@/pipelines/model'
import { AboutSection, Appearance, Power, Security } from './General'
import { Integrations, type SettingsData } from './Integrations'
import { DiagramsSection, DispatchSection, HealthSection, McpSection, MeshSection, PairSection, PhoneSection, SetupSection } from './Sections'
import { setSavedNote, useSavedNote } from './saved'
import { StatsSection, TriggersSection } from './More'
import { VoiceSection } from './Voice'
import { MachinesSection } from './Machines'
import { AgentsSection } from './Agents'
import { DesktopNotifications } from './Notifications'
import { BrowserSection, TerminalSection } from './Terminal'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

type Entry = { id: string; title: string; icon: LucideIcon; words: string; native?: boolean }
const GROUPS: { title: string; items: Entry[] }[] = [
  {
    title: 'General',
    items: [
      { id: 'appearance', title: 'Appearance', icon: Palette, words: 'theme dark light size zoom motion status bar workspace sidebar', native: true },
      { id: 'terminal', title: 'Terminal', icon: SquareTerminal, words: 'cursor font size theme colours dracula scrollback copy paste padding line height', native: true },
      { id: 'browser', title: 'Browser', icon: Globe, words: 'search engine home page zoom', native: true },
      { id: 'power', title: 'Power', icon: PowerIcon, words: 'keep awake sleep', native: true },
      { id: 'phone', title: 'Notifications', icon: Bell, words: 'phone push notify alerts desktop sound bell', native: true },
      { id: 'security', title: 'Security', icon: Shield, words: 'passcode password log out devices', native: true },
      { id: 'about', title: 'About', icon: Info, words: 'version update build', native: true }
    ]
  },
  {
    title: 'Machines',
    items: [
      { id: 'machines', title: 'Machines', icon: Server, words: 'ssh host port prefix folder', native: true },
      { id: 'mesh', title: 'Mesh VPN', icon: Network, words: 'tailscale nordvpn meshnet', native: true },
      { id: 'pair', title: 'Connect a phone', icon: Smartphone, words: 'pair app qr mobile', native: true }
    ]
  },
  {
    title: 'Agents',
    items: [
      { id: 'agents', title: 'Agents', icon: Boxes, words: 'claude codex gemini opencode aider goose install agent cli open source', native: true },
      { id: 'dispatch', title: 'Dispatch', icon: Bot, words: 'instructions approval rules model memory', native: true },
      { id: 'stats-usage', title: 'Stats & Usage', icon: BarChart3, words: 'tokens limits usage', native: true },
      { id: 'voice', title: 'Voice', icon: Mic, words: 'dictation whisper speech', native: true },
      { id: 'triggers', title: 'Triggers', icon: Zap, words: 'schedule cron task', native: true },
      { id: 'worktree-setup', title: 'Worktree setup', icon: GitBranch, words: 'setup command install', native: true },
      { id: 'diagrams', title: 'Diagrams', icon: Workflow, words: 'archify', native: true },
      { id: 'health', title: 'Health checks', icon: Activity, words: 'ci memory queued waiting', native: true }
    ]
  },
  {
    title: 'Integrations',
    items: [
      {
        id: 'integrations',
        title: 'Integrations',
        icon: Plug,
        words: 'github gitlab linear jira trello mcp connections tokens secrets pull requests merge',
        native: true
      },
      { id: 'mcp', title: 'Let agents use Yardbell', icon: Cable, words: 'mcp token server', native: true }
    ]
  }
]
const ALL = GROUPS.flatMap((g) => g.items)
// Old addresses keep working.
const ALIASES: Record<string, string> = { connections: 'integrations', 'pull-requests': 'integrations', servers: 'integrations' }

const sectionOf = () => {
  const id = location.hash.slice(1)
  return ALL.find((e) => e.id === (ALIASES[id] || id))?.id || 'appearance'
}

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [section, setSection] = useState(sectionOf)
  const [query, setQuery] = useState('')
  const [data, setData] = useState<SettingsData | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api<SettingsData>('GET', '/api/settings')
      setData(d)
      setError('')
      return d
    } catch (e) {
      setError((e as Error).message)
      return null
    }
  }, [])
  useEffect(() => {
    load()
    const changed = () => setSection(sectionOf())
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [load])
  useEffect(() => {
    const find = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      document.getElementById('settings-search')?.focus()
    }
    document.addEventListener('keydown', find)
    return () => document.removeEventListener('keydown', find)
  }, [])

  const go = (id: string) => {
    history.replaceState(null, '', `${location.pathname}#${id}`)
    setSection(id)
  }
  const q = query.trim().toLowerCase()
  const entry = ALL.find((e) => e.id === section)!

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-worktree-sidebar-border bg-worktree-sidebar">
        <div className="flex h-12 shrink-0 items-center border-b border-border/60 px-3">
          <button
            type="button"
            onClick={onBack}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-worktree-sidebar-foreground/8 hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to app
          </button>
        </div>
        <div className="border-b border-border/60 px-3 py-3">
          <label className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              id="settings-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const first = ALL.find((x) => `${x.title} ${x.words}`.toLowerCase().includes(q))
                if (first) go(first.id)
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
            <kbd className="rounded border border-border px-1 font-sans text-[10px] text-muted-foreground">
              {/Mac/.test(navigator.platform) ? '⌘F' : 'Ctrl F'}
            </kbd>
          </label>
        </div>
        <nav aria-label="Settings sections" className="scrollbar-sleek min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {GROUPS.map((g) => {
            const items = g.items.filter((e) => !q || `${e.title} ${e.words}`.toLowerCase().includes(q))
            if (!items.length) return null
            return (
              <div key={g.title} className="space-y-1">
                <p className="px-3 pb-1 text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">{g.title}</p>
                {items.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    aria-current={section === e.id ? 'page' : undefined}
                    onClick={() => go(e.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors',
                      section === e.id
                        ? 'bg-worktree-sidebar-accent font-medium text-worktree-sidebar-accent-foreground'
                        : 'text-worktree-sidebar-foreground/70 hover:bg-worktree-sidebar-foreground/8'
                    )}
                  >
                    <e.icon className="size-4 shrink-0" />
                    <span className="truncate">{e.title}</span>
                  </button>
                ))}
              </div>
            )
          })}
          {q && !ALL.some((e) => `${e.title} ${e.words}`.toLowerCase().includes(q)) && (
            <p className="px-3 text-xs text-muted-foreground">No setting matches.</p>
          )}
        </nav>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/60 px-6 text-sm">
          <span className="text-muted-foreground">Settings</span>
          <span className="text-muted-foreground/60">/</span>
          <span className="font-medium">{entry.title}</span>
        </header>
        {entry.native ? (
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 pt-8 pb-16">
              <SavedBar data={data} reload={load} />
              {section === 'appearance' && <Appearance />}
              {section === 'terminal' && <TerminalSection />}
              {section === 'browser' && <BrowserSection />}
              {section === 'security' && <Security />}
              {section === 'about' && <AboutSection />}
              {section === 'power' && (data ? <Power awake={data.keep_awake} reload={load} /> : <Loading error={error} />)}
              {section === 'integrations' && (data ? <Integrations data={data} reload={load} /> : <Loading error={error} />)}
              {section === 'agents' && (data ? <AgentsSection data={data} /> : <Loading error={error} />)}
              {section === 'phone' && (data ? (
                <div className="grid gap-12">
                  <DesktopNotifications machines={(data.machines as { name: string }[]).map((m) => m.name)} />
                  <PhoneSection data={data} reload={load} />
                </div>
              ) : (
                <Loading error={error} />
              ))}
              {section === 'pair' && <PairSection />}
              {section === 'machines' && (data ? <MachinesSection data={data} reload={load} /> : <Loading error={error} />)}
              {section === 'mesh' && (data ? <MeshSection data={data} reload={load} /> : <Loading error={error} />)}
              {section === 'dispatch' &&
                (data ? <DispatchSection key={JSON.stringify((data as any).dispatch)} data={data} reload={load} /> : <Loading error={error} />)}
              {section === 'worktree-setup' && (data ? <SetupSection data={data} /> : <Loading error={error} />)}
              {section === 'diagrams' && <DiagramsSection />}
              {section === 'health' && (data ? <HealthSection data={data} reload={load} /> : <Loading error={error} />)}
              {section === 'stats-usage' && <StatsSection />}
              {section === 'voice' && (data ? <VoiceSection data={data} reload={load} /> : <Loading error={error} />)}
              {section === 'triggers' && (
                <TriggersSection
                  onOpenConversation={(id) => {
                    history.pushState(null, '', `/ui/dispatch?c=${encodeURIComponent(id)}`)
                    window.dispatchEvent(new PopStateEvent('popstate'))
                  }}
                />
              )}
              {section === 'mcp' && (data ? <McpSection data={data} reload={load} /> : <Loading error={error} />)}
            </div>
          </div>
        ) : (
          <iframe
            key={section}
            title={entry.title}
            data-yardbell-host=""
            src={`/settings?bare=1#${section}`}
            className="min-h-0 flex-1 border-0 bg-background"
          />
        )}
      </main>
    </div>
  )
}

// After a save the page offers Undo, and Restart when the change needs Yardbell to start again.
function SavedBar({ data, reload }: { data: SettingsData | null; reload: () => Promise<SettingsData | null> }) {
  const note = useSavedNote()
  const d = data as any
  useEffect(() => {
    if (d?.undo_note && !note) setSavedNote({ title: 'Changed by Dispatch.', text: d.undo_note, restart: false, undo: Boolean(d.can_undo) })
  }, [d?.undo_note])
  if (!note) return null
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13px]">
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">{note.title}</strong> <span className="text-muted-foreground">{note.text}</span>
      </span>
      {note.undo && d?.can_undo !== false && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await api('POST', '/api/settings/undo', {})
              setSavedNote({ title: 'Undone.', text: 'The previous settings are back.', restart: false, undo: false })
              reload()
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        >
          Undo
        </Button>
      )}
      {note.restart && d?.service_installed && (
        <Button
          size="sm"
          onClick={async () => {
            try {
              const res = await api<{ message: string }>('POST', '/api/settings/restart', {})
              toast(res.message)
              setTimeout(() => location.reload(), 4000)
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        >
          Restart Yardbell
        </Button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => setSavedNote(null)} className="text-xs text-muted-foreground hover:text-foreground">
        Dismiss
      </button>
    </div>
  )
}

function Loading({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">Reading your settings…</p>
  )
}
