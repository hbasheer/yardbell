import type { DispatchEvent, ToolResultEvent } from './types'

export type Chip = { name: string; input: unknown; result: ToolResultEvent | null }

export type Block =
  | { kind: 'tools'; key: number; chips: Chip[] }
  | { kind: 'event'; key: number; event: DispatchEvent }

export const TOOL_LABELS: Record<string, string> = {
  list_machines: 'Checked machines',
  list_sessions: 'Checked sessions',
  list_folders: 'Looked for the repository',
  read_session: 'Read a session'
}

export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name

// Tool calls in a row share one run, and each result lands on the first chip of its name still
// waiting for one. `key` is the index in the stored event list, which is what answers, reviews
// and pulls post, so the list must never be filtered before this.
export function blocks(list: DispatchEvent[]): Block[] {
  const out: Block[] = []
  const waiting: Chip[] = []
  let run: Extract<Block, { kind: 'tools' }> | null = null
  list.forEach((event, key) => {
    if (event.role === 'tool' || event.role === 'tool_result') {
      let chip = event.role === 'tool_result' ? waiting.find((c) => c.name === event.name && !c.result) : undefined
      if (!chip) {
        if (!run) {
          run = { kind: 'tools', key, chips: [] }
          out.push(run)
        }
        chip = { name: event.name, input: event.role === 'tool' ? event.input : null, result: null }
        run.chips.push(chip)
        waiting.push(chip)
      }
      if (event.role === 'tool_result') chip.result = event
      return
    }
    run = null
    if (event.role === 'action' && event.group) return
    out.push({ kind: 'event', key, event })
  })
  return out
}

export function runState(chips: Chip[], running: boolean): 'running' | 'error' | 'ok' {
  if (chips.some((chip) => chip.result?.is_error)) return 'error'
  if (running && chips.some((chip) => !chip.result)) return 'running'
  return 'ok'
}

export function chipState(chip: Chip, running: boolean): 'running' | 'error' | 'ok' | 'idle' {
  if (chip.result) return chip.result.is_error ? 'error' : 'ok'
  return running ? 'running' : 'idle'
}

export function runTitle(chips: Chip[]): string {
  const seen: string[] = []
  for (const chip of chips) {
    const label = toolLabel(chip.name)
    if (!seen.includes(label)) seen.push(label)
  }
  if (seen.length === 0) return ''
  const [first, ...rest] = seen
  return [first, ...rest.map((label) => label.charAt(0).toLowerCase() + label.slice(1))].join(', ')
}

export function stepsOf(events: DispatchEvent[]): Map<string, Extract<DispatchEvent, { role: 'action' }>> {
  const out = new Map<string, Extract<DispatchEvent, { role: 'action' }>>()
  for (const event of events) if (event.role === 'action') out.set(event.id, event)
  return out
}
