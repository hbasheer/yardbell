import type { StateView } from '../state/types'

export type Place = { path: string; label: string; branch: string | null; worktree: boolean; sessions: number }

export type PlaceGroup = { key: string; title: string; places: Place[] }

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const absolute = (path: string | undefined) => (path && path.startsWith('/') ? path.replace(/\/+$/, '') || '/' : '')

const repoRoot = (path: string) => {
  const marker = path.indexOf('-worktrees/')
  return marker > 0 ? path.slice(0, marker) : path
}

const realBranch = (branch: string | undefined) => (branch && branch !== '-' ? branch : null)

export function placeGroups(state: Pick<StateView, 'folders' | 'sessions'> | undefined, machine: string): PlaceGroup[] {
  const byPath = new Map<string, Place>()
  for (const folder of state?.folders ?? []) {
    const path = absolute(folder.path)
    if (folder.machine !== machine || !path) continue
    byPath.set(path, { path, label: folder.label || baseName(path), branch: realBranch(folder.branch), worktree: Boolean(folder.worktree), sessions: 0 })
  }
  for (const session of state?.sessions ?? []) {
    const path = absolute(session.path) || absolute(session.cwd)
    if (session.machine !== machine || !path || session.stale) continue
    const known = byPath.get(path)
    if (known) {
      known.sessions += 1
      known.branch ??= realBranch(session.branch)
      continue
    }
    byPath.set(path, { path, label: baseName(path), branch: realBranch(session.branch), worktree: Boolean(session.worktree), sessions: 1 })
  }

  const groups = new Map<string, PlaceGroup>()
  for (const place of byPath.values()) {
    const root = repoRoot(place.path)
    const group = groups.get(root) ?? { key: root, title: baseName(root), places: [] }
    group.places.push(place)
    groups.set(root, group)
  }
  for (const group of groups.values()) {
    group.title = byPath.get(group.key)?.label ?? group.title
    group.places.sort((a, b) => Number(a.path !== group.key) - Number(b.path !== group.key) || a.path.localeCompare(b.path))
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}

export function filterGroups(groups: PlaceGroup[], query: string): PlaceGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return groups
  return groups
    .map((group) => ({
      ...group,
      places: group.places.filter((p) => {
        const hay = `${p.path}\n${p.label}\n${p.branch ?? ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }))
    .filter((group) => group.places.length > 0)
}

export type PlaceDestination = 'changes'

export function placeHref(destination: PlaceDestination, serverId: string, machine: string, root: string): string {
  return `/${destination}/${encodeURIComponent(serverId)}/${encodeURIComponent(machine)}?root=${encodeURIComponent(root)}`
}

export function pickerHref(destination: PlaceDestination, serverId: string, machine: string): string {
  return `/places/${encodeURIComponent(serverId)}/${encodeURIComponent(machine)}?then=${destination}`
}
