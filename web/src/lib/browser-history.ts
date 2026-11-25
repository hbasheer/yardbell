// Browser history kept the way Orca's browser pane keeps it (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useSyncExternalStore } from 'react'

export type Visit = { url: string; title: string; visits: number; last: number }

const KEY = 'yardbell.browserHistory'
const LIMIT = 500
const listeners = new Set<() => void>()

let entries: Visit[] = read()

function read(): Visit[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((v) => v && typeof v.url === 'string') : []
  } catch {
    return []
  }
}

function write(next: Visit[]) {
  entries = next.slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {}
  listeners.forEach((l) => l())
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  entries = read()
  listeners.forEach((l) => l())
})

export const normalize = (url: string) => url.replace(/#.*$/, '').replace(/\/$/, '')

export function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function recordVisit(url: string) {
  const key = normalize(url)
  const old = entries.find((v) => normalize(v.url) === key)
  const visit: Visit = { url, title: old?.title || hostOf(url), visits: (old?.visits || 0) + 1, last: Date.now() }
  write([visit, ...entries.filter((v) => normalize(v.url) !== key)])
}

export function removeVisit(url: string): Visit | null {
  const key = normalize(url)
  const gone = entries.find((v) => normalize(v.url) === key) || null
  if (gone) write(entries.filter((v) => v !== gone))
  return gone
}

export function clearSince(since: number): Visit[] {
  const gone = entries.filter((v) => v.last >= since)
  if (gone.length) write(entries.filter((v) => v.last < since))
  return gone
}

export function restore(visits: Visit[]) {
  const keys = new Set(entries.map((v) => normalize(v.url)))
  write([...entries, ...visits.filter((v) => !keys.has(normalize(v.url)))].sort((a, b) => b.last - a.last))
}

export function useHistory(): Visit[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => entries
  )
}

// Ranked by visits, then by how recent, like a browser's top sites.
export const topSites = (all: Visit[], limit: number) => [...all].sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, limit)

export function matching(all: Visit[], query: string, limit = Infinity) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = all.filter((v) => words.every((w) => `${v.title}\n${v.url}`.toLowerCase().includes(w)))
  return hits.slice(0, limit)
}
