const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString()

const longTask =
  'Fix the webhook dedup bug in the checkout flow. Start by reading the failing spec, then change the handler so a repeated delivery id is ignored, and add a regression test. Keep the change small and do not touch the billing code. When the tests pass, push the branch and open a pull request that explains the cause in two sentences.'

function step(id, tool, input, fields = {}) {
  return { role: 'action', id, tool, input, status: 'pending', by: 'dispatch', at: minutes(4), ...fields }
}

function rolesTour() {
  const events = [
    { role: 'user', text: 'Check the machines, then start a session on the yardbell repository to fix the webhook dedup bug.', task: { name: 'Fix a bug', version: 2 } },
    { role: 'tool', name: 'list_machines', input: {} },
    { role: 'tool_result', name: 'list_machines', text: '[{"name":"hp","up":true},{"name":"nas","up":false}]' },
    { role: 'tool', name: 'list_folders', input: { query: 'yardbell' } },
    { role: 'tool_result', name: 'list_folders', text: 'Error: machine nas is down', is_error: true },
    { role: 'tool', name: 'read_session', input: { machine: 'hp', name: 'yardbell-1' } },
    { role: 'assistant', text: 'I checked **hp** and **nas**. `nas` is down, so I will use `hp`.\n\n- Repository: `yardbell`\n- Branch: `fix-webhook-dedup`\n\n```\ncargo test dedup -- --nocapture\n```' },
    step('a1000001', 'start_session', { machine: 'hp', folder: 'yardbell', agent: 'claude', branch: 'fix-webhook-dedup', new_branch: true, prompt: longTask }, { status: 'approved', decided: minutes(3), result: { ok: true, text: 'Started yardbell-3 on hp', session: { machine: 'hp', name: 'yardbell-3' } } }),
    step('a1000002', 'send_to_session', { machine: 'hp', name: 'yardbell-3', text: 'Also run the whole spec folder before you push.' }, { status: 'edited', by: 'dispatch', decided: minutes(3), original: { machine: 'hp', name: 'yardbell-3', text: 'Run the specs.' }, result: { ok: true, text: 'Sent', at: minutes(3) } }),
    step('a1000003', 'stop_session', { machine: 'hp', name: 'yardbell-9' }, { status: 'rejected', by: 'you', decided: minutes(2) }),
    step('a1000004', 'push_branch', { machine: 'hp', folder: 'yardbell', branch: 'fix-webhook-dedup' }, { status: 'withdrawn', decided: minutes(2) }),
    step('a1000005', 'remove_worktree', { machine: 'hp', folder: 'yardbell-old' }, { status: 'auto', rule: 'Remove finished worktrees', decided: minutes(2), result: { ok: false, text: 'The worktree has uncommitted changes', at: minutes(2) } }),
    { role: 'session', machine: 'hp', name: 'yardbell-3', path: '/home/dev/Projects/yardbell', state: 'blocked', screen: 'Do you want to run cargo test?\n  1. Yes\n  2. Yes, and do not ask again for cargo commands\n  3. No', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'Yes, and do not ask again for cargo commands' }, { key: '3', label: 'No' }] },
    { role: 'session', machine: 'hp', name: 'yardbell-2', path: '/home/dev/Projects/yardbell', state: 'idle', screen: 'All 41 tests passed.', answer: { key: '1', label: 'Yes', at: minutes(1) } },
    { role: 'review', machine: 'hp', name: 'yardbell-2', of: { branch: 'fix-webhook-dedup' }, verdict: 'Needs changes', summary: 'The handler ignores repeats, but the cache never expires.', findings: [{ severity: 'high', place: 'src/webhooks.rs:88', text: 'The seen set grows without bound.' }, { severity: 'medium', place: 'src/webhooks.rs:41', text: 'The delivery id is not trimmed before it is compared.' }, { severity: 'low', place: 'tests/dedup.rs', text: 'Name the test after the behaviour.' }] },
    { role: 'pull', kind: 'ci', key: 'ci-1', machine: 'hp', name: 'yardbell-3', path: '/home/dev/Projects/yardbell', branch: 'fix-webhook-dedup', pull: { number: 412, url: 'https://github.com/acme/yardbell/pull/412', title: 'Fix webhook dedup' }, checks: [{ name: 'android build', state: 'failing' }], notes: [], instruction: 'The android build fails. Read the log and fix it.' },
    { role: 'error', text: 'Dispatch lost its connection to the agent. Send the message again.' },
    { role: 'user', text: 'Here is the failing log and a screenshot.', attachments: [{ file: '1-failure.png', name: 'failure.png', kind: 'image', size: 184320 }, { file: '2-build.log', name: 'build.log', kind: 'text', size: 9211 }, { file: '3-spec.pdf', name: 'spec.pdf', kind: 'pdf', size: 2411000 }] },
    { role: 'user', text: 'Sent by Yardbell once the results were in.', by: 'yardbell' },
    { role: 'user', text: 'Suggest a better prompt for the fix-a-bug prompt on hp.', improve: { machine: 'hp', name: 'yardbell-2', task: { name: 'Fix a bug', version: 2 } } },
    { role: 'assistant', text: 'Here is a better prompt:\n\n```prompt\nFind the failing test first. Change the smallest amount of code that makes it pass. Add one regression test.\n```' }
  ]
  return events
}

function groupChat() {
  return [
    { role: 'user', text: 'Run the dead code scan on the three apps and gather the results.' },
    { role: 'assistant', text: 'I will scan each app in its own session and gather the answers here.' },
    { role: 'group', id: 'g1000001', title: 'Dead code scan on three apps', gather: true, minutes: 30, status: 'waiting', follow: true, children: [{ label: 'yardbell', step: 'a2000001' }, { label: 'feedgest', step: 'a2000002' }, { label: 'sama', refused: 'Your rule does not allow scans on sama', rule: 'No scans on sama' }] },
    step('a2000001', 'start_session', { machine: 'hp', folder: 'yardbell', agent: 'claude', prompt: 'Scan for dead code.' }, { group: 'g1000001', label: 'yardbell' }),
    step('a2000002', 'start_session', { machine: 'hp', folder: 'feedgest', agent: 'codex', prompt: 'Scan for dead code.' }, { group: 'g1000001', label: 'feedgest' }),
    { role: 'results', group: 'g0000000', title: 'Test gap scan', why: 'Two of three apps finished.', gather: true, follow: false, children: [{ label: 'yardbell', started: true, name: 'yardbell-5', machine: 'hp', path: '/home/dev/Projects/yardbell', branch: 'main', state: 'ended', result: { status: 'done', summary: 'Found 6 untested functions.', details: ['src/dispatch.rs: 3', 'src/proposals.rs: 3'] } }, { label: 'feedgest', started: true, name: 'feedgest-2', machine: 'hp', branch: 'main', state: 'blocked', screen: 'Waiting for an answer', result: { status: 'running', summary: 'Still reading.' } }, { label: 'sama', started: false, result: { status: 'failed', summary: 'The folder was not found.' } }] }
  ]
}

function pendingChat() {
  return [
    { role: 'user', text: 'Start a session on yardbell for the dedup fix and tell the other one to stop waiting on CI.' },
    { role: 'assistant', text: 'I would like to do two things. Both need your approval.' },
    step('a3000001', 'start_session', { machine: 'hp', folder: 'yardbell', agent: 'claude', branch: 'fix-webhook-dedup', new_branch: true, prompt: longTask }),
    step('a3000002', 'send_to_session', { machine: 'hp', name: 'yardbell-1', text: 'Stop waiting for CI and merge main into your branch instead.' })
  ]
}

function triggerChat() {
  return [
    { role: 'user', text: 'Look for stuck pull requests.', task: { name: 'Stuck pull requests', version: 1 } },
    { role: 'assistant', text: 'No pull request has been stuck for more than a day.' }
  ]
}

function busyChat() {
  return [{ role: 'user', text: 'Read the latest session on hp and summarise where it is stuck.' }, { role: 'tool', name: 'list_sessions', input: {} }]
}

function proposal(id, tool, input, fields = {}) {
  return { role: 'action', id, tool, input, status: 'pending', by: 'client', from: 'Claude Code', at: minutes(12), ...fields }
}

export function dispatchFixtures(serverName) {
  const hp = serverName === 'hp'
  const chats = new Map()
  const add = (id, title, events, extra = {}) =>
    chats.set(id, { id, title, updated: minutes(extra.age ?? 5), events, sessions: [], busy: false, trigger: null, backend: 'claude', ...extra })
  if (hp) {
    add('roles00000000001', 'Check the machines, then start a session on the yardbell repository to fix the webhook dedup bug.', rolesTour(), { age: 2, sessions: [{ machine: 'hp', name: 'yardbell-3' }, { machine: 'hp', name: 'yardbell-2' }] })
    add('pending000000001', 'Start a session on yardbell for the dedup fix and tell the other one to stop waiting on CI.', pendingChat(), { age: 1 })
    add('group00000000001', 'Run the dead code scan on the three apps and gather the results.', groupChat(), { age: 8 })
    add('trigger000000001', 'Look for stuck pull requests.', triggerChat(), { age: 90, trigger: { name: 'Morning check', task: 'Stuck pull requests', version: 1, what: 'Every weekday at 08:00', at: minutes(95), slot: minutes(100) }, backend: 'codex' })
    add('busy000000000001', 'Read the latest session on hp and summarise where it is stuck.', busyChat(), { age: 0, busy: true })
  } else {
    add('mini0000000001', 'Which sessions are blocked on this machine?', [{ role: 'user', text: 'Which sessions are blocked on this machine?' }, { role: 'assistant', text: 'One session is blocked: `feedgest-2` is asking about a share sheet.' }], { age: 30 })
  }

  const prompts = [
    { name: 'Fix a bug', text: 'Find the failing test first. Change the smallest amount of code that makes it pass.', version: 2, builtin: true, customised: true },
    { name: 'Stuck pull requests', text: 'List pull requests that have had no activity for a day and say why each is stuck.', version: 1, builtin: true },
    { name: 'Summarise the day', text: 'Summarise what every session did today.', version: 1, builtin: true, hidden: true },
    { name: 'Review the open branch', text: 'Start a review of the branch the session is on and report the findings.', version: 1 },
    { name: 'A saved prompt with a very long name that has to be cut by the list', text: 'Short text.', version: 1 }
  ]
  const proposals = hp
    ? [
        proposal('p1000001', 'save_task', { name: 'Release notes', text: 'Write release notes from the merged pull requests of the last week.' }),
        proposal('p1000002', 'change_settings', { area: 'dispatch', change: { approval: 'allow' } }, { at: minutes(30) }),
        proposal('p1000003', 'run_trigger', { name: 'Morning check' }, { status: 'approved', decided: minutes(60), at: minutes(70), result: { ok: true, text: 'Started the trigger Morning check', at: minutes(60) } }),
        proposal('p1000004', 'save_connector', { name: 'linear', url: 'https://mcp.linear.app/mcp' }, { status: 'rejected', decided: minutes(200), at: minutes(210) })
      ]
    : [proposal('p2000001', 'set_pipeline_enabled', { name: 'Nightly import', enabled: true })]
  return { chats, prompts, proposals, settings: { dispatch: { runs_on: 'claude', model: 'sonnet', codex_model: '', approval: 'prompt', rules: [], instructions: '', agent: '' } }, busySince: null }
}

export const pendingIn = (events) => events.filter((e) => e.role === 'action' && e.status === 'pending')

export function counts(fx) {
  let waiting = 0
  for (const chat of fx.chats.values()) waiting += pendingIn(chat.events).length
  return { waiting, proposals: fx.proposals.filter((p) => p.status === 'pending').length }
}

function summary(chat) {
  return { id: chat.id, title: chat.title, updated: chat.updated, busy: chat.busy, waiting: pendingIn(chat.events).length, trigger: chat.trigger?.name ?? null, backend: chat.backend }
}

function read(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const decideOne = (event, decision, input) => {
  if (event.status !== 'pending') return false
  event.status = decision === 'approve' ? (input ? 'edited' : 'approved') : 'rejected'
  if (input) {
    event.original = event.input
    event.input = input
  }
  event.decided = new Date().toISOString()
  if (decision === 'approve') event.result = { ok: true, text: 'Done', at: event.decided }
  return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function streamAsk(req, res, fx, json, cors) {
  const body = await read(req)
  const text = String(body.text ?? '').trim()
  if (!text && !(body.attachments ?? []).length) return json(res, 400, { error: 'type a task first' })
  let chat = body.conversation ? fx.chats.get(body.conversation) : null
  if (body.conversation && !chat) return json(res, 404, { error: 'no such conversation' })
  if (chat?.busy) return json(res, 409, { error: 'this conversation is still answering' })
  if (!chat) {
    const id = `new${Date.now().toString(36)}`.padEnd(16, '0').slice(0, 16)
    chat = { id, title: text.slice(0, 80), updated: new Date().toISOString(), events: [], sessions: [], busy: false, trigger: null, backend: 'claude' }
    fx.chats.set(id, chat)
  }
  for (const e of chat.events) {
    if (e.role === 'action' && e.status === 'pending') Object.assign(e, { status: 'withdrawn', decided: new Date().toISOString() })
  }
  const user = { role: 'user', text }
  if (body.task) user.task = body.task
  if (body.improve) user.improve = body.improve
  if ((body.attachments ?? []).length) {
    user.attachments = body.attachments.map((a, i) => ({ file: `${i + 1}-${a.name}`, name: a.name, kind: 'file', size: Math.floor((a.data.length * 3) / 4) }))
  }
  chat.events.push(user)
  chat.busy = true
  res.writeHead(200, { ...cors, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
  const send = async (event, store = true) => {
    if (store) chat.events.push(event)
    chat.updated = new Date().toISOString()
    res.write(`${JSON.stringify(event)}\n`)
    await sleep(900)
  }
  req.on('close', () => {})
  res.write(`${JSON.stringify({ role: 'conversation', id: chat.id })}\n`)
  await sleep(600)
  await send({ role: 'tool', name: 'list_sessions', input: {} })
  await send({ role: 'tool_result', name: 'list_sessions', text: '[{"machine":"hp","name":"yardbell-1","state":"blocked"}]' })
  await send({ role: 'assistant', text: 'This is a preview answer.\n\n1. One session is blocked.\n2. The rest are idle.' })
  await send(step(`a9${Date.now().toString(36)}`.slice(0, 8), 'send_to_session', { machine: 'hp', name: 'yardbell-1', text: 'Answer yes.' }))
  chat.busy = false
  res.write(`${JSON.stringify({ role: 'done' })}\n`)
  res.end()
}

export async function dispatchApi(req, res, fx, { json, cors }) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const method = req.method

  if (path === '/dispatch/ask' && method === 'POST') return streamAsk(req, res, fx, json, cors), true
  if (path === '/dispatch/runs-on') {
    json(res, 200, { runs_on: 'claude', label: 'Claude Code', model: 'sonnet', agents: { claude: { label: 'Claude Code', model: 'sonnet' }, codex: { label: 'Codex', model: 'gpt-5' } }, voice_input: true, voice_mode: 'hold' })
    return true
  }
  if (path === '/dispatch/transcribe' && method === 'POST') {
    json(res, 200, { text: 'check the machines' })
    return true
  }
  if (path === '/dispatch/conversations' && method === 'GET') {
    json(res, 200, [...fx.chats.values()].sort((a, b) => b.updated.localeCompare(a.updated)).map(summary))
    return true
  }
  if (path === '/dispatch/clear' && method === 'POST') {
    let kept = 0
    for (const [id, chat] of fx.chats) chat.busy ? kept++ : fx.chats.delete(id)
    json(res, 200, { kept })
    return true
  }
  if (path === '/dispatch/tasks' && method === 'GET') {
    json(res, 200, fx.prompts)
    return true
  }
  if (path === '/dispatch/tasks' && method === 'POST') {
    const body = await read(req)
    const old = fx.prompts.find((p) => p.name === (body.replacing ?? body.name))
    if (old) Object.assign(old, { name: body.name, text: body.text, version: old.text === body.text ? old.version : old.version + 1 })
    else fx.prompts.push({ name: body.name, text: body.text, version: 1 })
    json(res, 200, fx.prompts)
    return true
  }
  if (path === '/dispatch/tasks/delete' && method === 'POST') {
    const body = await read(req)
    const gone = fx.prompts.find((p) => p.name === body.name)
    if (gone?.builtin) gone.hidden = true
    else fx.prompts = fx.prompts.filter((p) => p.name !== body.name)
    json(res, 200, fx.prompts)
    return true
  }
  if (path === '/dispatch/tasks/restore' && method === 'POST') {
    for (const p of fx.prompts) if (p.builtin) Object.assign(p, { hidden: undefined, customised: undefined, version: 1 })
    json(res, 200, fx.prompts)
    return true
  }
  if (path === '/dispatch/tasks/history') {
    const name = url.searchParams.get('name')
    const p = fx.prompts.find((t) => t.name === name)
    if (!p) return json(res, 404, { error: `there is no task called ${name}` }), true
    json(res, 200, { name, builtin: !!p.builtin, current: p.version, versions: Array.from({ length: p.version }, (_, i) => ({ n: i + 1, text: i + 1 === p.version ? p.text : 'An earlier text.', at: minutes(1000 - i * 100) })) })
    return true
  }
  if (path === '/dispatch/tasks/diff') {
    json(res, 200, { name: url.searchParams.get('name'), from: 1, to: 2, parts: [{ op: 'del', text: 'An earlier text.' }, { op: 'add', text: 'The newer text.' }] })
    return true
  }
  if (path === '/api/settings' && method === 'GET') {
    json(res, 200, fx.settings)
    return true
  }
  if (path === '/api/settings/dispatch' && method === 'POST') {
    fx.settings.dispatch = await read(req)
    json(res, 200, { ok: true })
    return true
  }

  const conv = path.match(/^\/dispatch\/conversations\/([^/]+)(?:\/(.*))?$/)
  if (conv) {
    const chat = fx.chats.get(conv[1])
    if (!chat) return json(res, 404, { error: 'no such conversation' }), true
    const rest = conv[2] ?? ''
    if (!rest && method === 'GET') {
      if (chat.id === 'busy000000000001' && chat.busy) {
        fx.busySince ??= Date.now()
        if (Date.now() - fx.busySince > 8000) {
          chat.busy = false
          chat.events.push({ role: 'tool_result', name: 'list_sessions', text: '[]' }, { role: 'assistant', text: 'The latest session on hp is waiting for an answer about running cargo test.' })
        }
      }
      json(res, 200, { ...chat, events: chat.events })
      return true
    }
    if (rest === 'stop' && method === 'POST') {
      chat.busy = false
      json(res, 200, { ok: true })
      return true
    }
    if (rest === 'delete' && method === 'POST') {
      if (chat.busy) return json(res, 409, { error: 'this conversation is still answering, stop it first' }), true
      fx.chats.delete(chat.id)
      json(res, 200, { ok: true })
      return true
    }
    if (rest === 'actions' && method === 'POST') {
      const { decision } = await read(req)
      json(res, 200, pendingIn(chat.events).filter((e) => decideOne(e, decision)))
      return true
    }
    const one = rest.match(/^actions\/([^/]+)$/)
    if (one && method === 'POST') {
      const body = await read(req)
      const event = chat.events.find((e) => e.role === 'action' && e.id === one[1])
      if (!event) return json(res, 404, { error: 'no such step' }), true
      if (!decideOne(event, body.decision, body.input)) return json(res, 409, { error: `this step was already ${event.status}` }), true
      json(res, 200, event)
      return true
    }
    const group = rest.match(/^groups\/([^/]+)$/)
    if (group && method === 'POST') {
      const { decision } = await read(req)
      json(res, 200, pendingIn(chat.events).filter((e) => e.group === group[1] && decideOne(e, decision)))
      return true
    }
    if (rest === 'answers' && method === 'POST') {
      const { card, key } = await read(req)
      const event = chat.events[card]
      if (event?.role !== 'session') return json(res, 400, { error: 'that is not a question' }), true
      if (event.answer) return json(res, 409, { error: `it was already answered with ${event.answer.label}` }), true
      const option = (event.options ?? []).find((o) => o.key === key)
      if (!option) return json(res, 400, { error: 'not one of its choices' }), true
      event.answer = { key, label: option.label, at: new Date().toISOString() }
      event.state = 'idle'
      json(res, 200, event)
      return true
    }
    if (rest === 'reviews' && method === 'POST') {
      const step_ = step(`r${Date.now().toString(36)}`.slice(0, 8), 'start_review', { machine: 'hp', name: 'yardbell-2' })
      chat.events.push(step_)
      json(res, 200, step_)
      return true
    }
    if (rest.startsWith('reviews/') && method === 'POST') {
      const { decision } = await read(req)
      const event = chat.events[Number(rest.split('/')[1])]
      if (event) event.outcome = decision
      json(res, 200, event ?? {})
      return true
    }
    if (rest === 'pulls' && method === 'POST') {
      const { card } = await read(req)
      const step_ = step(`s${Date.now().toString(36)}`.slice(0, 8), 'send_to_session', { machine: 'hp', name: 'yardbell-3', text: 'Fix the build.' })
      chat.events.push(step_)
      json(res, 200, { card, step: step_ })
      return true
    }
    if (rest.startsWith('attachments/')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'image/svg+xml' })
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#7c6cf0"/></svg>')
      return true
    }
  }

  if (path === '/api/proposals' && method === 'GET') {
    json(res, 200, { proposals: [...fx.proposals].reverse(), waiting: counts(fx).proposals })
    return true
  }
  if (path === '/api/proposals/clear' && method === 'POST') {
    const before = fx.proposals.length
    fx.proposals = fx.proposals.filter((p) => p.status === 'pending')
    json(res, 200, { cleared: before - fx.proposals.length })
    return true
  }
  const prop = path.match(/^\/api\/proposals\/([^/]+)$/)
  if (prop) {
    const p = fx.proposals.find((x) => x.id === prop[1])
    if (!p) return json(res, 404, { error: 'there is no such proposal' }), true
    if (method === 'GET') return json(res, 200, p), true
    if (method === 'DELETE') {
      fx.proposals = fx.proposals.filter((x) => x !== p)
      return json(res, 200, { deleted: p.id }), true
    }
    if (method === 'POST') {
      const body = await read(req)
      if (!decideOne(p, body.decision, body.input)) return json(res, 409, { error: `this proposal was already ${p.status}` }), true
      return json(res, 200, p), true
    }
  }
  return false
}
