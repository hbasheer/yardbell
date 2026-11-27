// Option --click "<visible text>" (repeatable, applied in order, 1.2 s wait after each) taps the smallest element whose text is exactly that, before the screenshot.
// Prefix the value with "label:" to match an accessibility label instead of text, with "hold:" to press and hold (long-press) the text, or with "type:" to type the rest into the focused field.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [url, out, ...rest] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node scripts/preview-shot.mjs <url> <out.png> [--width 400] [--height 860] [--wait 4000] [--light]')
  process.exit(2)
}
const option = (name, fallback) => {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? fallback : Number(rest[at + 1])
}
const width = option('width', 400)
const height = option('height', 860)
const wait = option('wait', 4000)
const clicks = rest.flatMap((arg, at) => (arg === '--click' ? [rest[at + 1]] : []))
const port = 9300 + Math.floor(Math.random() * 500)

const profile = mkdtempSync(join(tmpdir(), 'yardbell-shot-'))
writeFileSync(join(profile, 'user.js'), `user_pref("ui.systemUsesDarkTheme", ${rest.includes('--light') ? 0 : 1});\n`)

const firefox = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port), `--window-size=${width},${height}`], {
  stdio: 'ignore',
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`)
      await new Promise((resolve, reject) => {
        socket.onopen = resolve
        socket.onerror = reject
      })
      return socket
    } catch {
      await sleep(500)
    }
  }
  throw new Error('Firefox did not open its debugging port')
}

try {
  const socket = await connect()
  let nextId = 1
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
  }
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.message}`)) : resolve(message.result)))
      socket.send(JSON.stringify({ id, method, params }))
    })

  await call('session.new', { capabilities: {} })
  const { context } = await call('browsingContext.create', { type: 'tab' })
  await call('browsingContext.setViewport', { context, viewport: { width, height } })
  await call('browsingContext.navigate', { context, url, wait: 'complete' })
  await sleep(wait)
  for (const target of clicks) {
    if (target.startsWith('type:')) {
      const keys = [...target.slice(5)].flatMap((value) => [
        { type: 'keyDown', value },
        { type: 'keyUp', value }
      ])
      await call('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard', actions: keys }] })
      await sleep(1200)
      continue
    }
    const byLabel = target.startsWith('label:')
    const hold = target.startsWith('hold:')
    const text = byLabel ? target.slice(6) : hold ? target.slice(5) : target
    const found = await call('script.evaluate', {
      expression: `(() => {
        const want = ${JSON.stringify(text)}
        let best = null
        for (const el of document.querySelectorAll('body *')) {
          const have = ${byLabel} ? el.getAttribute('aria-label') || '' : (el.textContent || '').trim()
          if (have !== want) continue
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          if (!best || r.width * r.height <= best.w * best.h) best = { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
        }
        return best ? JSON.stringify(best) : ''
      })()`,
      target: { context },
      awaitPromise: false
    })
    const where = found.result?.value ? JSON.parse(found.result.value) : null
    if (!where) throw new Error(`--click: nothing shows the text "${text}"`)
    await call('input.performActions', {
      context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(where.x), y: Math.round(where.y) },
            { type: 'pointerDown', button: 0 },
            ...(hold ? [{ type: 'pause', duration: 700 }] : []),
            { type: 'pointerUp', button: 0 }
          ]
        }
      ]
    })
    await sleep(1200)
  }
  const { data } = await call('browsingContext.captureScreenshot', { context })
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`wrote ${out}`)
  socket.close()
} finally {
  firefox.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
}
