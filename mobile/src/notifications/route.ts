import type { PairedServer } from '../servers/store'

function sessionPath(rest: string): [string, string] | null {
  const parts = rest.split(/[?#]/)[0].split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  try {
    return [decodeURIComponent(parts[0]), decodeURIComponent(parts[1])]
  } catch {
    return null
  }
}

export function routeForLink(link: string, servers: PairedServer[]): string {
  for (const server of servers) {
    const prefix = `${server.address.replace(/\/+$/, '')}/term/`
    if (!link.startsWith(prefix)) continue
    const session = sessionPath(link.slice(prefix.length))
    if (!session) return '/'
    const [machine, tmux] = session
    return `/session/${encodeURIComponent(server.id)}/${encodeURIComponent(machine)}/${encodeURIComponent(tmux)}`
  }
  return '/'
}
