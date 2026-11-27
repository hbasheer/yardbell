import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'

type FromApp =
  | { type: 'output'; b64: string }
  | { type: 'theme'; colors: ITheme }
  | { type: 'reset' }
  | { type: 'fontSize'; size: number }
type ToApp =
  | { type: 'input'; d: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'scroll'; lines: number }
  | { type: 'ready' }

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void }
  }
}

const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20]
const FONT_KEY = 'yardbell.term.fontSize'
const DEFAULT_FONT = 13

function storedFont(): number {
  try {
    const size = Number(localStorage.getItem(FONT_KEY))
    return FONT_SIZES.includes(size) ? size : DEFAULT_FONT
  } catch {
    return DEFAULT_FONT
  }
}

const post = (message: ToApp) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))

const term = new Terminal({
  cursorBlink: true,
  fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, Menlo, monospace',
  fontSize: storedFont(),
  lineHeight: 1.15,
  scrollback: 5000
})
const fit = new FitAddon()
term.loadAddon(fit)
const termEl = document.getElementById('term') as HTMLElement
term.open(termEl)

let sentSize = ''
function refit() {
  fit.fit()
  const size = `${term.rows}x${term.cols}`
  if (size === sentSize) return
  sentSize = size
  post({ type: 'resize', rows: term.rows, cols: term.cols })
}

function fromBase64(b64: string): Uint8Array {
  const text = atob(b64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function handle(message: FromApp) {
  if (message.type === 'output') term.write(fromBase64(message.b64))
  else if (message.type === 'theme') {
    term.options.theme = message.colors
    document.documentElement.style.background = message.colors.background ?? ''
  } else if (message.type === 'reset') term.reset()
  else if (message.type === 'fontSize') setFontSize(message.size)
}

// The app's messages reach the page on window or on document depending on the platform, and one
// message must not be written twice.
const seen = new WeakSet<Event>()
function receive(event: Event) {
  if (seen.has(event)) return
  seen.add(event)
  try {
    handle(JSON.parse((event as MessageEvent).data) as FromApp)
  } catch (error) {
    console.error('bad message from the app', error)
  }
}
window.addEventListener('message', receive)
document.addEventListener('message', receive)

term.onData((d) => post({ type: 'input', d }))
window.addEventListener('resize', refit)

let scrollQueued = 0
let scrollTimer: ReturnType<typeof setTimeout> | null = null
function scrollLines(lines: number) {
  if (!lines) return
  scrollQueued += lines
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    scrollTimer = null
    if (scrollQueued) post({ type: 'scroll', lines: scrollQueued })
    scrollQueued = 0
  }, 40)
}

function lineHeight(): number {
  const screen = term.element?.querySelector('.xterm-screen')
  return screen && term.rows ? screen.clientHeight / term.rows : 16
}

// tmux draws on the alternate screen, where xterm has no scrollback, so a swipe scrolls tmux's
// history instead.
const touch = { y: 0, t: 0, v: 0, rest: 0, glide: 0 }

function drag(px: number) {
  touch.rest += px
  const h = lineHeight()
  const lines = Math.trunc(touch.rest / h)
  if (!lines) return
  touch.rest -= lines * h
  scrollLines(-lines)
}

function touchMove(e: TouchEvent) {
  if (e.touches.length !== 1) return
  e.preventDefault()
  e.stopPropagation()
  const y = e.touches[0].clientY
  const dy = y - touch.y
  touch.v = dy / Math.max(1, e.timeStamp - touch.t)
  touch.y = y
  touch.t = e.timeStamp
  drag(dy)
}

// xterm replaces row elements as the screen redraws, and touch events keep going to the element the
// finger first landed on even once it is detached, so the listeners go on that element.
function touchEnd(e: TouchEvent) {
  const el = e.currentTarget as HTMLElement
  el.removeEventListener('touchmove', touchMove)
  el.removeEventListener('touchend', touchEnd)
  el.removeEventListener('touchcancel', touchEnd)
  if (e.timeStamp - touch.t > 80 || Math.abs(touch.v) < 0.3) return
  let v = touch.v
  let last = performance.now()
  const step = (now: number) => {
    const dt = now - last
    last = now
    drag(v * dt)
    v *= Math.pow(0.95, dt / 16)
    if (Math.abs(v) > 0.05) touch.glide = requestAnimationFrame(step)
  }
  touch.glide = requestAnimationFrame(step)
}

let pinchScale = 1

function nearestFont(px: number): number {
  return FONT_SIZES.reduce((best, size) => (Math.abs(size - px) < Math.abs(best - px) ? size : best))
}

function showPinch(origin: string) {
  const el = term.element
  if (!el) return
  el.style.transform = pinchScale !== 1 ? `scale(${pinchScale})` : ''
  el.style.transformOrigin = pinchScale !== 1 ? origin : ''
}

function setFontSize(px: number) {
  const size = nearestFont(px)
  pinchScale = 1
  showPinch('')
  if (size !== term.options.fontSize) {
    term.options.fontSize = size
    refit()
  }
  try {
    localStorage.setItem(FONT_KEY, String(size))
  } catch {}
}

function startPinch(e: TouchEvent) {
  const [a, b] = [e.touches[0], e.touches[1]]
  const gap = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
  const r = term.element?.getBoundingClientRect()
  const origin = r ? `${Math.round((a.clientX + b.clientX) / 2 - r.left)}px ${Math.round((a.clientY + b.clientY) / 2 - r.top)}px` : '0 0'
  const size = term.options.fontSize ?? DEFAULT_FONT
  const target = e.target as HTMLElement
  const move = (ev: TouchEvent) => {
    if (ev.touches.length < 2) return
    ev.preventDefault()
    ev.stopPropagation()
    const [p, q] = [ev.touches[0], ev.touches[1]]
    const scale = Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) / gap
    pinchScale = Math.min(FONT_SIZES[FONT_SIZES.length - 1] / size, Math.max(FONT_SIZES[0] / size, scale))
    showPinch(origin)
  }
  const end = (ev: TouchEvent) => {
    if (ev.touches.length >= 2) return
    target.removeEventListener('touchmove', move)
    target.removeEventListener('touchend', end)
    target.removeEventListener('touchcancel', end)
    setFontSize(size * pinchScale)
  }
  target.addEventListener('touchmove', move, { passive: false })
  target.addEventListener('touchend', end)
  target.addEventListener('touchcancel', end)
}

termEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length === 2) {
      startPinch(e)
      return
    }
    if (e.touches.length !== 1) return
    cancelAnimationFrame(touch.glide)
    Object.assign(touch, { y: e.touches[0].clientY, t: e.timeStamp, v: 0, rest: 0 })
    const target = e.target as HTMLElement
    target.addEventListener('touchmove', touchMove, { passive: false })
    target.addEventListener('touchend', touchEnd)
    target.addEventListener('touchcancel', touchEnd)
  },
  { capture: true, passive: true }
)

refit()
post({ type: 'ready' })
