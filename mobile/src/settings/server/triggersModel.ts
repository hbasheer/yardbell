import type { TriggerRun, TriggerState } from '../serverApi'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/

function wall(stamp?: string | null) {
  const m = WALL.exec(stamp || '')
  return m ? { date: m[1], time: m[2] } : null
}

export function when(stamp: string | null | undefined, now: string | undefined): string {
  const at = wall(stamp)
  const today = wall(now)
  if (!at || !today) return ''
  const days = Math.round((Date.parse(at.date) - Date.parse(today.date)) / 86400000)
  if (days === 0) return `${at.time} today`
  if (days === 1) return `${at.time} tomorrow`
  if (days === -1) return `${at.time} yesterday`
  const d = new Date(`${at.date}T12:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${at.time}`
}

export const sentence = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

export const isSchedule = (t: TriggerState) => t.kind === 'schedule'

export function planWord(t: TriggerState, now: string | undefined): string {
  if (!t.trigger.enabled) return 'Off'
  if (t.busy) return 'Running now'
  if (isSchedule(t) && t.next) return `Next ${when(t.next, now)}`
  if (!isSchedule(t) && t.checked) return `Checked ${when(t.checked, now)}`
  return ''
}

export function lastWord(t: TriggerState, now: string | undefined): { text: string; failed: boolean } | null {
  const last = t.last
  if (!last) return null
  const prefix = last.outcome === 'watching' ? '' : 'Last run '
  return { text: `${prefix}${when(last.at, now)}: ${last.text}.`, failed: last.outcome === 'failed' }
}

export const runLabel = (t: TriggerState) => (isSchedule(t) ? 'Run now' : 'Check now')

export const canRun = (t: TriggerState, busy: boolean) => !busy && (isSchedule(t) || t.trigger.enabled)

export function runConfirm(t: TriggerState): { title: string; message: string; confirm: string } {
  return isSchedule(t)
    ? {
        title: `Run ${t.trigger.name} now?`,
        message: `This starts a Dispatch conversation from the saved prompt ${t.trigger.task}. Its steps follow your Dispatch rules.`,
        confirm: 'Run now'
      }
    : {
        title: `Check ${t.trigger.name} now?`,
        message: `This looks for tickets that match now and starts a Dispatch conversation from the saved prompt ${t.trigger.task} for each.`,
        confirm: 'Check now'
      }
}

export function runResult(name: string, out: TriggerRun): { conversation: string | null; text: string } {
  if (out.conversation) return { conversation: out.conversation, text: `${name} started a conversation in Dispatch.` }
  return { conversation: null, text: out.text ? `${sentence(out.text)}.` : `${name} ran.` }
}

export const problemWord = (problem: string) => `${sentence(problem)}.`
