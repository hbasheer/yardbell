import type { DispatchMemory, MemoryRecord } from '../serverApi'

export const ENTRY_LIMIT = 500
export const ENTRY_HELP = 'One short sentence each. Up to 500 characters.'
export const MEMORY_HELP =
  'What Dispatch has learned: where repositories live, conventions and your corrections. It reads this every turn; your instructions win when they disagree.'

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

export type CapTone = 'ok' | 'warn' | 'full'

export function capBar(memory: Pick<DispatchMemory, 'bytes' | 'max_bytes'>): { percent: number; width: number; tone: CapTone; label: string } {
  const percent = memory.max_bytes > 0 ? Math.min(100, Math.round((memory.bytes / memory.max_bytes) * 100)) : 0
  const tone: CapTone = percent >= 100 ? 'full' : percent >= 80 ? 'warn' : 'ok'
  return { percent, width: Math.max(percent, 1), tone, label: `${kb(memory.bytes)} of ${kb(memory.max_bytes)} used` }
}

export function overCap(omitted: number): string | null {
  if (omitted <= 0) return null
  return `The memory is over its size cap. Dispatch reads only the first entries that fit, and leaves out the last ${omitted === 1 ? 'one' : omitted}. Delete or shorten some.`
}

export const entryLimit = (memory: Pick<DispatchMemory, 'max_entry_chars'> | undefined) => memory?.max_entry_chars ?? ENTRY_LIMIT

const DID: Record<string, string> = { add: 'Added', replace: 'Changed', forget: 'Forgot' }

export function historyHead(record: MemoryRecord, when: string): string {
  const who = record.by === 'you' ? 'by you, here' : 'proposed by Dispatch, approved by you'
  return `${DID[record.change] ?? 'Changed'} ${when} · ${who}`
}

export const historyTitle = (count: number) => `History of changes (${count})`

export function entryProblem(entry: string, limit: number): string | null {
  const text = entry.trim()
  if (!text) return 'Write the entry first'
  if (text.length > limit) return `An entry can be at most ${limit} characters`
  return null
}

export function entryChange(old: string | null, entry: string) {
  const text = entry.trim()
  return old === null ? { change: 'add' as const, entry: text } : { change: 'replace' as const, old, entry: text }
}
