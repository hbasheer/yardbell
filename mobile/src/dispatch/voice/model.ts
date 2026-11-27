import type { DispatchEvent } from '../types'

export type MicMode = 'hold' | 'auto' | 'toggle'

export const HOLD_MS = 600
export const MAX_RECORDING_MS = 5 * 60 * 1000
export const RECORDING_MIME = 'audio/mp4'

const SPOKEN_CHARS = 500
const UTTERANCE_CHARS = 200

export const VOICE_OFF_TITLE = 'Set up voice'
export const VOICE_OFF_TEXT = "Voice input is off. It is set up on the computer, in Yardbell's Settings under Voice. Once it is on, the mic works here."
export const MIC_DENIED_TITLE = 'The microphone is off'
export const MIC_DENIED_TEXT = 'Yardbell needs the microphone to take dictation. Allow it in the phone settings, then try again.'
export const NOTHING_HEARD = 'No words were heard. Try again a little closer to the phone.'

export function micMode(voiceMode: string | undefined): MicMode {
  return voiceMode === 'hold' || voiceMode === 'toggle' ? voiceMode : 'auto'
}

export function micHint(mode: MicMode): string {
  return mode === 'hold' ? 'Hold to dictate' : 'Start dictation'
}

export type Release = { mode: MicMode; stopping: boolean; starting: boolean; heldMs: number }

export function onRelease({ mode, stopping, starting, heldMs }: Release): 'stop' | 'stop-after-start' | 'keep' {
  if (starting && mode !== 'toggle' && (mode === 'hold' || heldMs >= HOLD_MS)) return 'stop-after-start'
  if (stopping || mode === 'hold' || (mode === 'auto' && heldMs >= HOLD_MS)) return 'stop'
  return 'keep'
}

export function insertAtCursor(text: string, selection: { start: number; end: number }, piece: string): { text: string; cursor: number } {
  const said = piece.trim()
  if (!said) return { text, cursor: selection.end }
  const start = Math.min(selection.start, selection.end, text.length)
  const end = Math.min(Math.max(selection.start, selection.end), text.length)
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const tail = after && !/^\s/.test(after) ? ' ' : ''
  const inserted = `${lead}${said}${tail}`
  return { text: `${before}${inserted}${after}`, cursor: before.length + lead.length + said.length + tail.length }
}

export function spokenText(markdown: string): string {
  let text = markdown
  let blocks = 0
  text = text.replace(/```[\s\S]*?(```|$)/g, () => {
    blocks++
    return ' '
  })
  const lines: string[] = []
  let tables = 0
  let inTable = false
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('|')) {
      if (!inTable) tables++
      inTable = true
      continue
    }
    inTable = false
    lines.push(line.replace(/^#{1,4}\s+/, '').replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))
  }
  text = lines
    .join('\n')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const named = [blocks ? (blocks === 1 ? 'a code block' : `${blocks} code blocks`) : '', tables ? (tables === 1 ? 'a table' : `${tables} tables`) : ''].filter(Boolean)
  if (named.length) text = `${text} The reply also holds ${named.join(' and ')}.`.trim()
  if (text.length > SPOKEN_CHARS) text = `${text.slice(0, SPOKEN_CHARS).replace(/\s+\S*$/, '')}, and more.`
  return text
}

export function speechPieces(text: string): string[] {
  const out: string[] = []
  let piece = ''
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const next = piece ? `${piece} ${word}` : word
    if (next.length > UTTERANCE_CHARS && piece) {
      out.push(piece)
      piece = word
    } else {
      piece = next
    }
  }
  if (piece) out.push(piece)
  return out
}

export function speechFor(event: DispatchEvent): string | null {
  if (event.role === 'assistant') return spokenText(event.text ?? '') || null
  if (event.role === 'error') return `Dispatch hit an error. ${event.text}`
  if (event.role === 'session' && event.state === 'blocked') return `Session ${event.name} on ${event.machine} is waiting for an answer.`
  return null
}

export function eventKey(event: DispatchEvent, index: number): string {
  const id = (event as { id?: string }).id
  if (id) return `${event.role}:${id}`
  const said = 'text' in event ? event.text : event.role === 'session' ? `${event.machine}/${event.name}/${event.state}` : ''
  return `${event.role}:${said}:${index}`
}

export const keysOf = (events: readonly DispatchEvent[]): Set<string> => new Set(events.map(eventKey))

export function takeNew(events: readonly DispatchEvent[], seen: ReadonlySet<string>): { say: string[]; seen: Set<string> } {
  const next = new Set(seen)
  const say: string[] = []
  events.forEach((event, index) => {
    const key = eventKey(event, index)
    if (next.has(key)) return
    next.add(key)
    const text = speechFor(event)
    if (text) say.push(text)
  })
  return { say, seen: next }
}

export const MIN_RECORDING_MS = 300
export const tooShort = (startedAt: number, now: number): boolean => now - startedAt < MIN_RECORDING_MS

export const parseSpeak = (raw: string | null): boolean => raw === '1'
