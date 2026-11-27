import type { ServerSession } from '../state/views'
import { projectOf } from '../state/views'

export type BranchChoice =
  | { kind: 'stay' }
  | { kind: 'existing'; name: string }
  | { kind: 'new'; name: string; base: string }

export type NewSessionChoice = {
  machine: string
  path: string
  agent: string
  branch: BranchChoice
}

export type NewSessionBody = {
  machine: string
  path: string
  agent: string
  resume: false
  wait: false
  branch?: string
  new_branch?: true
  base?: string
}

export type Listing = {
  path: string
  git: boolean
  branch: string
  linked: boolean
  entries: { name: string; git: boolean; branch: string }[]
  recent: string[]
}

export type Branches = {
  current: string
  default_base: string
  local: string[]
  remote: string[]
  worktrees: Record<string, string>
}

export type NewSessionOpen = { serverId?: string; machine?: string; folder?: string }

export type Started = { machine: string; name: string; path: string; created: boolean; repo: string }

export function isValidBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..')
}

export function buildNewSessionBody(choice: NewSessionChoice): NewSessionBody {
  const body: NewSessionBody = {
    machine: choice.machine,
    path: choice.path,
    agent: choice.agent,
    resume: false,
    wait: false
  }
  if (choice.branch.kind === 'existing') body.branch = choice.branch.name
  if (choice.branch.kind === 'new') {
    body.branch = choice.branch.name
    body.new_branch = true
    body.base = choice.branch.base
  }
  return body
}

export function startBlocker(choice: Partial<NewSessionChoice>): string | null {
  if (!choice.machine) return 'Pick a machine'
  if (!choice.path) return 'Pick a folder'
  if (!choice.agent) return 'Pick an agent'
  if (choice.branch?.kind === 'new') {
    if (!choice.branch.name) return 'Name the new branch'
    if (!isValidBranchName(choice.branch.name)) return 'Branch names use letters, digits, dots, dashes and slashes'
    if (!choice.branch.base) return 'Pick a base branch'
  }
  return null
}

export function folderLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path || '/'
}

export function parentPath(path: string): string | null {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return null
  return `/${parts.slice(0, -1).join('/')}`
}

export function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name}`
}

export function projectFolders(sessions: ServerSession[], machine: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const session of sessions) {
    if (session.machine !== machine) continue
    const { path } = projectOf(session)
    if (!path.startsWith('/') || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths.sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)))
}
