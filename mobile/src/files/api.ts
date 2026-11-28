import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'

export type FileEntry = { name: string; kind: 'dir' | 'file'; size: number }

export type FileListing = { path: string; entries: FileEntry[]; more: boolean }

export type FileText = { path: string; size: number; text: string; hash: string; editable: boolean }

export type SearchMode = 'names' | 'contents'

export type SearchResult = { matches: string[]; more: boolean }

const base = (machine: string) => `/machines/${encodeURIComponent(machine)}`

export function listFiles(server: PairedServer, machine: string, root: string, path = ''): Promise<FileListing> {
  return new ApiClient(server).get(`${base(machine)}/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
}

export function readFile(server: PairedServer, machine: string, root: string, path: string): Promise<FileText> {
  return new ApiClient(server).get(`${base(machine)}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
}

export function searchFiles(
  server: PairedServer,
  machine: string,
  root: string,
  q: string,
  mode: SearchMode
): Promise<SearchResult> {
  return new ApiClient(server).get(
    `${base(machine)}/files/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&mode=${mode}`
  )
}
