import { useEffect, useState } from 'react'
import { House, Inbox, MessageSquare, Network, PanelsTopLeft, Settings, Workflow, type LucideIcon } from 'lucide-react'

export type PageId = 'dashboard' | 'workspace' | 'pipeline' | 'diagrams' | 'dispatch' | 'proposals' | 'settings'

export type Page = { id: PageId; name: string; legacy: string; icon: LucideIcon; nav: boolean }

export const PAGES: Page[] = [
  { id: 'dashboard', name: 'Dashboard', legacy: '/', icon: House, nav: true },
  { id: 'workspace', name: 'Workspace', legacy: '/workspace', icon: PanelsTopLeft, nav: true },
  { id: 'pipeline', name: 'Pipelines', legacy: '/pipeline', icon: Workflow, nav: true },
  { id: 'diagrams', name: 'Diagrams', legacy: '/diagrams', icon: Network, nav: true },
  { id: 'dispatch', name: 'Dispatch', legacy: '/dispatch', icon: MessageSquare, nav: true },
  { id: 'proposals', name: 'Proposals', legacy: '/proposals', icon: Inbox, nav: false },
  { id: 'settings', name: 'Settings', legacy: '/settings', icon: Settings, nav: false }
]

const BASE = '/ui/'

export function pageOfPath(pathname: string): PageId {
  const id = pathname.startsWith(BASE) ? pathname.slice(BASE.length).split('/')[0] : ''
  return PAGES.find((p) => p.id === id)?.id ?? 'dashboard'
}

export function pageOfLegacy(href: string): { id: PageId; search: string } | null {
  const url = new URL(href, location.origin)
  if (url.origin !== location.origin) return null
  const path = url.pathname.replace(/\/$/, '') || '/'
  const page = PAGES.find((p) => (p.legacy.replace(/\/$/, '') || '/') === path)
  return page ? { id: page.id, search: url.search } : null
}

export const pathOf = (id: PageId) => (id === 'dashboard' ? BASE : `${BASE}${id}`)

export function useRoute(): [PageId, (id: PageId) => void] {
  const [page, setPage] = useState<PageId>(() => pageOfPath(location.pathname))
  useEffect(() => {
    const back = () => setPage(pageOfPath(location.pathname))
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])
  const go = (id: PageId) => {
    if (pathOf(id) !== location.pathname) history.pushState(null, '', pathOf(id))
    setPage(id)
  }
  return [page, go]
}
