import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { counts, dispatchApi, dispatchFixtures } from './preview-dispatch.mjs'
import { addReviewChat, reviewApi } from './preview-review.mjs'
import { runsWaiting, step3Api, step3Fixtures } from './preview-step3.mjs'

const WEB_PORT = Number(process.env.PREVIEW_WEB_PORT ?? 8099)
const HOST = process.env.PREVIEW_HOST ?? '127.0.0.1'

const now = Math.floor(Date.now() / 1000)

function pull(number, state, extra = {}) {
  return {
    forge: 'github',
    number,
    url: `https://github.com/acme/yardbell/pull/${number}`,
    title: extra.title ?? `Change ${number}`,
    state,
    draft: false,
    review: 'none',
    ci: 'passing',
    failed: [],
    head: '',
    base: 'main',
    mergeable: 'mergeable',
    ...extra
  }
}

function session(machine, n, fields) {
  const folder = fields.folder
  return {
    id: `${machine}:${n}`,
    machine,
    agent: 'claude',
    pid: 4000 + n,
    folder,
    ticket: '',
    branch: 'main',
    activity: 'idle',
    attachable: true,
    tmux: `${folder}-${n}`,
    stale: false,
    ports: [],
    path: `/home/dev/Projects/${folder}`,
    cwd: '',
    worktree: false,
    ...fields
  }
}

const hpSessions = [
  session('hp', 1, {
    folder: 'yardbell',
    ticket: 'YB-214',
    branch: 'mobile-app',
    activity: 'blocked',
    cwd: '/home/dev/Projects/yardbell/mobile',
    pull: pull(412, 'open', { title: 'Phone app redesign', review: 'changes_requested', ci: 'failing', failed: ['android build'] })
  }),
  session('hp', 2, {
    folder: 'yardbell-orca-style-ui',
    ticket: 'YB-214',
    branch: 'orca-style-ui',
    activity: 'active',
    worktree: true,
    path: '/home/dev/Projects/yardbell-worktrees/orca-style-ui',
    pull: pull(415, 'open', { title: 'Theme tokens and web preview', draft: true, ci: 'pending' })
  }),
  session('hp', 3, {
    folder: 'yardbell',
    branch: 'main',
    agent: 'codex',
    activity: 'idle',
    pull: pull(398, 'merged', { title: 'Revoke closes sockets', review: 'approved' })
  }),
  session('hp', 4, {
    folder: 'feedgest',
    ticket: 'INL-88',
    branch: 'inl-88-fix-import-dedup-for-very-long-branch-names-in-the-feed',
    activity: 'active',
    path: '/home/dev/Projects/feedgest/app',
    pull: pull(77, 'closed', { title: 'Dedup imports' })
  }),
  session('hp', 5, { folder: 'sama', branch: 'wip-audio', activity: 'idle', attachable: false, tmux: null }),
  session('hp', 8, { folder: 'feedgest', branch: 'inl-90-search', activity: 'active', attachable: false, tmux: null, path: '/home/dev/Projects/feedgest/app' }),
  session('hp', 9, { folder: 'notes', branch: '', agent: 'codex', activity: 'idle', attachable: false, tmux: null, path: '/home/dev/Projects/notes' }),
  session('hp', 6, { folder: 'eitjar', branch: 'main', activity: 'idle', stale: true }),
  session('hp', 7, {
    folder: 'commslayer-checkout-flow-rewrite-with-a-long-name',
    ticket: 'COM-1234',
    branch: 'com-1234-fix-webhook-dedup',
    activity: 'idle',
    stopped: 'exited 0',
    worktree: true,
    pull: pull(2210, 'open', { title: 'Fix webhook dedup', review: 'approved' })
  })
]

const miniSessions = [
  session('mac-mini', 1, { folder: 'eitjar', branch: 'main', agent: 'claude', activity: 'idle' }),
  session('mac-mini', 2, {
    folder: 'feedgest',
    ticket: 'INL-91',
    branch: 'inl-91-mobile-share',
    activity: 'blocked',
    pull: pull(80, 'open', { title: 'Share sheet', review: 'review_required' })
  })
]

const GB = 1048576
const health = (over) => ({
  mem_total_kb: 32 * GB, mem_used_kb: 12 * GB, agent_kb: 4 * GB, user_kb: 7 * GB, limit_kb: 0, limit_used_kb: 0,
  load1: 1.24, cpus: 8, disk_total_kb: 1000 * GB, disk_used_kb: 710 * GB, ...over
})

function machine(name, fields) {
  return { name, up: true, reason: null, last_seen: null, local: false, health: null, accounts: [], mesh_on: true, ...fields }
}

const servers = [
  {
    port: Number(process.env.PREVIEW_PORT_A ?? 4210),
    name: 'hp',
    version: '0.11.107',
    machines: [
      machine('hp', { local: true, health: health({ mem_used_kb: 28.5 * GB, agent_kb: 9 * GB, user_kb: 14 * GB, limit_kb: 24 * GB, limit_used_kb: 22 * GB, load1: 5.8, disk_used_kb: 880 * GB }) }),
      machine('nas', { up: false, reason: 'ssh: connect to host nas port 22: Connection timed out', last_seen: '2026-11-27T08:12:00+00:00' })
    ],
    sessions: hpSessions,
    ended: [
      { id: 'hp:old-1', machine: 'hp', folder: 'eitjar', ticket: '', branch: 'main', agent: 'claude', path: '/home/dev/Projects/eitjar', worktree: false }
    ]
  },
  {
    port: Number(process.env.PREVIEW_PORT_B ?? 4211),
    name: 'mac-mini',
    version: '0.11.107',
    machines: [machine('mac-mini', { local: true, health: health() })],
    sessions: miniSessions
  }
]

function stateFor(server) {
  const { proposals, waiting } = counts(server.dispatch)
  return {
    agents: [
      { name: 'claude', label: 'Claude Code' },
      { name: 'codex', label: 'Codex' },
      { name: 'gemini', label: 'Gemini' },
      { name: 'opencode', label: 'OpenCode' }
    ],
    default_agent: 'claude',
    machines: server.machines,
    folders: [
      { machine: 'hp', label: 'yardbell', path: '/home/dev/Projects/yardbell', branch: 'main', worktree: false },
      { machine: 'hp', label: 'yardbell-orca-style-ui', path: '/home/dev/Projects/yardbell-worktrees/orca-style-ui', branch: 'orca-style-ui', worktree: true },
      { machine: 'hp', label: 'feedgest', path: '/home/dev/Projects/feedgest/app', branch: 'main', worktree: false }
    ],
    sessions: server.sessions,
    ended: server.ended ?? [],
    host_terminal: { enabled: false },
    mesh: null,
    server: { machine: server.name, address: `http://${HOST}:${server.port}`, version: server.version },
    proposals,
    waiting,
    runs_waiting: runsWaiting(server.step3)
  }
}

const usage = {
  providers: [
    {
      id: 'claude',
      name: 'Claude',
      windows: [
        { label: '5 hour', short: '5h', used: 0.62, resets_at: now + 2 * 3600 + 14 * 60, status: 'allowed' },
        { label: 'Weekly', short: '7d', used: 0.88, resets_at: now + 3 * 86400, status: 'allowed_warning' }
      ]
    },
    {
      id: 'codex',
      name: 'Codex',
      windows: [
        { label: '5 hour', short: '5h', used: 0.18, resets_at: now + 4 * 3600, status: 'allowed' },
        { label: 'Weekly', short: '7d', used: 0.34, resets_at: now + 5 * 86400, status: 'allowed' }
      ]
    },
    { id: 'gemini', name: 'Gemini', windows: [], status: 'signed_out', message: 'Not signed in' }
  ]
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
}

function json(res, status, body) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const tree = {
  '/home/dev': ['Projects', 'Documents', 'Downloads'],
  '/home/dev/Projects': ['yardbell', 'feedgest', 'sama', 'eitjar', 'notes'],
  '/home/dev/Projects/feedgest': ['app', 'mobile']
}
const gitDirs = new Set(['/home/dev/Projects/yardbell', '/home/dev/Projects/feedgest/app', '/home/dev/Projects/sama'])

function machineApi(req, res, kind) {
  const url = new URL(req.url, 'http://x')
  if (kind === 'agents') return json(res, 200, { installed: ['claude', 'codex', 'gemini'] })
  const at = url.searchParams.get('path') || '/home/dev/Projects'
  if (kind === 'branches') {
    return json(res, 200, {
      current: 'main',
      default_base: 'main',
      local: ['main', 'mobile-app', 'orca-style-ui', 'feature/long-branch-name-for-the-feed-importer'],
      remote: ['origin-fix-dedup'],
      worktrees: { 'orca-style-ui': '/home/dev/Projects/yardbell-worktrees/orca-style-ui' }
    })
  }
  const entries = (tree[at] ?? []).map((name) => {
    const git = gitDirs.has(`${at}/${name}`)
    return { name, git, branch: git ? 'main' : '' }
  })
  json(res, 200, {
    path: at,
    git: gitDirs.has(at),
    branch: gitDirs.has(at) ? 'main' : '',
    linked: false,
    entries,
    recent: ['/home/dev/Projects/sama', '/home/dev/Projects/notes']
  })
}

function startSession(req, res, server) {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    if (body.path === '/home/dev/Projects/notes') return json(res, 400, { error: `${body.machine} has no folder ${body.path}` })
    json(res, 200, { machine: body.machine, name: 'new-1', path: body.path, created: !!body.new_branch, repo: body.path })
  })
}

function handler(server) {
  return async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    const webImage = req.method === 'GET' && /\/reviews\/\d+\/evidence\/[^/]+$/.test(path)
    if (!webImage && !(req.headers.authorization ?? '').startsWith('Bearer ')) return json(res, 401, { error: 'sign in again' })
    if (path === '/app/about') return json(res, 200, { machine: server.name, api: 1, version: server.version })
    if (path === '/state') return json(res, 200, stateFor(server))
    const machinePart = path.match(/^\/machines\/([^/]+)\/(browse|branches|agents)$/)
    if (machinePart) return machineApi(req, res, machinePart[2])
    if (/^\/sessions\/[^/]+\/[^/]+\/agent$/.test(path)) {
      if (req.method === 'POST') return json(res, 200, {})
      return json(res, 200, {
        agent: 'claude',
        state: 'permission',
        screen: 'preview-screen',
        choices: [
          { number: 1, label: 'Yes', keys: '1', role: 'yes' },
          { number: 2, label: 'Yes, always', keys: '2', role: 'always' },
          { number: 3, label: 'No', keys: '3', role: 'no' }
        ]
      })
    }
    const pidRoute = path.match(/^\/sessions\/([^/]+)\/(\d+)\/(move-to-tmux|stop-process)$/)
    if (pidRoute && req.method === 'POST') {
      const [, machineName, pid, action] = pidRoute
      const found = server.sessions.find((s) => s.machine === machineName && String(s.pid) === pid)
      if (!found) return json(res, 404, { error: 'no such process' })
      if (action === 'stop-process') {
        server.sessions = server.sessions.filter((s) => s !== found)
        return json(res, 200, { ok: true })
      }
      found.attachable = true
      found.tmux = `${found.folder}-moved`
      return json(res, 200, { name: found.tmux })
    }
    const forgetRoute = path.match(/^\/ended\/([^/]+)\/forget$/)
    if (forgetRoute && req.method === 'POST') {
      server.ended = (server.ended ?? []).filter((e) => e.id !== decodeURIComponent(forgetRoute[1]))
      return json(res, 200, { ok: true })
    }
    if (path === '/sessions' && req.method === 'POST') return startSession(req, res, server)
    if (path === '/dispatch/usage' || path === '/dispatch/usage/refresh') return json(res, 200, usage)
    if (await step3Api(req, res, server.step3, { json })) return
    if (await reviewApi(req, res, { json, cors })) return
    if (await dispatchApi(req, res, server.dispatch, { json, cors })) return
    json(res, 404, { error: 'not found' })
  }
}

function acceptSocket(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!key || new URL(req.url, 'http://x').pathname !== '/state/live') return socket.destroy()
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  socket.on('data', () => {})
  socket.on('error', () => {})
}

for (const server of servers) {
  server.dispatch = dispatchFixtures(server.name)
  server.step3 = step3Fixtures(server.dispatch, server.name)
  addReviewChat(server.dispatch, server.name)
}

const listening = servers.map(
  (server) =>
    new Promise((resolve, reject) => {
      const http = createServer(handler(server))
      http.on('upgrade', acceptSocket)
      http.once('error', reject)
      http.listen(server.port, HOST, () => {
        console.log(`mock ${server.name} on http://${HOST}:${server.port}`)
        resolve(http)
      })
    })
)

const mocks = await Promise.all(listening)

if (process.argv.includes('--mock-only')) {
  console.log('mock servers only')
} else {
  const expo = spawn(new URL('../node_modules/.bin/expo', import.meta.url).pathname, ['start', '--web', '--port', String(WEB_PORT)], {
    stdio: 'inherit',
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' }
  })
  const stop = () => {
    expo.kill('SIGTERM')
    for (const mock of mocks) mock.close()
  }
  expo.on('exit', (code) => {
    for (const mock of mocks) mock.close()
    process.exit(code ?? 0)
  })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log(`preview: http://${HOST}:${WEB_PORT}/?preview=1`)
}
