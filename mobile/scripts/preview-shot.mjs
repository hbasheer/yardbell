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
  const { data } = await call('browsingContext.captureScreenshot', { context })
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`wrote ${out}`)
  socket.close()
} finally {
  firefox.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
}
