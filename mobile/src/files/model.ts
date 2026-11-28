import type { ChangeStatus } from '../changes/api'
import type { FileEntry } from './api'

export type Listing = { entries?: FileEntry[]; error?: string; more?: boolean }

export type TreeRow =
  | { kind: 'dir'; key: string; path: string; name: string; depth: number; open: boolean; status?: ChangeStatus }
  | { kind: 'file'; key: string; path: string; name: string; depth: number; status?: ChangeStatus }
  | { kind: 'loading'; key: string; depth: number }
  | { kind: 'error'; key: string; depth: number; message: string }
  | { kind: 'more'; key: string; depth: number }

export const childPath = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)

export const isShown = (name: string, dotfiles: boolean): boolean => name !== '.git' && (dotfiles || !name.startsWith('.'))

export function dirStatus(statuses: ReadonlyMap<string, ChangeStatus>, path: string): ChangeStatus | undefined {
  for (const [changed, status] of statuses) {
    if (changed.startsWith(`${path}/`)) return status === 'deleted' ? 'modified' : status
  }
  return undefined
}

export function flattenTree(
  listings: ReadonlyMap<string, Listing>,
  open: ReadonlySet<string>,
  dotfiles: boolean,
  statuses: ReadonlyMap<string, ChangeStatus>
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (path: string, depth: number) => {
    const listing = listings.get(path)
    if (!listing) {
      rows.push({ kind: 'loading', key: `loading:${path}`, depth })
      return
    }
    if (listing.error !== undefined) {
      rows.push({ kind: 'error', key: `error:${path}`, depth, message: listing.error })
      return
    }
    for (const entry of listing.entries ?? []) {
      if (!isShown(entry.name, dotfiles)) continue
      const rel = childPath(path, entry.name)
      if (entry.kind === 'dir') {
        const isOpen = open.has(rel)
        rows.push({ kind: 'dir', key: rel, path: rel, name: entry.name, depth, open: isOpen, status: dirStatus(statuses, rel) })
        if (isOpen) walk(rel, depth + 1)
      } else {
        rows.push({ kind: 'file', key: rel, path: rel, name: entry.name, depth, status: statuses.get(rel) })
      }
    }
    if (listing.more) rows.push({ kind: 'more', key: `more:${path}`, depth })
  }
  walk('', 0)
  return rows
}

export function changeStatuses(files: { path: string; status: ChangeStatus }[]): Map<string, ChangeStatus> {
  return new Map(files.map((f) => [f.path, f.status]))
}

export function splitResult(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

export const filesHref = (serverId: string, machine: string, root: string): string =>
  `/files/${encodeURIComponent(serverId)}/${encodeURIComponent(machine)}?root=${encodeURIComponent(root)}`

export function fileHref(target: { serverId: string; machine: string; root: string; path: string; line?: number | null; find?: string }): string {
  const query = [`root=${encodeURIComponent(target.root)}`, `path=${encodeURIComponent(target.path)}`]
  if (target.line) query.push(`line=${Math.floor(target.line)}`)
  if (target.find) query.push(`find=${encodeURIComponent(target.find)}`)
  return `/files/${encodeURIComponent(target.serverId)}/${encodeURIComponent(target.machine)}/file?${query.join('&')}`
}

export function parseLine(value: string | undefined): number | null {
  const n = Number(value)
  return value && Number.isInteger(n) && n > 0 ? n : null
}

export function findLine(text: string, query: string): number | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const at = text.toLowerCase().indexOf(needle)
  if (at < 0) return null
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line += 1
  return line
}

export const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path)

export function sizeWord(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function searchDelay(mode: 'names' | 'contents'): number {
  return mode === 'contents' ? 400 : 200
}

export function moreWord(mode: 'names' | 'contents'): string {
  return `Only the first matches are shown. ${mode === 'contents' ? 'Search for something more specific' : 'Type more of the name'} to narrow it down.`
}
