import { useSyncExternalStore } from 'react'
import { statusOf, tail, type Line, type MachineNode, type Status } from '@/lib/tree'

export type TreeOptions = {
  group: 'machine' | 'status'
  sort: 'manual' | 'name' | 'activity'
  machine: string
  hideIdle: boolean
  hideOther: boolean
  hideOffline: boolean
  hideEmpty: boolean
  compact: boolean
}

export const DEFAULT_OPTIONS: TreeOptions = {
  group: 'machine',
  sort: 'manual',
  machine: '',
  hideIdle: false,
  hideOther: false,
  hideOffline: false,
  hideEmpty: false,
  compact: false
}

const KEY = 'yardbell.tree.options'
const listeners = new Set<() => void>()

function read(): TreeOptions {
  try {
    return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return DEFAULT_OPTIONS
  }
}

let current = read()

export function setTreeOptions(change: Partial<TreeOptions>) {
  current = { ...current, ...change }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {}
  listeners.forEach((l) => l())
}

export function useTreeOptions(): TreeOptions {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}

export const filtersOn = (o: TreeOptions) => [o.hideIdle, o.hideOther, o.hideOffline, o.hideEmpty, Boolean(o.machine)].filter(Boolean).length

const RANK: Record<string, number> = { blocked: 0, error: 1, working: 2, done: 3, idle: 4, '': 5 }
const idle = (s: Status) => s === 'idle' || s === 'done' || s === ''
const lineLabel = (l: Line) => l.branch || tail(l.folder)

function sortLines(lines: Line[], sort: TreeOptions['sort']) {
  if (sort === 'name') return [...lines].sort((a, b) => lineLabel(a).localeCompare(lineLabel(b)))
  if (sort === 'activity') return [...lines].sort((a, b) => RANK[a.status] - RANK[b.status])
  return lines
}

// The machine tree after the sidebar's options: which machines, which cards, and in what order.
export function shapeTree(machines: MachineNode[], o: TreeOptions): MachineNode[] {
  return machines
    .filter((m) => (!o.machine || m.name === o.machine) && (!o.hideOffline || m.up))
    .map((m) => {
      let projects = m.projects.map((p) => {
        const lines = sortLines(
          p.lines.filter((l) => !o.hideIdle || !idle(l.status)),
          o.sort
        )
        return { ...p, lines }
      })
      if (o.hideEmpty || o.hideIdle) projects = projects.filter((p) => p.lines.length > 0)
      if (o.sort === 'name') projects = [...projects].sort((a, b) => a.name.localeCompare(b.name))
      if (o.sort === 'activity') projects = [...projects].sort((a, b) => RANK[a.status] - RANK[b.status])
      const other = o.hideOther ? [] : m.other.filter((s) => !o.hideIdle || !idle(statusOf(s)))
      return { ...m, projects, other }
    })
}

export const STATUS_GROUPS: { id: string; label: string; test: (s: Status) => boolean }[] = [
  { id: 'needs', label: 'Needs you', test: (s) => s === 'blocked' || s === 'error' },
  { id: 'working', label: 'Working', test: (s) => s === 'working' },
  { id: 'idle', label: 'Idle', test: (s) => idle(s) }
]
