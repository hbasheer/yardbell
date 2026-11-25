import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useYardbellState } from '@/lib/state'
import { openSession, showFolder } from '@/workspace/layout'
import { closeSession } from '@/workspace/close-session'
import { keyOf } from '@/lib/tree'
import { useWorkspace } from '@/workspace/useWorkspace'
import { NewSession, type NewSessionRequest } from '@/workspace/NewSession'
import { openShell } from '@/lib/actions'
import { ConfirmHost } from '@/lib/confirm'
import { InsightsHost } from '@/insights/Insights'
import { useDesktopNotifications } from '@/lib/notify'
import { Workspace } from '@/workspace/Workspace'
import { PageHost } from './PageHost'
import { PipelinesPage } from '@/pipelines/PipelinesPage'
import { DiagramsPage } from '@/diagrams/DiagramsPage'
import { SettingsPage } from '@/settings/SettingsPage'
import { DispatchPage } from '@/dispatch/DispatchPage'
import { DashboardPage } from '@/dashboard/DashboardPage'
import { applyDisplayPrefs } from '@/settings/General'

const NATIVE: PageId[] = ['dashboard', 'workspace', 'pipeline', 'diagrams', 'settings', 'dispatch']
import { pageOfLegacy, useRoute, type PageId } from './pages'
import { Sidebar, SIDEBAR_WIDTH } from './Sidebar'
import { StatusBar } from './StatusBar'
import { useTheme } from './theme'

type FrameWindow = Window & Record<string, unknown>
const COLLAPSED = 'yardbell.side'

export function App() {
  const { state, live, updated, offline } = useYardbellState()
  const [page, go] = useRoute()
  const backFrom = useRef<PageId>('workspace')
  useEffect(() => {
    if (page !== 'settings') backFrom.current = page
  }, [page])
  useEffect(() => {
    applyDisplayPrefs()
    const again = setInterval(applyDisplayPrefs, 3000)
    return () => clearInterval(again)
  }, [])
  const [theme, cycleTheme] = useTheme()
  const [pending, setPending] = useState<{ id: PageId; search: string } | null>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED) === 'rail')
  const showSidebar = !collapsed && page !== 'settings'
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH.key))
    return saved >= SIDEBAR_WIDTH.min && saved <= SIDEBAR_WIDTH.max ? saved : SIDEBAR_WIDTH.normal
  })
  const resize = (px: number, keep: boolean) => {
    setWidth(px)
    if (!keep) return
    try {
      localStorage.setItem(SIDEBAR_WIDTH.key, String(px))
    } catch {}
  }
  const frames = useRef<Map<PageId, HTMLIFrameElement>>(new Map())
  const workspace = useWorkspace(state)
  const [seenWorkspace, setSeenWorkspace] = useState(page === 'workspace')
  useEffect(() => {
    if (page === 'workspace') setSeenWorkspace(true)
  }, [page])

  // Runs fn in a page's frame once that page has loaded; a page not opened yet gets the deep link
  // instead, which it follows itself on first load.
  const withFrame = useCallback((id: PageId, fn: (w: FrameWindow) => void, deepLink = '') => {
    const frame = frames.current.get(id)
    const win = frame?.contentWindow as FrameWindow | null | undefined
    if (frame && win && win.document.readyState === 'complete') {
      fn(win)
      return
    }
    if (frame) {
      frame.addEventListener('load', () => fn(frame.contentWindow as FrameWindow), { once: true })
      return
    }
    setPending({ id, search: deepLink })
  }, [])

  const openKey = (key: string) => {
    go('workspace')
    workspace.update((l) => openSession(l, key, state))
  }

  useDesktopNotifications(state, openKey)
  useEffect(() => {
    const heard = (e: Event) => {
      const d = (e as CustomEvent<{ machine: string; name: string }>).detail
      if (d?.machine && d.name) openKey(`${d.machine}/${d.name}`)
    }
    window.addEventListener('yardbell-open-session', heard)
    return () => window.removeEventListener('yardbell-open-session', heard)
  })
  const [newSession, setNewSession] = useState<NewSessionRequest | null>(null)
  const startSession = (machine?: string, path?: string) => setNewSession({ machine, path })

  const tree = {
    selected: workspace.focusedKey,
    onSession: openKey,
    onFolder: (machine: string, folder: string, path: string) => {
      go('workspace')
      const at = path || state?.sessions.find((s) => s.machine === machine && s.folder === folder)?.path
      if (at) workspace.update((l) => showFolder(l, machine, at, state))
    },
    onNewSession: (machine: string, path: string) => startSession(machine, path),
    onShell: async (machine: string) => {
      const key = await openShell(machine)
      if (key) openKey(key)
    },
    onClose: (key: string) => {
      const s = state?.sessions.find((x) => keyOf(x) === key)
      if (s) closeSession(s, state, workspace.update)
    },
    onDashboard: (machine: string) => {
      go('dashboard')
      history.replaceState(null, '', `/ui/?machine=${encodeURIComponent(machine)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }

  const openSearch = () => withFrame(page, (w) => (w.YardbellPalette as { open?: () => void } | undefined)?.open?.())

  const collapse = (on: boolean) => {
    setCollapsed(on)
    try {
      if (on) localStorage.setItem(COLLAPSED, 'rail')
      else localStorage.removeItem(COLLAPSED)
    } catch {}
  }

  // A link inside a hosted page asks the shell to go there rather than loading a page inside a page.
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.yardbell !== 'go') return
      const to = pageOfLegacy(String(e.data.href))
      if (!to) return
      go(to.id)
      if (NATIVE.includes(to.id)) {
        history.replaceState(null, '', `${location.pathname}${to.search}`)
        window.dispatchEvent(new PopStateEvent('popstate'))
        return
      }
      if (!to.search) return
      withFrame(
        to.id,
        (w) => {
          w.history.replaceState(null, '', `${location.origin}${new URL(String(e.data.href), location.origin).pathname}${to.search}`)
          const follow = w.followLink as (() => void) | undefined
          if (follow) follow()
          else w.location.reload()
        },
        to.search
      )
    }
    window.addEventListener('message', heard)
    return () => window.removeEventListener('message', heard)
  }, [go, withFrame])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  return (
    <TooltipProvider>
      <div className="grid grid-rows-[minmax(0,1fr)_auto]" style={{ height: 'calc(100dvh / var(--ui-zoom, 1))', gridTemplateColumns: showSidebar ? `${width}px minmax(0,1fr)` : 'minmax(0,1fr)' }}>
        {showSidebar && (
          <Sidebar
            page={page}
            go={go}
            state={state}
            live={live}
            theme={theme}
            cycleTheme={cycleTheme}
            onSearch={openSearch}
            onCollapse={() => collapse(true)}
            tree={tree}
            onNewSession={() => startSession()}
            width={width}
            onWidth={resize}
          />
        )}
        <main className="relative flex min-h-0 min-w-0">
          {collapsed && page !== 'settings' && (
            <button
              type="button"
              onClick={() => collapse(false)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="absolute top-1.5 left-1.5 z-10 grid size-7 place-items-center rounded-md bg-background/80 text-muted-foreground hover:text-foreground"
            >
              <PanelLeft className="size-4" />
            </button>
          )}
          <PageHost page={page} pending={pending} native={NATIVE} onFrames={(f) => (frames.current = f)}>
            {page === 'dashboard' && (
              <div className="absolute inset-0 flex flex-col">
                <DashboardPage
                  state={state}
                  live={live}
                  updated={updated}
                  offline={offline}
                  onOpenSession={(machine, name) => openKey(`${machine}/${name}`)}
                  onNewSession={startSession}
                />
              </div>
            )}
            {page === 'dispatch' && (
              <div className="absolute inset-0 flex flex-col">
                <DispatchPage onOpenSession={(machine, name) => openKey(`${machine}/${name}`)} />
              </div>
            )}
            {page === 'settings' && (
              <div className="absolute inset-0 flex flex-col">
                <SettingsPage onBack={() => go(backFrom.current)} />
              </div>
            )}
            {page === 'diagrams' && (
              <div className="absolute inset-0 flex flex-col">
                <DiagramsPage
                  projects={state?.projects || []}
                  onOpenSession={(machine, name) => openKey(`${machine}/${name}`)}
                  onOpenPipeline={(id) => {
                    go('pipeline')
                    history.replaceState(null, '', `/ui/pipeline?p=${encodeURIComponent(id)}`)
                    window.dispatchEvent(new PopStateEvent('popstate'))
                  }}
                />
              </div>
            )}
            {page === 'pipeline' && (
              <div className="absolute inset-0 flex flex-col">
                <PipelinesPage
                  onDispatch={(prompt) => {
                    go('dispatch')
                    history.replaceState(null, '', `/ui/dispatch?ask=${encodeURIComponent(prompt)}`)
                  }}
                />
              </div>
            )}
            {seenWorkspace && (
              <div className="absolute inset-0 flex" hidden={page !== 'workspace'}>
                <Workspace store={workspace} state={state} visible={page === 'workspace'} onNewSessionDialog={startSession} />
              </div>
            )}
          </PageHost>
        </main>
        <StatusBar state={state} />
      </div>
      <NewSession
        request={newSession}
        state={state}
        onClose={() => setNewSession(null)}
        onStarted={openKey}
        onOpenSettings={() => {
          setNewSession(null)
          go('settings')
        }}
      />
      <ConfirmHost />
      <InsightsHost />
      <Toaster position="bottom-right" theme={theme === 'system' ? 'system' : theme} />
    </TooltipProvider>
  )
}
