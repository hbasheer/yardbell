import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export type Change = {
  path: string
  old_path?: string
  status: ChangeStatus
  staged: boolean
  added?: number | null
  removed?: number | null
  binary: boolean
}

export type Changes = {
  branch: string
  head?: string | null
  upstream?: string | null
  ahead?: number | null
  behind?: number | null
  files: Change[]
  truncated: boolean
}

export type DiffLineKind = 'hunk' | 'ctx' | 'add' | 'del'

export type DiffLine = { k: DiffLineKind; o: number | null; n: number | null; t: string }

export type ChangeDiff = {
  path: string
  old_path?: string
  status: ChangeStatus
  staged: boolean
  added?: number | null
  removed?: number | null
  binary: boolean
  notes: string[]
  lines: DiffLine[]
  from: number
  next: number
  total: number
  cut: boolean
}

export type CommitInput = { staged?: boolean; paths?: string[] }

export type GitAction = 'push' | 'pull' | 'fetch'

export type PathAction = 'stage' | 'unstage' | 'discard'

export type DiffRequest = { root: string; path: string; staged: boolean; from?: number; context?: number }

const base = (machine: string) => `/machines/${encodeURIComponent(machine)}/changes`

const query = (params: Record<string, string | number | boolean | undefined>) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')

export function listChanges(server: PairedServer, machine: string, root: string): Promise<Changes> {
  return new ApiClient(server).get(`${base(machine)}?${query({ root })}`)
}

export function changeDiff(server: PairedServer, machine: string, request: DiffRequest): Promise<ChangeDiff> {
  const { root, path, staged, from, context } = request
  return new ApiClient(server).get(`${base(machine)}/diff?${query({ root, path, staged, from, context })}`)
}

export function draftMessage(server: PairedServer, machine: string, root: string): Promise<{ message: string; from: string }> {
  return new ApiClient(server).get(`${base(machine)}/draft?${query({ root })}`)
}

export function commitChanges(
  server: PairedServer,
  machine: string,
  root: string,
  message: string,
  input: CommitInput
): Promise<{ sha: string; short: string }> {
  return new ApiClient(server).post(`${base(machine)}/commit`, { root, message, ...input })
}

export function changePaths(
  server: PairedServer,
  machine: string,
  action: PathAction,
  root: string,
  paths: string[]
): Promise<{ ok: boolean }> {
  return new ApiClient(server).post(`${base(machine)}/${action}`, { root, paths })
}

export function gitAction(server: PairedServer, machine: string, action: GitAction, root: string): Promise<{ ok: boolean }> {
  return new ApiClient(server).post(`${base(machine)}/${action}`, { root })
}
