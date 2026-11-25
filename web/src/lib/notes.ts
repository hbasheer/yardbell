import { useSyncExternalStore } from 'react'

// Line notes on a diff, kept per diff until they are sent. The format is the old Workspace's, so
// notes left there carry over.
export type Note = { id: string; side: 'old' | 'new'; line: number; code: string; text: string; at: number }
type Store = Record<string, Note[]>

const KEY = 'workspace.notes'
const listeners = new Set<() => void>()
let cache: Store = read()

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function write(next: Store) {
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
  listeners.forEach((l) => l())
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  cache = read()
  listeners.forEach((l) => l())
})

export const diffKey = (d: { machine: string; root: string; path: string; staged?: boolean }) =>
  [d.machine, d.root, d.path, d.staged ? 'staged' : 'worktree'].join('\n')

export function useNotes(): Store {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => cache
  )
}

export function setNotes(key: string, list: Note[]) {
  const next = { ...cache }
  if (list.length) next[key] = list
  else delete next[key]
  write(next)
}

export type FolderNote = Note & { key: string; path: string; staged: boolean }

export function notesIn(store: Store, machine: string, root: string): FolderNote[] {
  const out: FolderNote[] = []
  for (const [key, list] of Object.entries(store)) {
    const [m, r, path, side] = key.split('\n')
    if (m !== machine || r !== root || !Array.isArray(list)) continue
    for (const n of list) out.push({ ...n, key, path, staged: side === 'staged' })
  }
  return out
}

const where = (n: FolderNote) => (n.side === 'old' ? `${n.path}:${n.line} (removed line)` : `${n.path}:${n.line}`)

export function compose(list: FolderNote[]): string {
  return list
    .map((n) => {
      const code = String(n.code ?? '')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
      return `${where(n)}\n${code}\n${String(n.text).trim()}`
    })
    .join('\n\n')
}

export function dropSent(store: Store, sent: FolderNote[]) {
  const ids = new Set(sent.map((n) => n.id))
  const next = { ...store }
  for (const key of new Set(sent.map((n) => n.key))) {
    const left = (next[key] || []).filter((n) => !ids.has(n.id))
    if (left.length) next[key] = left
    else delete next[key]
  }
  write(next)
}
