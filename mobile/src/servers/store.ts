import { setServers } from '../../modules/yardbell-notify'
import { getItem, setItem } from './storage'

export type PairedServer = {
  id: string
  address: string
  token: string
  machine: string
  deviceId: string
}

const KEY = 'servers'
const listeners = new Set<(servers: PairedServer[]) => void>()

export async function listServers(): Promise<PairedServer[]> {
  const raw = await getItem(KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as PairedServer[]
  } catch {
    return []
  }
}

async function write(servers: PairedServer[]): Promise<void> {
  await setItem(KEY, JSON.stringify(servers))
  setServers(servers.map(({ address, token }) => ({ address, token })))
  for (const fn of listeners) fn(servers)
}

export async function saveServer(server: PairedServer): Promise<void> {
  const others = (await listServers()).filter((s) => s.id !== server.id)
  await write([...others, server])
}

export async function forgetServer(id: string): Promise<void> {
  const servers = await listServers()
  await write(servers.filter((s) => s.id !== id))
}

export function onServersChanged(fn: (servers: PairedServer[]) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
