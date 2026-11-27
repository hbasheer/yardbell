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

function dispatchRoute(server: PairedServer, query: string): string {
  const conversation = new URLSearchParams(query).get('c')
  if (!conversation) return '/'
  return `/dispatch/${encodeURIComponent(server.id)}/${encodeURIComponent(conversation)}`
}

function pipelineRoute(server: PairedServer, query: string): string {
  const run = new URLSearchParams(query).get('run')
  const base = `/pipelines/${encodeURIComponent(server.id)}`
  return run ? `${base}/run/${encodeURIComponent(run)}` : base
}

const atBoundary = (next: string) => next === '' || next === '/' || next === '?' || next === '#'

export function routeForLink(link: string, servers: PairedServer[]): string {
  for (const server of servers) {
    const base = server.address.replace(/\/+$/, '')
    if (!link.startsWith(base) || !atBoundary(link.charAt(base.length))) continue
    const rest = link.slice(base.length)
    const [path, query = ''] = rest.split('#')[0].split('?')
    if (path === '/proposals' || path === '/proposals/') return `/inbox/${encodeURIComponent(server.id)}`
    if (path === '/dispatch' || path === '/dispatch/') return dispatchRoute(server, query)
    if (path === '/pipeline' || path === '/pipeline/') return pipelineRoute(server, query)
    if (!rest.startsWith('/term/')) continue
    const session = sessionPath(rest.slice('/term/'.length))
    if (!session) return '/'
    const [machine, tmux] = session
    return `/session/${encodeURIComponent(server.id)}/${encodeURIComponent(machine)}/${encodeURIComponent(tmux)}`
  }
  return '/'
}
