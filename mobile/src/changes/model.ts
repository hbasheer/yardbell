import type { Change, ChangeDiff, ChangeStatus, Changes, CommitInput, DiffLine } from './api'

const LETTERS: Record<ChangeStatus, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' }

export const statusLetter = (status: ChangeStatus): string => LETTERS[status] ?? ''

export function splitChanges(files: Change[]): { staged: Change[]; unstaged: Change[] } {
  return { staged: files.filter((f) => f.staged), unstaged: files.filter((f) => !f.staged) }
}

export const uniquePaths = (files: Change[]): string[] => [...new Set(files.map((f) => f.path))]

export function commitInput(changes: Pick<Changes, 'files' | 'truncated'>): CommitInput {
  if (changes.files.some((f) => f.staged)) return { staged: true }
  if (changes.truncated) return {}
  return { paths: uniquePaths(changes.files) }
}

export type PrimaryAction =
  | { kind: 'commit'; label: 'Commit' | 'Commit All' }
  | { kind: 'pull'; label: string }
  | { kind: 'push'; label: string }
  | { kind: 'fetch'; label: 'Fetch' }

export function primaryAction(changes: Pick<Changes, 'files' | 'ahead' | 'behind'>): PrimaryAction {
  if (changes.files.length > 0) {
    return { kind: 'commit', label: changes.files.some((f) => f.staged) ? 'Commit' : 'Commit All' }
  }
  if (changes.behind) return { kind: 'pull', label: `Pull ${changes.behind}` }
  if (changes.ahead) return { kind: 'push', label: `Push ${changes.ahead}` }
  return { kind: 'fetch', label: 'Fetch' }
}

const baseName = (path: string) => path.split('/').pop() || path

export function discardConfirm(files: Change[]): { title: string; body: string; confirm: 'Delete' | 'Discard' } {
  const untracked = files.some((f) => f.status === 'untracked')
  const count = uniquePaths(files).length
  return {
    title: files.length === 1 ? `Discard changes in ${baseName(files[0].path)}?` : `Discard changes in ${count} files?`,
    body: untracked
      ? 'Untracked files are deleted. This cannot be undone.'
      : 'The files go back to their last committed state. This cannot be undone.',
    confirm: untracked && files.every((f) => f.status === 'untracked') ? 'Delete' : 'Discard'
  }
}

export const fileKey = (file: Pick<Change, 'path' | 'staged'>): string => `${file.staged ? 'staged' : 'changes'}:${file.path}`

export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

export function filterChanges(files: Change[], text: string): Change[] {
  const words = text.trim().toLowerCase()
  return words ? files.filter((f) => f.path.toLowerCase().includes(words)) : files
}

export function commitAllConfirm(changes: Pick<Changes, 'files' | 'truncated'>): { title: string; body: string } {
  const count = uniquePaths(changes.files).length
  return {
    title: 'Commit all changes?',
    body: changes.truncated
      ? 'Nothing is staged, and there are too many changes to list them all here. Every change in the working tree will be committed.'
      : `Nothing is staged, so every change will be committed: ${count === 1 ? '1 file' : `${count} files`}, new and deleted files included.`
  }
}

export function neighbour(files: Change[], current: Pick<Change, 'path' | 'staged'>, step: 1 | -1): Change | null {
  const at = files.findIndex((f) => fileKey(f) === fileKey(current))
  if (at < 0) return null
  return files[at + step] ?? null
}

export function ordered(files: Change[]): Change[] {
  const { staged, unstaged } = splitChanges(files)
  return [...staged, ...unstaged]
}

export function committedNotice(short: string, pushFailed: string | null): string {
  return pushFailed ? `Committed ${short}, then the push failed.\n${pushFailed}` : `Committed ${short}`
}

export function diffHref(serverId: string, machine: string, root: string, file: Pick<Change, 'path' | 'staged'>): string {
  const query = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(file.path)}&staged=${file.staged ? 1 : 0}`
  return `/changes/${encodeURIComponent(serverId)}/${encodeURIComponent(machine)}/diff?${query}`
}

export const absolutePath = (root: string, path: string): string => `${root.replace(/\/+$/, '')}/${path}`

export const rootName = (root: string): string => root.split('/').filter(Boolean).pop() ?? root

export type DiffPages = { lines: DiffLine[]; next: number; total: number }

export function appendPage(current: DiffPages | null, page: Pick<ChangeDiff, 'lines' | 'from' | 'next' | 'total'>): DiffPages {
  if (!current || page.from === 0) return { lines: page.lines, next: page.next, total: page.total }
  if (page.from !== current.next) return current
  return { lines: [...current.lines, ...page.lines], next: page.next, total: page.total }
}

export function statsWord(file: Pick<Change, 'binary' | 'added' | 'removed'>): string {
  if (file.binary) return 'binary'
  return [file.added ? `+${file.added}` : '', file.removed ? `-${file.removed}` : ''].filter(Boolean).join(' ')
}
