const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString()

const YARDBELL = '/home/dev/Projects/yardbell'
const FEEDGEST = '/home/dev/Projects/feedgest/app'

function readBody(req) {
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

const change = (path, status, fields = {}) => ({ path, status, staged: false, added: 4, removed: 1, binary: false, ...fields })

function changeFixtures() {
  return {
    [YARDBELL]: {
      branch: 'mobile-app',
      head: 'a8b9d4d1c2e3f4a5b6c7d8e9f0a1b2c3d4e5f607',
      upstream: 'origin/mobile-app',
      ahead: 2,
      behind: 0,
      truncated: false,
      pushFails: 'git said: To github.com:acme/yardbell.git\n ! [rejected]        mobile-app -> mobile-app (fetch first)\nerror: failed to push some refs to \'github.com:acme/yardbell.git\'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. Integrate the remote changes (for example, git pull ...) before pushing again.',
      files: [
        change('mobile/src/changes/api.ts', 'added', { staged: true, added: 98, removed: 0 }),
        change('mobile/src/pipelines/model.ts', 'modified', { staged: true, added: 31, removed: 4 }),
        change('mobile/src/pipelines/model.ts', 'modified', { added: 2, removed: 2 }),
        change('src/web/pipeline_api.rs', 'modified', { added: 12, removed: 3 }),
        change('src/old_runs.rs', 'deleted', { added: 0, removed: 41 }),
        change('src/web/runs.rs', 'renamed', { old_path: 'src/web/run_list.rs', added: 6, removed: 6 }),
        change('mobile/assets/logo.png', 'modified', { binary: true, added: null, removed: null }),
        change('src/huge_generated.rs', 'modified', { added: 7000, removed: 200 }),
        change('notes/todo.md', 'untracked', { added: null, removed: null }),
        change('.env.example', 'untracked', { added: null, removed: null })
      ]
    },
    [FEEDGEST]: {
      branch: 'main',
      head: '0123456789abcdef0123456789abcdef01234567',
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      truncated: false,
      files: []
    }
  }
}

function emptyChanges() {
  return { branch: 'main', head: 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed', upstream: 'origin/main', ahead: 0, behind: 1, truncated: false, files: [] }
}

const hunkLine = (text) => ({ k: 'hunk', o: null, n: null, t: text })

function smallDiff(file) {
  if (file.status === 'untracked' || file.status === 'added') {
    const lines = Array.from({ length: 6 }, (_, i) => ({ k: 'add', o: null, n: i + 1, t: `line ${i + 1} of ${file.path}` }))
    return { lines: [hunkLine('@@ -0,0 +1,6 @@'), ...lines] }
  }
  if (file.status === 'deleted') {
    const lines = Array.from({ length: 5 }, (_, i) => ({ k: 'del', o: i + 1, n: null, t: `removed line ${i + 1}` }))
    return { lines: [hunkLine('@@ -1,5 +0,0 @@'), ...lines] }
  }
  return {
    lines: [
      hunkLine('@@ -10,7 +10,8 @@ export function run() {'),
      { k: 'ctx', o: 10, n: 10, t: '  const server = pick()' },
      { k: 'ctx', o: 11, n: 11, t: '  const rows = load(server)' },
      { k: 'del', o: 12, n: null, t: '  return rows.filter(Boolean)' },
      { k: 'add', o: null, n: 12, t: '  const kept = rows.filter(Boolean)' },
      { k: 'add', o: null, n: 13, t: '  return kept.sort(byAge)' },
      { k: 'ctx', o: 13, n: 14, t: '}' },
      hunkLine('@@ -40,3 +41,3 @@ function byAge(a, b) {'),
      { k: 'ctx', o: 40, n: 41, t: '  const left = Date.parse(a.at)' },
      { k: 'del', o: 41, n: null, t: '  return left - Date.parse(b.at)' },
      { k: 'add', o: null, n: 42, t: '  return Date.parse(b.at) - left' }
    ]
  }
}

const HUGE_TOTAL = 7200

function hugeDiff(from) {
  const end = Math.min(from + 5000, HUGE_TOTAL)
  const lines = []
  for (let i = from; i < end; i++) {
    if (i % 60 === 0) lines.push(hunkLine(`@@ -${i},60 +${i},60 @@ fn generated_${i / 60}()`))
    else if (i % 7 === 3) lines.push({ k: 'del', o: i, n: null, t: `    let value_${i} = old_value(${i});` })
    else if (i % 7 === 4) lines.push({ k: 'add', o: null, n: i, t: `    let value_${i} = new_value(${i});` })
    else lines.push({ k: 'ctx', o: i, n: i, t: `    let value_${i} = compute(${i}); // generated` })
  }
  return { lines, from, next: end, total: HUGE_TOTAL, cut: false }
}

function diffFor(fx, root, url) {
  const state = fx.changes[root]
  const path = url.searchParams.get('path')
  const staged = url.searchParams.get('staged') === 'true'
  const from = Number(url.searchParams.get('from') || 0)
  const file = state?.files.find((f) => f.path === path && f.staged === staged)
  if (!file) return null
  const base = { path: file.path, old_path: file.old_path, status: file.status, staged: file.staged, added: file.added, removed: file.removed, binary: file.binary }
  if (file.binary) return { ...base, notes: ['Binary files differ'], lines: [], from: 0, next: 0, total: 0, cut: false }
  if (file.path === 'src/huge_generated.rs') return { ...base, notes: [], ...hugeDiff(from) }
  const small = smallDiff(file)
  return { ...base, notes: [], lines: small.lines, from: 0, next: small.lines.length, total: small.lines.length, cut: false }
}

function changesApi(fx, path, url, method, body, json, res) {
  const match = path.match(/^\/machines\/([^/]+)\/changes(?:\/(diff|draft|commit|stage|unstage|discard|push|pull|fetch))?$/)
  if (!match) return false
  const root = (method === 'GET' ? url.searchParams.get('root') : body.root) || ''
  const state = fx.changes[root] ?? (fx.changes[root] = emptyChanges())
  const action = match[2]
  if (!action) return json(res, 200, { ...state, pushFails: undefined }), true
  if (action === 'diff') {
    const diff = diffFor(fx, root, url)
    if (!diff) return json(res, 404, { error: `${url.searchParams.get('path')} has no ${url.searchParams.get('staged') === 'true' ? 'staged' : 'unstaged'} changes to show` }), true
    return json(res, 200, diff), true
  }
  if (action === 'draft') {
    if (!state.files.length) return json(res, 422, { error: 'there are no changes to describe' }), true
    return json(res, 200, { message: 'Add the changes api, update pipelines model and pipeline routes', from: 'files' }), true
  }
  if (action === 'commit') {
    if (!String(body.message || '').trim()) return json(res, 400, { error: 'the commit message is empty' }), true
    const picked = body.staged ? state.files.filter((f) => f.staged) : body.paths ? state.files.filter((f) => body.paths.includes(f.path)) : state.files
    if (!picked.length) return json(res, 422, { error: 'there is nothing to commit' }), true
    state.files = state.files.filter((f) => !picked.includes(f))
    state.ahead = (state.ahead || 0) + 1
    const sha = `c0ffee${Date.now().toString(16)}`.padEnd(40, '0')
    return json(res, 200, { sha, short: sha.slice(0, 7) }), true
  }
  if (action === 'push') {
    if (state.pushFails) return json(res, 422, { error: state.pushFails }), true
    state.ahead = 0
    return json(res, 200, { ok: true }), true
  }
  if (action === 'pull') {
    state.behind = 0
    return json(res, 200, { ok: true }), true
  }
  if (action === 'fetch') return json(res, 200, { ok: true }), true
  const paths = body.paths || []
  if (!paths.length) return json(res, 400, { error: 'name at least one file' }), true
  for (const p of paths) {
    const files = state.files.filter((f) => f.path === p)
    if (!files.length) return json(res, 400, { error: `${p} has no changes` }), true
    if (action === 'stage') for (const f of files) if (!f.staged) f.staged = true
    if (action === 'unstage') for (const f of files) if (f.staged) f.staged = false
    if (action === 'discard') state.files = state.files.filter((f) => !(f.path === p && !f.staged))
  }
  return json(res, 200, { ok: true }), true
}

const dir = (name) => ({ name, kind: 'dir', size: 0 })
const file = (name, size) => ({ name, kind: 'file', size })

const TREE = {
  '': [dir('.github'), dir('assets'), dir('docs'), dir('notes'), dir('src'), file('.env.example', 22), file('.gitignore', 41), file('Cargo.toml', 612), file('README.md', 1480), file('big.log', 640_000), file('dump.sql', 3_400_000)],
  '.github': [dir('workflows'), file('CODEOWNERS', 30)],
  '.github/workflows': [file('ci.yml', 920)],
  assets: [file('logo.png', 18_400), file('icon.svg', 1200)],
  docs: [file('guide.md', 2400), file('notes.txt', 300)],
  notes: [file('todo.md', 80)],
  src: [file('huge_generated.rs', 4200), file('lib.rs', 2200), file('main.rs', 900), file('web.rs', 5100)]
}

const README = `# Yardbell

Run coding agents on your machines and watch them from your phone.

## Install

\`\`\`sh
cargo install yardbell
yardbell serve
\`\`\`

## What it does

- Lists every session on every machine
- Opens a terminal in the browser
- Sends a notification when an agent needs you

> The phone app pairs with a link, not a password.

| Key | Meaning |
|---|---|
| \`d\` | Dispatch |
| \`p\` | Pipelines |
`

const TEXTS = {
  'README.md': README,
  '.gitignore': 'target/\nnode_modules/\n.env\n.DS_Store\n',
  'Cargo.toml': '[package]\nname = "yardbell"\nversion = "0.11.110"\nedition = "2021"\n\n[dependencies]\naxum = "0.8"\nserde = { version = "1", features = ["derive"] }\n',
  'docs/guide.md': '# Guide\n\n1. Pair a phone\n2. Start a session\n3. Review the diff\n',
  'docs/notes.txt': 'Notes for the release.\nCheck the changelog.\n',
  '.github/CODEOWNERS': '* @acme/core\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: cargo test\n',
  'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>\n',
  'notes/todo.md': '- Files screen\n- Changes colours\n',
  '.env.example': 'TOKEN=changeme\n',
  'src/huge_generated.rs': '// generated\npub const TABLE: [u32; 3] = [1, 2, 3];\n',
  'src/lib.rs': 'pub mod web;\n\npub fn version() -> &\'static str {\n    env!("CARGO_PKG_VERSION")\n}\n',
  'src/main.rs': 'fn main() {\n    yardbell::serve();\n}\n',
  'src/web.rs': Array.from({ length: 180 }, (_, i) => `// route ${i + 1}\npub fn route_${i + 1}() -> u32 { ${i + 1} }`).join('\n') + '\n'
}

function bigLog() {
  return Array.from({ length: 14000 }, (_, i) => `2026-11-27T08:${String(i % 60).padStart(2, '0')}:00Z INFO request ${i} handled in ${(i * 7) % 90} ms`).join('\n') + '\n'
}

function filesApi(fx, path, url, method, json, res) {
  const match = path.match(/^\/machines\/([^/]+)\/(files|file|files\/search)$/)
  if (!match) return false
  const kind = match[2]
  const rel = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '')
  if (kind === 'files') {
    const entries = TREE[rel]
    if (!entries) return json(res, 404, { error: `${rel} does not exist` }), true
    return json(res, 200, { path: rel, entries, more: false }), true
  }
  if (kind === 'file') {
    const name = rel.split('/').pop()
    if (rel === 'assets/logo.png') return json(res, 415, { error: `${rel} is a binary file, so it is not shown` }), true
    if (rel === 'dump.sql') return json(res, 413, { error: `${rel} is 3.2 MB, larger than the 1.0 MB Yardbell shows` }), true
    const text = rel === 'big.log' ? bigLog() : TEXTS[rel]
    if (text === undefined) return json(res, 404, { error: `${rel || name} does not exist` }), true
    return json(res, 200, { path: rel, size: Buffer.byteLength(text), text, hash: `h${text.length}`, editable: true }), true
  }
  const q = (url.searchParams.get('q') || '').toLowerCase()
  const mode = url.searchParams.get('mode')
  if (!q) return json(res, 200, { matches: [], more: false }), true
  const all = Object.entries(TREE).flatMap(([folder, entries]) => entries.filter((e) => e.kind === 'file').map((e) => (folder ? `${folder}/${e.name}` : e.name)))
  const matches = mode === 'contents' ? all.filter((p) => (TEXTS[p] ?? '').toLowerCase().includes(q)) : all.filter((p) => p.toLowerCase().includes(q))
  return json(res, 200, { matches, more: false }), true
}

function step(id, name, kind, next, extra = {}) {
  return { id, name, kind, next, x: 0, y: 0, ...extra }
}

function definitions() {
  const implement = {
    id: 'implement-my-tickets',
    name: 'Implement my tickets',
    version: 4,
    enabled: true,
    start: 'plan',
    trigger: { kind: 'linear', assigned: true, states: ['Todo'], filter: { labels: ['mobile'] } },
    token_limit: 400000,
    steps: [
      step('plan', 'Plan', 'plan', { pass: 'implement' }, { machines: ['hp'] }),
      step('implement', 'Implement', 'agent', { pass: 'review', fail: 'plan' }, { instructions: 'Implement the ticket in a new worktree and run the tests.', machine: { name: 'hp' }, workspace: { kind: 'new' } }),
      step('review', 'Review and fix', 'agent', { pass: 'push', fail: 'implement' }, { instructions: 'Review the diff for bugs and fix what you find.', read_only: false, machine: { same_as: 'implement' }, workspace: { kind: 'same_as', step: 'implement' } }),
      step('push', 'Push draft', 'push', { pass: 'checks' }),
      step('checks', 'Wait for CI', 'checks', { pass: 'report', fail: 'review' }, { require_approval: true }),
      step('report', 'Report', 'report', {})
    ]
  }
  const nightly = {
    id: 'nightly-import',
    name: 'Nightly import check',
    version: 2,
    enabled: false,
    start: 'run',
    trigger: { kind: 'schedule', schedule: 'every day at 02:00' },
    steps: [step('run', 'Run import', 'command', { pass: 'tell', fail: 'tell' }, { command: 'bin/rails import:verify', approved: 'bin/rails import:verify' }), step('tell', 'Tell me', 'report', {})]
  }
  const reviews = {
    id: 'review-my-merge-requests',
    name: 'Review my merge requests',
    version: 1,
    enabled: true,
    start: 'understand',
    trigger: { kind: 'gitlab_reviewer', host: 'gitlab.acme.dev' },
    steps: [step('understand', 'Understand', 'agent', { pass: 'security' }, { instructions: 'Read the merge request and say what it does.', read_only: true, machine: { pick: ['hp', 'mac-mini'] }, workspace: { kind: 'new' } }), step('security', 'Security', 'agent', { pass: 'report' }, { instructions: 'Look for security problems.', read_only: true, machine: { name: 'hp' }, workspace: { kind: 'copy', from: 'understand' } }), step('report', 'Report', 'report', {})]
  }
  const idea = {
    id: 'try-an-idea',
    name: 'Try an idea',
    version: 3,
    enabled: true,
    start: 'build',
    trigger: { kind: 'manual' },
    steps: [
      step('build', 'Build it', 'agent', { pass: 'lint' }, { instructions: 'Build what the ticket or diagram asks for.', machine: { name: 'hp' }, workspace: { kind: 'new' } }),
      step('lint', 'Lint', 'command', { pass: 'tell', fail: 'build' }, { command: 'npm run lint', approved: 'npm run lint' }),
      step('tell', 'Tell me', 'report', {})
    ]
  }
  return [implement, nightly, reviews, idea]
}

const subject = (id, title) => ({ ticket: { id, title, url: `https://linear.app/acme/issue/${id}` } })

function runs(defs) {
  const implement = defs[0]
  const reviews = defs[2]
  const idea = defs[3]
  const base = (id, def, fields) => ({
    id,
    pipeline: def.id,
    pipeline_name: def.name,
    version: def.version,
    definition: def,
    started: minutes(300),
    started_by: 'trigger',
    steps: {},
    history: [],
    questions: [],
    tokens: { limit: 400000 },
    tokens_used: 0,
    tokens_from_cache: 0,
    conversation: '',
    terminals: [],
    sessions_left: [],
    ...fields
  })
  return [
    base('run-waiting', implement, {
      state: 'waiting',
      step: 'review',
      step_since: minutes(18),
      started: minutes(95),
      subject: subject('YB-214', 'Phone app step 3: changes and files'),
      waiting: { kind: 'questions', step: 'review', reason: 'Review and fix has questions for you', screen: '' },
      questions: [{ asked: 'The diff touches the Dispatch settings route. Should the phone keep re-reading before it saves?' }, { asked: 'Is a 5000 line page the right size for a phone?' }],
      steps: {
        plan: { outcome: 'pass', started: minutes(94), ended: minutes(90), runs: 1, report: 'Plan: add API clients, then screens.' },
        implement: { outcome: 'pass', started: minutes(89), ended: minutes(30), runs: 2, report: 'Added the clients and the pure models. Tests pass.', made: 'yardbell-worktrees/yb-214', machine: 'hp', session: 'implement-yb-214' },
        review: { started: minutes(29), runs: 1, machine: 'hp', session: 'review-yb-214' }
      },
      history: [
        { at: minutes(94), step: 'plan', note: 'Started' },
        { at: minutes(90), step: 'plan', outcome: 'pass' },
        { at: minutes(30), step: 'implement', outcome: 'pass' }
      ],
      tokens_used: 182400,
      tokens_from_cache: 910000,
      conversation: 'trigger000000001',
      place: { machine: 'hp', branch: 'yb-214-changes-files' },
      terminals: [{ name: 'review-yb-214', machine: 'hp', label: 'Review and fix', current: true }, { name: 'implement-yb-214', machine: 'hp', label: 'Implement' }]
    }),
    base('run-token', implement, {
      state: 'waiting',
      step: 'implement',
      step_since: minutes(40),
      subject: subject('YB-230', 'Show the pipeline count on Home'),
      waiting: { kind: 'token_limit', step: 'implement', reason: 'Implement was not started: the run used 401,000 of its 400,000 tokens', screen: '' },
      steps: { plan: { outcome: 'pass', started: minutes(120), ended: minutes(118), runs: 1, report: 'Plan done.' } },
      tokens_used: 401000
    }),
    base('run-held', implement, {
      state: 'queued',
      step: 'implement',
      step_since: minutes(55),
      subject: subject('YB-231', 'Fix the badge colour in dark mode'),
      held: { kind: 'memory', machine: 'hp', reason: 'hp is short of memory', since: minutes(55), told: true },
      steps: { plan: { outcome: 'pass', started: minutes(70), ended: minutes(66), runs: 1, report: 'Plan done.' } }
    }),
    base('run-queued', implement, {
      state: 'queued',
      step: 'plan',
      step_since: minutes(2),
      subject: subject('YB-232', 'Rename the Files tab'),
      held: { kind: 'spacing', since: minutes(1), told: false }
    }),
    base('run-running', implement, {
      state: 'running',
      step: 'checks',
      step_since: minutes(6),
      started: minutes(240),
      subject: { ...subject('YB-190', 'Revoke closes sockets'), pr: { number: 398, url: 'https://github.com/acme/yardbell/pull/398', forge: 'github' } },
      steps: {
        plan: { outcome: 'pass', started: minutes(239), ended: minutes(236), runs: 1, report: 'Plan done.' },
        implement: { outcome: 'pass', started: minutes(235), ended: minutes(120), runs: 1 },
        review: { outcome: 'pass', started: minutes(119), ended: minutes(40), runs: 3, report: 'Fixed two bugs found in review.' },
        push: { outcome: 'pass', started: minutes(39), ended: minutes(38), runs: 1, details: ['Pushed yb-190 to origin'] },
        checks: { started: minutes(6), runs: 1, watch: { status: 'CI pending' } }
      },
      pull: { number: 398, url: 'https://github.com/acme/yardbell/pull/398' },
      tokens_used: 96000,
      place: { machine: 'hp', branch: 'yb-190-revoke-sockets' },
      terminals: [{ name: 'review-yb-190', machine: 'hp', label: 'Review and fix', current: true }]
    }),
    base('run-done', implement, {
      state: 'done',
      step: 'report',
      step_since: minutes(1500),
      started: minutes(1700),
      subject: subject('YB-180', 'Dispatch settings screen'),
      steps: {
        plan: { outcome: 'pass', started: minutes(1699), ended: minutes(1690), runs: 1, report: 'Plan done.' },
        implement: { outcome: 'pass', started: minutes(1689), ended: minutes(1560), runs: 1, report: 'Built the screen.', made: 'yardbell-worktrees/yb-180', machine: 'hp' },
        review: { outcome: 'pass', started: minutes(1559), ended: minutes(1520), runs: 1 },
        push: { outcome: 'pass', started: minutes(1519), ended: minutes(1518), runs: 1 },
        checks: { outcome: 'pass', started: minutes(1517), ended: minutes(1505), runs: 1 },
        report: { outcome: 'pass', started: minutes(1504), ended: minutes(1500), runs: 1, report: 'Shipped as pull request 401.' }
      },
      history: [{ at: minutes(1500), step: 'report', outcome: 'pass' }],
      report: 'YB-180 shipped as pull request 401. CI passed and a reviewer approved.',
      pull: { number: 401, url: 'https://github.com/acme/yardbell/pull/401' },
      tokens_used: 211000,
      sessions_left: [{ name: 'implement-yb-180', machine: 'hp' }],
      conversation: 'trigger000000001'
    }),
    base('run-failed', implement, {
      state: 'done',
      step: 'checks',
      step_since: minutes(2600),
      started: minutes(2800),
      subject: subject('YB-171', 'Try the long diff page'),
      steps: {
        plan: { outcome: 'pass', started: minutes(2799), ended: minutes(2790), runs: 1, report: 'Plan done.' },
        implement: { outcome: 'pass', started: minutes(2789), ended: minutes(2700), runs: 1, report: 'Implemented.' },
        review: { outcome: 'pass', started: minutes(2699), ended: minutes(2650), runs: 1 },
        push: { outcome: 'pass', started: minutes(2649), ended: minutes(2648), runs: 1 },
        checks: { outcome: 'fail', started: minutes(2647), ended: minutes(2600), runs: 2, details: ['android build failed'] }
      },
      history: [{ at: minutes(2600), step: 'checks', outcome: 'fail', note: 'The android build failed' }],
      report: 'CI failed on the android build and the run ended.'
    }),
    base('run-dropped', reviews, {
      state: 'dropped',
      step: 'security',
      step_since: minutes(3000),
      started: minutes(3100),
      subject: { pr: { number: 2210, url: 'https://gitlab.acme.dev/acme/app/-/merge_requests/2210', forge: 'gitlab' } },
      steps: { understand: { outcome: 'pass', started: minutes(3099), ended: minutes(3050), runs: 1, report: 'The merge request fixes webhook dedup.' } },
      history: [{ at: minutes(3000), step: 'security', note: 'Dropped by you' }]
    }),
    base('run-lint', idea, {
      state: 'waiting',
      step: 'lint',
      step_since: minutes(4),
      started: minutes(25),
      started_by: 'you',
      subject: {},
      waiting: { kind: 'failed', step: 'lint', reason: 'Lint failed with exit code 1', screen: "> npm run lint\n\n/src/pipelines/RunScreen.tsx\n  42:7  error  'unused' is assigned a value but never used  no-unused-vars\n\n1 problem (1 error, 0 warnings)" },
      steps: {
        build: { outcome: 'pass', started: minutes(24), ended: minutes(6), runs: 1, machine: 'hp', session: 'build-idea-7' },
        lint: { started: minutes(5), ended: minutes(4), runs: 1, machine: 'hp', ran: { command: 'npm run lint', passed: false } }
      },
      history: [
        { at: minutes(25), note: 'started by you' },
        { at: minutes(6), step: 'build', outcome: 'pass' },
        { at: minutes(4), step: 'lint' }
      ],
      tokens: {},
      tokens_used: 52000
    }),
    base('run-review-waiting', reviews, {
      state: 'waiting',
      step: 'understand',
      step_since: minutes(9),
      subject: { pr: { number: 2215, url: 'https://gitlab.acme.dev/acme/app/-/merge_requests/2215', forge: 'gitlab' } },
      waiting: { kind: 'no_result', step: 'understand', reason: 'Understand went quiet', screen: '' }
    })
  ]
}

const brief = (r) => ({ id: r.id, pipeline: r.pipeline, pipeline_name: r.pipeline_name, state: r.state, step: r.step, step_since: r.step_since, waiting: r.waiting ?? null, held: r.held ?? null, subject: r.subject, conversation: r.conversation })

export const asksForYou = (r) => r.state === 'waiting' || (r.state === 'queued' && Boolean(r.held?.told))

function countsFor(list, id) {
  const mine = list.filter((r) => r.pipeline === id)
  const count = (states) => mine.filter((r) => states.includes(r.state)).length
  return { running: count(['queued', 'running']), waiting: count(['waiting']), held: mine.filter((r) => r.held?.told).length, done: count(['done']) }
}

const CONNECTORS = [{ id: 'jira', name: 'Jira', enabled: true, params: [{ name: 'project', label: 'Project', filter: true }], calls: [{ name: 'search', kind: 'lookup', needs: [] }] }]

function pipelineApi(fx, path, url, method, body, json, res) {
  const p = fx.pipelines
  if (path === '/api/pipelines' && method === 'GET') {
    return json(res, 200, {
      pipelines: p.defs.map((definition) => ({ definition, runs: countsFor(p.runs, definition.id), problem: definition.id === 'nightly-import' ? 'The command needs an approval' : undefined })),
      templates: ['Implement my tickets', 'Review my merge requests'],
      settings: { per_machine: 2, minutes: 3, memory_limit: 85, token_limit: 400000 },
      machines: ['hp', 'mac-mini'],
      agents: ['claude', 'codex'],
      agents_without_tokens: ['codex'],
      default_agent: 'claude',
      mcp_servers: [],
      gitlab_hosts: ['gitlab.acme.dev'],
      connectors: CONNECTORS
    }), true
  }
  if (path === '/api/diagrams') {
    return json(res, 200, { version: 1, machines: [], agents: [], default_agent: 'claude', diagrams: [{ machine: 'hp', folder: 'yardbell', dir: 'login-flow-20261120-101010' }, { machine: 'mac-mini', folder: 'feedgest', dir: 'feed_ranking-20261118-090000' }] }), true
  }
  if (path === '/api/pipelines/tickets') {
    return json(res, 200, { tickets: [{ linear_id: 'l1', id: 'YB-240', title: 'Show insights from the machine row menu', url: 'https://linear.app/acme/issue/YB-240', state: 'Todo', running_in: [] }, { linear_id: 'l2', id: 'YB-214', title: 'Phone app step 3: changes and files', url: 'https://linear.app/acme/issue/YB-214', state: 'In Progress', running_in: ['implement-my-tickets'] }] }), true
  }
  if (path === '/api/runs' && method === 'GET') {
    const state = url.searchParams.get('state')
    const list = p.runs.filter((r) => !state || r.state === state)
    const wantsBrief = !['', '0', null].includes(url.searchParams.get('brief'))
    return json(res, 200, { runs: wantsBrief ? list.map(brief) : list }), true
  }
  const run = path.match(/^\/api\/runs\/([^/]+)(?:\/(answer|retry|accept-tool|drop|continue|token-limit|stop-session|steps\/([^/]+)\/transcript))?$/)
  if (run) {
    const found = p.runs.find((r) => r.id === decodeURIComponent(run[1]))
    if (!found) return json(res, 404, { error: `${run[1]} is not a run` }), true
    const action = run[2]
    if (!action && method === 'DELETE') {
      p.runs = p.runs.filter((r) => r !== found)
      return json(res, 200, { deleted: found.id }), true
    }
    if (run[3]) return json(res, 200, transcript(found, decodeURIComponent(run[3]))), true
    if (action === 'stop-session') {
      found.terminals = found.terminals.filter((t) => t.name !== body.name)
      return json(res, 200, { ok: true }), true
    }
    if (action === 'drop') {
      Object.assign(found, { state: 'dropped', waiting: null, held: null })
      return json(res, 200, found), true
    }
    if (action === 'token-limit' && !(Number(body.limit) > found.tokens_used)) return json(res, 400, { error: 'the limit must be above the tokens already used' }), true
    if (action) {
      Object.assign(found, { state: 'running', waiting: null, step_since: new Date().toISOString() })
      return json(res, 200, found), true
    }
  }
  const pipeline = path.match(/^\/api\/pipelines\/([^/]+)(?:\/(enabled|history|runs|clear-runs))?$/)
  if (pipeline) {
    const def = p.defs.find((d) => d.id === decodeURIComponent(pipeline[1]))
    if (!def) return json(res, 404, { error: `no pipeline ${pipeline[1]}` }), true
    const action = pipeline[2]
    if (!action) return json(res, 200, def), true
    if (action === 'enabled') {
      def.enabled = Boolean(body.enabled)
      return json(res, 200, def), true
    }
    if (action === 'history') {
      return json(res, 200, { current: def.version, history: Array.from({ length: def.version }, (_, i) => ({ version: def.version - i, saved: minutes(600 * (i + 1)), definition: { ...def, version: def.version - i } })) }), true
    }
    if (action === 'runs' && method === 'GET') return json(res, 200, { runs: p.runs.filter((r) => r.pipeline === def.id) }), true
    if (action === 'runs') {
      const items = [...(body.tickets || []), ...(body.prs || [])]
      if (!def.steps.length) return json(res, 409, { error: `${def.name} has no steps yet` }), true
      const started = (items.length ? items : [null]).map((item, i) => ({
        id: `run-new-${Date.now()}-${i}`,
        pipeline: def.id,
        pipeline_name: def.name,
        version: def.version,
        definition: def,
        state: 'running',
        step: def.start,
        step_since: new Date().toISOString(),
        started: new Date().toISOString(),
        started_by: 'you',
        subject: item ? subject(String(item), 'Started from the phone') : {},
        steps: {},
        history: [],
        questions: [],
        tokens: {},
        tokens_used: 0,
        tokens_from_cache: 0,
        conversation: '',
        terminals: [],
        sessions_left: []
      }))
      p.runs.unshift(...started)
      return json(res, 200, { runs: started }), true
    }
    if (action === 'clear-runs') {
      const gone = p.runs.filter((r) => r.pipeline === def.id && ['done', 'dropped'].includes(r.state)).map((r) => r.id)
      p.runs = p.runs.filter((r) => !gone.includes(r.id))
      return json(res, 200, { deleted: gone }), true
    }
  }
  return false
}

function transcript(run, stepId) {
  const st = run.steps[stepId]
  if (!st?.session) return { available: false, why: 'This step ran no agent session, so there is no transcript.' }
  return {
    available: true,
    path: `/home/dev/.claude/projects/${run.id}/${stepId}.jsonl`,
    machine: st.machine ?? 'hp',
    transcript: {
      dropped: 0,
      skipped: 3,
      cut: false,
      files: ['mobile/src/pipelines/model.ts', 'mobile/src/changes/api.ts'],
      items: [
        { kind: 'prompt', text: 'Implement the ticket in a new worktree and run the tests.', at: minutes(89) },
        { kind: 'agent', text: 'I will start with the API clients, then the pure models.', at: minutes(88) },
        { kind: 'tool', name: 'Bash', input: 'npm test', result: 'Tests 575 passed (575)', at: minutes(60), failed: false },
        { kind: 'tool', name: 'Bash', input: 'npm run typecheck', result: "src/a.ts(3,1): error TS2304: Cannot find name 'x'.", at: minutes(45), failed: true },
        { kind: 'agent', text: 'Fixed the type error and the tests pass.', at: minutes(31) }
      ]
    }
  }
}

function triggerFixtures() {
  return [
    { trigger: { name: 'Hourly digest', task: 'Summarise the day', enabled: true, schedule: 'every hour' }, kind: 'schedule', describe: 'Every hour', next: new Date(Date.now() + 1800_000).toISOString(), last: { at: minutes(30), outcome: 'failed', text: 'The task Summarise the day is hidden', conversation: '' }, note: '', problem: '', checked: null, busy: true },
    { trigger: { name: 'My Linear tickets', task: 'Fix a bug', enabled: true, linear: { assigned: true, states: ['Todo'] } }, kind: 'linear', describe: 'When a Linear ticket assigned to me moves to Todo', next: null, last: null, note: 'Checked, nothing new', problem: '', checked: minutes(2), busy: false },
    { trigger: { name: 'Review requests', task: 'Review the open branch', enabled: false, github: { review_requested: true } }, kind: 'github', describe: 'When someone asks me to review a pull request', next: null, last: null, note: '', problem: 'The GitHub token is missing. Add it under Settings, Integrations', checked: null, busy: false },
    { trigger: { name: 'Morning check', task: 'Stuck pull requests', enabled: true, schedule: 'every weekday at 08:00' }, kind: 'schedule', describe: 'Every weekday at 08:00', next: new Date(Date.now() + 9 * 3600_000).toISOString(), last: { at: minutes(900), outcome: 'started', text: 'Started by schedule', conversation: 'trigger000000001' }, note: '', problem: '', checked: null, busy: false }
  ]
}

function triggersApi(fx, path, method, body, json, res) {
  const view = () => ({ zone: 'Europe/London', now: new Date().toISOString(), triggers: fx.triggers, tasks: ['Fix a bug', 'Stuck pull requests', 'Review the open branch'] })
  if (path === '/api/triggers' && method === 'GET') return json(res, 200, view()), true
  if (path === '/api/triggers/enable') {
    const t = fx.triggers.find((x) => x.trigger.name === body.name)
    if (!t) return json(res, 400, { error: 'no such trigger' }), true
    t.trigger.enabled = Boolean(body.enabled)
    return json(res, 200, view()), true
  }
  if (path === '/api/triggers/run') {
    const t = fx.triggers.find((x) => x.trigger.name === body.name)
    if (!t) return json(res, 409, { error: 'no such trigger' }), true
    if (t.busy) return json(res, 409, { error: 'its last run is still working. Wait for it, or stop it in Dispatch' }), true
    if (t.kind === 'schedule') return json(res, 200, { conversation: 'trigger000000001' }), true
    if (!t.trigger.enabled) return json(res, 409, { error: 'turn the trigger on first' }), true
    return json(res, 200, { conversation: null, text: 'Checked, nothing new' }), true
  }
  return false
}

const longInstructions = () => Array.from({ length: 62 }, (_, i) => `Rule ${i + 1}: work for acme/web${i} goes to devbox unless it is down.`).join('\n').slice(0, 3720)

function fullMemory() {
  const entries = Array.from({ length: 14 }, (_, i) => `Note ${i + 1}: ` + 'The deploy for acme/web goes through the shared docker stack on devbox, and the staging site follows the main branch. '.repeat(4).slice(0, 470))
  return { entries, history: [{ change: 'add', entry: entries[13], at: minutes(60), by: 'dispatch' }] }
}

function memoryFixtures() {
  return {
    entries: ['Releases go 0.11.111, 0.11.112 in Cargo, tags and titles.', 'The user prefers short answers and no em dashes.', 'hp runs Docker; the Mac mini is for editing.'],
    history: [
      { change: 'add', entry: 'hp runs Docker; the Mac mini is for editing.', at: minutes(120), by: 'dispatch', reason: 'The user said so' },
      { change: 'replace', old: 'Releases go 0.11.109.', entry: 'Releases go 0.11.111, 0.11.112 in Cargo, tags and titles.', at: minutes(1000), by: 'you' },
      { change: 'forget', old: 'The staging site is on port 3000.', at: minutes(4000), by: 'you', reason: 'Out of date' }
    ]
  }
}

const memoryView = (m) => {
  const bytes = m.entries.reduce((n, e) => n + Buffer.byteLength(e) + 3, 0)
  return { entries: m.entries, bytes, max_bytes: 8192, max_entry_chars: 500, omitted: 0, file: '/home/dev/.local/share/yardbell/dispatch/memory.md', history: m.history, error: null }
}

function memoryApi(fx, path, method, body, json, res) {
  if (path !== '/dispatch/memory') return false
  const m = fx.memory
  if (method === 'POST') {
    const entry = String(body.entry ?? '').replace(/\s+/g, ' ').trim()
    const at = new Date().toISOString()
    if (body.change === 'add' || body.change === 'replace') {
      if (!entry) return json(res, 400, { error: 'the entry is empty' }), true
      if (entry.length > 500) return json(res, 400, { error: 'an entry can be at most 500 characters; split it or shorten it' }), true
    }
    if (body.change === 'add') m.entries.push(entry)
    else if (m.entries.includes(body.old)) {
      if (body.change === 'replace') m.entries[m.entries.indexOf(body.old)] = entry
      else m.entries = m.entries.filter((e) => e !== body.old)
    } else return json(res, 400, { error: 'that entry is no longer in the memory' }), true
    m.history.unshift({ change: body.change, old: body.old, entry: entry || undefined, at, by: 'you', reason: body.reason })
  }
  return json(res, 200, memoryView(m)), true
}

function promptHistoryApi(fx, path, url, method, body, json, res) {
  const history = fx.promptHistory
  if (path === '/dispatch/tasks/history') {
    const name = url.searchParams.get('name')
    const prompt = fx.dispatch.prompts.find((t) => t.name === name)
    if (!prompt) return json(res, 404, { error: `there is no task called ${name}` }), true
    const versions = history[name] ?? [{ n: 1, text: prompt.text, at: minutes(5000) }]
    return json(res, 200, { name, builtin: Boolean(prompt.builtin), current: prompt.version, versions: [...versions].sort((a, b) => b.n - a.n) }), true
  }
  if (path === '/dispatch/tasks/diff') {
    const name = url.searchParams.get('name')
    const from = Number(url.searchParams.get('from'))
    const to = Number(url.searchParams.get('to'))
    const versions = history[name] ?? []
    const text = (n) => versions.find((v) => v.n === n)?.text
    if (text(from) === undefined || text(to) === undefined) return json(res, 404, { error: `version ${text(from) === undefined ? from : to} of ${name} does not exist` }), true
    const a = text(from).split(/(\s+)/)
    const b = text(to).split(/(\s+)/)
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    const parts = []
    const push = (op, t) => (parts.at(-1)?.op === op ? (parts.at(-1).text += t) : parts.push({ op, text: t }))
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) (push('same', a[i++]), j++)
      else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) push('add', b[j++])
      else push('del', a[i++])
    }
    return json(res, 200, { name, from, to, parts }), true
  }
  if (path === '/dispatch/tasks/versions/restore' && method === 'POST') {
    const prompt = fx.dispatch.prompts.find((t) => t.name === body.name)
    const versions = history[body.name]
    const wanted = versions?.find((v) => v.n === body.version)
    if (!prompt || !wanted) return json(res, 404, { error: `version ${body.version} of ${body.name} does not exist` }), true
    prompt.version += 1
    prompt.text = wanted.text
    versions.push({ n: prompt.version, text: wanted.text, at: new Date().toISOString(), restored: body.version })
    return json(res, 200, { tasks: fx.dispatch.prompts, history: { name: body.name, builtin: Boolean(prompt.builtin), current: prompt.version, versions: [...versions].sort((a, b) => b.n - a.n) } }), true
  }
  return false
}

function reviewApi(path, method, body, json, res) {
  if (path !== '/dispatch/reviews' || method !== 'POST') return false
  if (body.name === 'gone-1') return json(res, 502, { error: `${body.machine} is not reachable. Check that its Yardbell is running.` }), true
  return json(res, 200, { conversation: 'roles00000000001', step: { role: 'action', id: 'review-1', tool: 'review_session', input: { machine: body.machine, name: body.name }, status: 'approved' } }), true
}

function insightsApi(path, json, res) {
  const match = path.match(/^\/sessions\/([^/]+)\/([^/]+)\/insights$/)
  if (!match) return false
  const [machine, name] = [decodeURIComponent(match[1]), decodeURIComponent(match[2])]
  if (name === 'gone-1') return json(res, 404, { error: `Yardbell has seen no session ${name} on ${machine}` }), true
  const periods = [
    { state: 'working', from: minutes(190), to: minutes(140), seconds: 3000 },
    { state: 'waiting', from: minutes(140), to: minutes(130), seconds: 600 },
    { state: 'working', from: minutes(130), to: minutes(40), seconds: 5400 },
    { state: 'idle', from: minutes(40), to: null, seconds: 2400 }
  ]
  return json(res, 200, {
    machine,
    name,
    live: true,
    attachable: true,
    activity: 'idle',
    work: { title: 'Fix the webhook dedup bug', first_prompt: 'Find why webhooks are processed twice.', partial: false, shared: false, screen: '' },
    parts: {
      before: { asked: [], question: '', stopped_at: '', summary: 'Read the webhook handler', said: '', did: [{ tool: 'Read', what: 'Read src/webhooks.rs' }], more: 0 },
      periods: [
        { asked: ['Find why webhooks are processed twice.'], question: '', stopped_at: '', summary: 'Edited 2 files and ran the tests', said: 'The dedup key ignored the event id.', did: [{ tool: 'Edit', what: 'Edited src/webhooks.rs' }, { tool: 'Bash', what: 'Ran cargo test' }], more: 4 },
        { asked: [], question: 'Should the old events be migrated?', stopped_at: 'Permission prompt: run migration', summary: '', said: '', did: [], more: 0 },
        { asked: ['Yes, migrate them.'], question: '', stopped_at: '', summary: 'Ran the migration', said: 'Migrated 12 events.', did: [{ tool: 'Bash', what: 'Ran bin/migrate' }], more: 0 },
        { asked: [], question: '', stopped_at: '', summary: '', said: '', did: [], more: 0 }
      ]
    },
    timeline: {
      machine,
      name,
      agent: 'claude',
      folder: 'yardbell',
      branch: 'fix-webhook-dedup',
      since: minutes(200),
      started: true,
      ended: null,
      periods,
      totals: { working: 8400, waiting: 600, idle: 2400 },
      runs: [
        { at: minutes(150), kind: 'tool', text: 'cargo test' },
        { at: minutes(120), kind: 'test', text: '42 passed', ok: true },
        { at: minutes(90), kind: 'pull', text: 'Opened pull request 412', url: 'https://github.com/acme/yardbell/pull/412' }
      ],
      dropped: 0
    },
    earlier: [{ kind: 'tool', text: 'Read src/webhooks.rs' }, { kind: 'test', text: '3 failed', ok: false }],
    scrollback_error: null,
    task: 'Fix a bug: find the failing test first. Change the smallest amount of code that makes it pass.',
    conversation: 'roles00000000001',
    pull: { forge: 'github', number: 412, url: 'https://github.com/acme/yardbell/pull/412', title: 'Fix webhook dedup', state: 'open', draft: false, review: 'none', ci: 'passing' },
    suggest: `Look at session ${name} on ${machine} and suggest a better prompt for the task Fix a bug.`,
    from: { name: 'Fix a bug', version: 1, current: 2 }
  }), true
}

export function step3Fixtures(dispatch, serverName) {
  const hp = serverName === 'hp'
  const defs = hp ? definitions() : []
  Object.assign(dispatch.settings, {
    dispatch: {
      runs_on: 'claude',
      model: 'sonnet',
      codex_model: 'gpt-5',
      approval: 'prompt',
      agent: 'claude',
      instructions: hp ? 'Keep answers short. Ask before touching production.' : longInstructions(),
      rules: [
        { action: 'start_session', machine: 'hp', folder: '/home/dev/Projects/yardbell', approval: 'allow' },
        { action: 'merge_pull', machine: 'any', folder: '', approval: 'deny' },
        { action: 'remember', machine: 'any', folder: '', approval: 'prompt' }
      ]
    },
    phone: { app_connected: true, wait_minutes: 5, agent_waiting: true, session_ended: false, machines: true, memory: true, pipeline_waiting: true, pipeline_finished: true, proposals: true, dispatch: true, pull_ci_failed: true, pull_conflicts: true, pull_ready: false, pull_merged: false, pull_closed: false, limit_reset: true },
    dispatch_runs_on: ['claude', 'codex'],
    codex_models: ['gpt-5', 'gpt-5-codex'],
    agents: [{ name: 'claude', label: 'Claude Code' }, { name: 'codex', label: 'Codex' }],
    default_agent: 'claude',
    machines: [{ name: serverName, local: true }, ...(hp ? [{ name: 'nas', local: false }] : [])]
  })
  return {
    dispatch,
    changes: hp ? changeFixtures() : {},
    pipelines: { defs, runs: hp ? runs(defs) : [] },
    triggers: hp ? triggerFixtures() : [],
    memory: hp ? memoryFixtures() : fullMemory(),
    promptHistory: {
      'Fix a bug': [
        { n: 1, text: 'Find the failing test. Change code until it passes.', at: '' },
        { n: 2, text: 'Find the failing test first. Change the smallest amount of code that makes it pass.', at: minutes(2000) }
      ]
    }
  }
}

export function runsWaiting(fx) {
  return fx.pipelines.runs.filter(asksForYou).length
}

const OWNED = /^\/(machines\/[^/]+\/(changes|files|file)(\/|$)|api\/(pipelines|runs|triggers|diagrams$|settings\/phone)|dispatch\/(memory|reviews$|tasks\/(history|diff|versions\/restore))|sessions\/[^/]+\/[^/]+\/insights$)/

export async function step3Api(req, res, fx, { json }) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const method = req.method
  if (!OWNED.test(path)) return false
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req)
  if (path === '/api/settings/phone' && method === 'POST') {
    const { app_connected: _, ...saved } = fx.dispatch.settings.phone
    fx.dispatch.settings.phone = { app_connected: true, ...saved, ...body }
    return json(res, 200, { ok: true }), true
  }
  return (
    changesApi(fx, path, url, method, body, json, res) ||
    filesApi(fx, path, url, method, json, res) ||
    pipelineApi(fx, path, url, method, body, json, res) ||
    triggersApi(fx, path, method, body, json, res) ||
    memoryApi(fx, path, method, body, json, res) ||
    reviewApi(path, method, body, json, res) ||
    promptHistoryApi(fx, path, url, method, body, json, res) ||
    insightsApi(path, json, res)
  )
}
