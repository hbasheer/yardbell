import { deflateSync } from 'node:zlib'

const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString()
const ROOT = '/home/dev/Projects/yardbell'
const CHAT = 'review0000000001'
const PAGE = 400
const BIG_TOTAL = 1000

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function screenshot(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const bar = y < 28
      const card = x > 24 && x < width - 24 && y > 48 && y < height - 24
      const stripe = card && (y - 48) % 36 < 6
      const at = row + 1 + x * 3
      const [r, g, b] = bar ? [60, 66, 92] : stripe ? [124, 108, 240] : card ? [245, 246, 250] : [226, 230, 240]
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const PNG = screenshot(360, 640)

const file = (path, status, added, removed, extra = {}) => ({ path, status, added, removed, binary: false, untracked: false, ...extra })

const FILES = [
  file('src/web.rs', 'M', 1000, 12),
  file('src/dedup.rs', 'A', 64, 0),
  file('src/old_seen.rs', 'D', 0, 41),
  file('src/web/runs.rs', 'R', 6, 6, { old_path: 'src/web/run_list.rs' }),
  file('tests/dedup.rs', 'A', 38, 0, { untracked: true }),
  file('assets/failure.png', 'M', null, null, { binary: true })
]

const hunk = (t) => ({ k: 'hunk', o: null, n: null, t })

function bigDiff(from) {
  const end = Math.min(from + PAGE, BIG_TOTAL)
  const lines = []
  for (let i = from; i < end; i++) {
    if (i % 80 === 0) lines.push(hunk(`@@ -${i},80 +${i},80 @@ fn handle_${i / 80}()`))
    else if (i % 9 === 3) lines.push({ k: 'del', o: i, n: null, t: `    let seen_${i} = old_check(${i});` })
    else if (i % 9 === 4) lines.push({ k: 'add', o: null, n: i, t: `    let seen_${i} = trimmed_check(${i});` })
    else lines.push({ k: 'ctx', o: i, n: i, t: `    let step_${i} = run(${i});` })
  }
  return { path: 'src/web.rs', binary: false, notes: [], lines, from, next: end, total: BIG_TOTAL, cut: false }
}

function smallDiff(f) {
  const lines =
    f.status === 'D'
      ? [hunk('@@ -1,4 +0,0 @@'), ...[1, 2, 3, 4].map((i) => ({ k: 'del', o: i, n: null, t: `removed line ${i}` }))]
      : [hunk('@@ -0,0 +1,5 @@'), ...[1, 2, 3, 4, 5].map((i) => ({ k: 'add', o: null, n: i, t: `line ${i} of ${f.path}` }))]
  return { path: f.path, binary: false, notes: [], lines, from: 0, next: lines.length, total: lines.length, cut: false }
}

const SCAN_FILES = ['src/web.rs', 'src/dedup.rs', 'tests/dedup.rs']

function scanPage(path, from) {
  const total = path === 'src/web.rs' ? 900 : 60
  const end = Math.min(from + PAGE, total)
  const lines = Array.from({ length: end - from }, (_, i) => ({ k: 'ctx', o: null, n: from + i + 1, t: `    let value_${from + i + 1} = compute(${from + i + 1}); // ${path}` }))
  return { path, binary: false, lines, from, next: end, total, cut: false }
}

const review = (fields) => ({ role: 'review', machine: 'hp', name: 'yardbell-2', at: minutes(6), ...fields })

export function reviewEvents() {
  return [
    { role: 'user', text: 'Review the branch fix-webhook-dedup and check the failure page.' },
    review({
      path: ROOT,
      of: { machine: 'hp', name: 'yardbell-2', path: ROOT, branch: 'fix-webhook-dedup', pin: { head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', top: 'a1b2c3d', changes: '' }, pull: { number: 412, forge: 'github', head: 'ffeeddccbbaa00998877665544332211ffeeddcc' } },
      base: 'main',
      read_changed: 'moved',
      verdict: 'changes needed',
      summary: 'The handler ignores repeats, but the seen set never expires and the failure page still shows the old text.',
      findings: [
        { severity: 'high', place: 'src/web.rs:88', text: 'The seen set grows without bound.' },
        { severity: 'high', place: 'src/dedup.rs:12-20', text: 'The delivery id is not trimmed before it is compared.' },
        { severity: 'medium', place: 'assets/failure.png', text: 'The failure page still shows the old error text.' },
        { severity: 'low', place: '../outside.rs:4', text: 'A place outside the folder is shown as plain text.' }
      ],
      evidence: [
        { finding: 0, name: 'before.png', file: 'before.png', width: 360, height: 640 },
        { finding: 0, name: 'after.png', file: 'after.png', width: 360, height: 640 },
        { finding: 2, name: 'failure.png', file: 'failure.png', width: 360, height: 640 },
        { finding: 2, name: 'broken.png', error: 'not a PNG image' }
      ]
    }),
    review({
      name: 'yardbell-4',
      path: ROOT,
      of: { machine: 'hp', name: 'yardbell-4', path: ROOT, scan: 'dead_code', branch: 'main', pin: { head: '0123456789abcdef0123456789abcdef01234567', top: '0123456', changes: 'x' } },
      verdict: 'issues',
      summary: 'Two helpers are never called.',
      findings: [
        { severity: 'medium', place: 'src/web.rs:41', text: 'seen_before is never called.' },
        { severity: 'low', place: 'src/dedup.rs:3', text: 'Unused import of std::fmt.' },
        { severity: 'low', place: 'tests/dedup.rs', text: 'The helper make_event has no callers.' }
      ]
    }),
    review({ name: 'yardbell-5', path: ROOT, of: { machine: 'hp', name: 'yardbell-5', path: ROOT, branch: 'main' }, verdict: 'ready', summary: 'An older review that did not note which commit it read.', findings: [] })
  ]
}

const STANDING = { 1: { standing: 'moved', now: { head: '9988776655443322110099887766554433221100' } }, 2: { standing: 'uncommitted', now: { head: '0123456789abcdef0123456789abcdef01234567' } } }

export function addReviewChat(dispatch, serverName) {
  if (serverName !== 'hp') return
  dispatch.chats.set(CHAT, { id: CHAT, title: 'Review the branch fix-webhook-dedup', updated: minutes(1), events: reviewEvents(), sessions: [], busy: false, trigger: null, backend: 'claude' })
}

export async function reviewApi(req, res, { json, cors }) {
  const url = new URL(req.url, 'http://x')
  const match = url.pathname.match(new RegExp(`^/dispatch/conversations/${CHAT}/reviews/(\\d+)/(diff|commit|files|evidence/([^/]+))$`))
  if (!match || req.method !== 'GET') return false
  const card = Number(match[1])
  const kind = match[2].split('/')[0]
  const q = url.searchParams
  const from = Number(q.get('from') || 0)
  const name = q.get('file')
  if (kind === 'evidence') {
    res.writeHead(200, { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' })
    res.end(PNG)
    return true
  }
  if (kind === 'commit') {
    const standing = STANDING[card]
    if (!standing) return json(res, 404, { error: 'this review does not say which commit it read' }), true
    return json(res, 200, standing), true
  }
  if (kind === 'diff') {
    if (card !== 1) return json(res, 404, { error: 'this review does not say which folder it read' }), true
    if (!name) return json(res, 200, { base: 'main', merge_base: 'abcdef0123456789', head: '9988776655443322110099887766554433221100', files: FILES, truncated: false, reviewed_head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', moved: true }), true
    const f = FILES.find((x) => x.path === name)
    if (!f) return json(res, 404, { error: `${name} is not in this review's changes` }), true
    if (f.binary) return json(res, 200, { path: name, binary: true, notes: ['Binary files differ'], lines: [], from: 0, next: 0, total: 0, cut: false }), true
    return json(res, 200, name === 'src/web.rs' ? bigDiff(from) : smallDiff(f)), true
  }
  if (card !== 2) return json(res, 404, { error: 'no such scan' }), true
  if (!name) return json(res, 200, { folder: ROOT, files: SCAN_FILES }), true
  if (!SCAN_FILES.includes(name)) return json(res, 404, { error: `no finding points at ${name}` }), true
  return json(res, 200, scanPage(name, from)), true
}
