import type { Change, ChangeStatus, Changes, CommitInput } from './api'

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
