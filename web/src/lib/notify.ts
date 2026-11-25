// Desktop notifications follow Orca's (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useRef } from 'react'
import type { YardbellState } from './state'
import { keyOf, statusOf, type Status } from './tree'

export type NotifyPrefs = {
  enabled: boolean
  taskComplete: boolean
  needsInput: boolean
  sound: 'chime' | 'ping' | 'none'
  volume: number
  suppressWhenFocused: boolean
  muted: string[]
}
const KEY = 'yardbell.notify'
const DEFAULTS: NotifyPrefs = { enabled: false, taskComplete: true, needsInput: true, sound: 'chime', volume: 0.6, suppressWhenFocused: true, muted: [] }

export function notifyPrefs(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return DEFAULTS
  }
}
export function setNotifyPrefs(change: Partial<NotifyPrefs>) {
  localStorage.setItem(KEY, JSON.stringify({ ...notifyPrefs(), ...change }))
}

export const canNotify = () => 'Notification' in window && window.isSecureContext

const TONES: Record<string, [number, number][]> = {
  chime: [
    [880, 0],
    [1320, 0.12]
  ],
  ping: [[1046, 0]]
}

export function playSound(sound = notifyPrefs().sound, volume = notifyPrefs().volume) {
  const tones = TONES[sound]
  if (!tones || volume <= 0) return
  try {
    const ctx = new AudioContext()
    for (const [freq, at] of tones) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = ctx.currentTime + at
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.25 * volume, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.5)
    }
    setTimeout(() => ctx.close(), 1200)
  } catch {}
}

export function show(title: string, body: string, onClick?: () => void, tag?: string) {
  playSound()
  if (!canNotify() || Notification.permission !== 'granted') return false
  const n = new Notification(title, { body, tag, icon: '/favicon.svg' })
  n.onclick = () => {
    window.focus()
    onClick?.()
    n.close()
  }
  return true
}

// A session's change is told once: needing you, or finishing work and going idle. The first state
// seen after the page loads is only remembered, so opening Yardbell says nothing.
export function useDesktopNotifications(state: YardbellState | null, onOpen: (key: string) => void) {
  const seen = useRef<Map<string, Status> | null>(null)
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    if (!state) return
    const now = new Map<string, Status>()
    for (const s of state.sessions) if (s.tmux && !s.stale) now.set(keyOf(s), statusOf(s))
    const before = seen.current
    seen.current = now
    if (!before) return
    const p = notifyPrefs()
    if (!p.enabled) return
    if (p.suppressWhenFocused && document.hasFocus()) return
    for (const s of state.sessions) {
      if (!s.tmux || s.stale || p.muted.includes(s.machine)) continue
      const key = keyOf(s)
      const was = before.get(key)
      const is = now.get(key)
      if (!was || was === is) continue
      const agent = state.agents.find((a) => a.name === s.agent)?.label || s.agent
      const where = `${s.folder || s.tmux} on ${s.machine}`
      if (is === 'blocked' && p.needsInput) show(`${agent} needs you`, `${where} asks for permission or has a question.`, () => open.current(key), key)
      else if (was === 'working' && is === 'idle' && p.taskComplete) show(`${agent} finished`, `${where} is done and idle.`, () => open.current(key), key)
    }
  }, [state])
}
